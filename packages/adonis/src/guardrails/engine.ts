import { detectKeywords, detectRegex } from './detectors/custom.js';
import { scoreInjection } from './detectors/injection.js';
import { detectPii } from './detectors/pii.js';
import { detectSecrets } from './detectors/secrets.js';
import { scoreToolText } from './detectors/tool-poisoning.js';
import { matchesAny } from './glob.js';
import {
  ACTION_SEVERITY,
  type DetectorSpec,
  type Finding,
  type GuardContext,
  type GuardrailAction,
  type GuardrailRule,
  type GuardrailStage,
  type Segment,
} from './types.js';
import { labelFor, Vault } from './vault.js';

/**
 * One reported hit. `values` holds the distinct matched values so a caller can fingerprint them
 * (a keyed hash correlates repeats without storing the value) — never persist them as they are.
 */
export interface GuardHit {
  ruleId: string;
  ruleName: string;
  action: GuardrailAction;
  detector: string;
  category: string;
  score: number;
  count: number;
  /** Distinct values found (at most 20). In-memory only. */
  values: string[];
  /** Found in the newest turn (false: only in re-sent history, already reported once). */
  fresh: boolean;
  /** `detector_error` hits: what failed, and what the rule's fail mode made of it. */
  error?: string;
  failMode?: 'open' | 'closed';
}

export interface ScanResult {
  stage: GuardrailStage;
  /** Most severe action among the rules that fired. */
  action: GuardrailAction;
  /** The rule that decided a block / approval, and the message for the person. */
  decisive?: { id: string; name: string; message: string };
  /** Segment texts after redaction (same order as the input). */
  segments: string[];
  /** Whether any segment changed. */
  changed: boolean;
  hits: GuardHit[];
  vault: Vault;
  /** Redacted spans. */
  redactions: number;
  latencyMs: number;
}

export interface ScanOptions {
  /** Per-stage refusal messages, for rules that set none. */
  messages?: Partial<Record<GuardrailStage, string>>;
  /** Refusal message for `approve`, for rules that set none. */
  approvalMessage?: string;
  /**
   * Stages whose redactions are reversible (unless the rule sets `restore: false`). Default
   * `['llm_request']`: what the caller sent is theirs to get back; what a tool or the model produced
   * is removed one-way. A caller whose tool results are its own data may add `tool_result`.
   */
  restorableStages?: readonly GuardrailStage[];
}

export const DEFAULT_MESSAGES: Record<GuardrailStage, string> = {
  llm_request: "This message was blocked by your organization's AI guardrails.",
  llm_response: "The answer was withheld by your organization's AI guardrails.",
  tool_args: "This tool call was blocked by your organization's AI guardrails.",
  tool_result: "The tool's result was withheld by your organization's AI guardrails.",
  tool_description: "This tool was quarantined by your organization's AI guardrails.",
};

export const DEFAULT_APPROVAL_MESSAGE =
  "This needs approval under your organization's AI guardrails before it can go ahead.";

/** What replaces an instruction-like finding: it is removed, not tokenized. */
export const INJECTION_REPLACEMENT = '[removed: suspected prompt injection]';

const ruleName = <C extends GuardContext>(rule: GuardrailRule<C>) => rule.name ?? rule.id;

/** Whether a rule's scope covers the context (stage, tool, `when`). Segments are filtered apart. */
export function ruleApplies<C extends GuardContext>(rule: GuardrailRule<C>, ctx: C): boolean {
  if (rule.enabled === false || !rule.stages.includes(ctx.stage)) return false;
  const tools = rule.match?.tools;
  if (tools?.length) {
    const toolStage =
      ctx.stage === 'tool_args' || ctx.stage === 'tool_result' || ctx.stage === 'tool_description';
    if (!toolStage || !matchesAny(ctx.tool ?? '', tools)) return false;
  }
  return rule.when === undefined || rule.when(ctx);
}

export function orderRules<C extends GuardContext>(
  rules: readonly GuardrailRule<C>[],
): GuardrailRule<C>[] {
  return [...rules].sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100) || ruleName(a).localeCompare(ruleName(b)),
  );
}

/** Runs one detector on one text. A custom detector's throw is the rule's fail mode to decide. */
export async function runDetector<C extends GuardContext>(
  spec: DetectorSpec<C>,
  text: string,
  ctx: C,
): Promise<Finding[]> {
  if (!text) return [];
  switch (spec.kind) {
    case 'pii':
      return detectPii(text, spec.types?.length ? spec.types : undefined);
    case 'secrets':
      return detectSecrets(text, spec.types?.length ? spec.types : undefined);
    case 'injection':
      return scoreInjection(text, spec.threshold ?? 0.5).findings;
    case 'tool_poisoning':
      return scoreToolText(text, spec.threshold ?? 0.5).findings;
    case 'regex':
      return detectRegex(text, spec.patterns, spec.label ?? 'custom');
    case 'keywords':
      return detectKeywords(text, spec.words, spec.label ?? 'keywords');
    case 'custom':
      return spec.detect(text, ctx);
  }
}

/**
 * The in-process detectors of a rule set, as one span locator — what a stream window must never
 * cut through (see `StreamGuard`'s `locate`). Custom detectors are left out: they may be remote.
 */
export function spanLocator<C extends GuardContext>(
  rules: readonly GuardrailRule<C>[],
): ((text: string) => Finding[]) | undefined {
  const specs = rules
    .flatMap((r) => r.detectors)
    .filter((d) => d.kind !== 'custom' && d.kind !== 'tool_poisoning');
  if (specs.length === 0) return undefined;
  return (text) =>
    specs.flatMap((d) => {
      switch (d.kind) {
        case 'pii':
          return detectPii(text, d.types?.length ? d.types : undefined);
        case 'secrets':
          return detectSecrets(text, d.types?.length ? d.types : undefined);
        case 'regex':
          return detectRegex(text, d.patterns);
        case 'keywords':
          return detectKeywords(text, d.words);
        case 'injection':
          return scoreInjection(text, 0).findings;
        default:
          return [];
      }
    });
}

/**
 * Non-overlapping spans. Overlapping findings are merged into their union (nothing that any
 * detector found is left uncovered), labelled by the longer finding (ties: the higher score) —
 * an injected HTML comment that contains an email address is removed as a whole. With `text`, a
 * merged span's value is re-read from it.
 */
export function resolveOverlaps(findings: readonly Finding[], text?: string): Finding[] {
  const sorted = [...findings]
    .filter((f) => f.spanned !== false && f.end > f.start)
    .sort((a, b) => a.start - b.start || b.end - a.end || b.score - a.score);
  const out: Finding[] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (!last || f.start >= last.end) {
      out.push({ ...f });
      continue;
    }
    const longer =
      f.end - f.start > last.end - last.start ||
      (f.end - f.start === last.end - last.start && f.score > last.score)
        ? f
        : last;
    const merged: Finding = { ...longer, start: last.start, end: Math.max(last.end, f.end) };
    if (text !== undefined) merged.value = text.slice(merged.start, merged.end);
    out[out.length - 1] = merged;
  }
  return out;
}

/** Placeholder text for a finding. Instruction-like findings are removed, not tokenized. */
function replacementFor(f: Finding, vault: Vault, restorable: boolean): string {
  if (f.replacement !== undefined) return f.replacement;
  if (f.detector === 'injection' || f.detector === 'tool_poisoning') return INJECTION_REPLACEMENT;
  return vault.tokenFor(labelFor(f.category), f.value, restorable);
}

export function applyRedactions(
  text: string,
  findings: readonly Finding[],
  vault: Vault,
  restorable: boolean,
): { text: string; count: number } {
  const whole = findings.find((f) => f.spanned === false);
  if (whole) {
    return { text: whole.replacement ?? `[removed: ${whole.category}]`, count: 1 };
  }
  const spans = resolveOverlaps(findings, text);
  if (spans.length === 0) return { text, count: 0 };
  let out = '';
  let at = 0;
  for (const f of spans) {
    out += text.slice(at, f.start) + replacementFor(f, vault, restorable);
    at = f.end;
  }
  return { text: out + text.slice(at), count: spans.length };
}

interface RuleOutcome<C extends GuardContext> {
  rule: GuardrailRule<C>;
  /** Findings per segment index. */
  bySegment: Map<number, Finding[]>;
  failed?: string;
}

function memoKey<C extends GuardContext>(spec: DetectorSpec<C>): string {
  return spec.kind === 'custom' ? `custom\u0000${spec.name}` : JSON.stringify(spec);
}

/**
 * Evaluates the rules for one stage over a set of segments. Rules run by ascending priority; an
 * `allow` rule that fires stops evaluation; otherwise every firing rule contributes and the most
 * severe action wins (block > approve > redact > log). Detector results are shared between rules.
 *
 * Blocking applies to the NEWEST turn: content found only in re-sent history (`fresh: false`) was
 * already refused once, so it is removed one-way instead — the conversation can go on and the value
 * still never reaches the model.
 */
export async function scan<C extends GuardContext>(
  rules: readonly GuardrailRule<C>[],
  ctx: C,
  segments: readonly Segment[],
  vault: Vault = new Vault(),
  options: ScanOptions = {},
): Promise<ScanResult> {
  const started = performance.now();
  const applicable = orderRules(rules).filter((r) => ruleApplies(r, ctx));
  const result: ScanResult = {
    stage: ctx.stage,
    action: 'allow',
    segments: segments.map((s) => s.text),
    changed: false,
    hits: [],
    vault,
    redactions: 0,
    latencyMs: 0,
  };
  if (applicable.length === 0 || segments.length === 0) {
    result.latencyMs = performance.now() - started;
    return result;
  }
  const stageMessage = options.messages?.[ctx.stage] ?? DEFAULT_MESSAGES[ctx.stage];
  const restorableStage = (options.restorableStages ?? ['llm_request']).includes(ctx.stage);

  const memo = new Map<string, Promise<Finding[]>>();
  const detect = (spec: DetectorSpec<C>, index: number) => {
    const key = `${index}\u0000${memoKey(spec)}`;
    let p = memo.get(key);
    if (!p) {
      // Wrapped so a synchronous throw becomes a rejection the fail mode can decide on.
      p = Promise.resolve().then(() => runDetector(spec, segments[index]?.text ?? '', ctx));
      memo.set(key, p);
    }
    return p;
  };

  const outcomes: RuleOutcome<C>[] = [];
  for (const rule of applicable) {
    const sources = rule.match?.sources;
    const indexes = segments
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !sources?.length || !s.source || sources.includes(s.source))
      .map(({ i }) => i);
    const outcome: RuleOutcome<C> = { rule, bySegment: new Map() };
    if (rule.detectors.length === 0) {
      // Scope-only rule: fires for everything in scope (an exemption, or a blanket block/approval).
      if (rule.action === 'allow' || rule.action === 'block' || rule.action === 'approve')
        outcomes.push(outcome);
      if (rule.action === 'allow') break;
      continue;
    }
    const jobs = rule.detectors.flatMap((spec) =>
      indexes.map(async (i) => ({ i, found: await detect(spec, i) })),
    );
    const settled = await Promise.allSettled(jobs);
    for (const s of settled) {
      if (s.status === 'rejected') {
        outcome.failed = (s.reason as Error)?.message ?? String(s.reason);
        continue;
      }
      if (s.value.found.length === 0) continue;
      const list = outcome.bySegment.get(s.value.i) ?? [];
      list.push(...s.value.found);
      outcome.bySegment.set(s.value.i, list);
    }
    if (outcome.bySegment.size === 0 && !outcome.failed) continue;
    outcomes.push(outcome);
    if (rule.action === 'allow' && outcome.bySegment.size > 0) break;
  }

  // Combine: most severe action; redactions of every redact rule.
  const redactBySegment = new Map<number, { findings: Finding[]; restorable: boolean }>();
  for (const o of outcomes) {
    const { rule } = o;
    const name = ruleName(rule);
    const failMode = rule.options?.failMode ?? 'open';
    let action: GuardrailAction = rule.action;
    if (o.failed) {
      result.hits.push({
        ruleId: rule.id,
        ruleName: name,
        action: failMode === 'closed' ? 'block' : 'log',
        detector: 'detector_error',
        category: 'error.detector_unavailable',
        score: 0,
        count: 1,
        values: [],
        fresh: true,
        error: o.failed.slice(0, 300),
        failMode,
      });
      if (failMode === 'closed' && o.bySegment.size === 0) action = 'block';
      else if (o.bySegment.size === 0) continue;
    }
    const historyOnly =
      (action === 'block' || action === 'approve') &&
      o.bySegment.size > 0 &&
      [...o.bySegment.keys()].every((i) => segments[i]?.fresh === false);
    if (historyOnly) {
      action = 'redact';
      for (const [i, findings] of o.bySegment) {
        const entry = redactBySegment.get(i) ?? { findings: [], restorable: false };
        entry.findings.push(...findings);
        redactBySegment.set(i, entry);
      }
    }
    if (ACTION_SEVERITY[action] > ACTION_SEVERITY[result.action]) {
      result.action = action;
      if (action === 'block' || action === 'approve') {
        result.decisive = {
          id: rule.id,
          name,
          message:
            rule.options?.message ||
            (o.failed && o.bySegment.size === 0
              ? `${stageMessage} (a required check could not run)`
              : action === 'approve'
                ? (options.approvalMessage ?? DEFAULT_APPROVAL_MESSAGE)
                : stageMessage),
        };
      }
    }
    if (o.bySegment.size === 0 && rule.detectors.length === 0) {
      result.hits.push({
        ruleId: rule.id,
        ruleName: name,
        action,
        detector: 'scope',
        category: 'scope.match',
        score: 1,
        count: 1,
        values: [],
        fresh: true,
      });
      continue;
    }
    // Hits: one per category per rule, with distinct values and whether any occurrence is fresh.
    const grouped = new Map<string, GuardHit>();
    for (const [i, findings] of o.bySegment) {
      for (const f of findings) {
        const hit = grouped.get(f.category) ?? {
          ruleId: rule.id,
          ruleName: name,
          action,
          detector: f.detector,
          category: f.category,
          score: 0,
          count: 0,
          values: [],
          fresh: false,
        };
        hit.count++;
        hit.score = Math.max(hit.score, f.score);
        if (f.value && !hit.values.includes(f.value) && hit.values.length < 20)
          hit.values.push(f.value);
        if (segments[i]?.fresh !== false) hit.fresh = true;
        grouped.set(f.category, hit);
      }
      if (action === 'redact' && !historyOnly) {
        const entry = redactBySegment.get(i) ?? { findings: [], restorable: false };
        entry.findings.push(...findings);
        entry.restorable ||= restorableStage && rule.options?.restore !== false;
        redactBySegment.set(i, entry);
      }
    }
    result.hits.push(...grouped.values());
  }

  if (result.action !== 'block' && result.action !== 'approve') {
    for (const [i, { findings, restorable }] of redactBySegment) {
      const original = segments[i]?.text ?? '';
      const { text, count } = applyRedactions(original, findings, vault, restorable);
      if (count > 0 && text !== original) {
        result.segments[i] = text;
        result.redactions += count;
        result.changed = true;
      }
    }
  }
  result.latencyMs = performance.now() - started;
  return result;
}
