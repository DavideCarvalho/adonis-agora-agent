/**
 * Guardrails: detectors that look at text on its way to or from a model — prompts, answers, tool
 * arguments, tool results, tool descriptions — and rules that decide what to do when they fire.
 *
 * Nothing in this module depends on the agent loop, on NestJS or on a runtime API beyond the
 * language itself. A process that proxies raw provider traffic uses the detectors, `scan`, `Vault`
 * and `StreamGuard` directly; `createGuardrails` is the adapter onto the loop's processor seams.
 */

/** Where in the traffic a rule applies. */
export type GuardrailStage =
  /** Prompt + attached context sent to a model (system, user, assistant history). */
  | 'llm_request'
  /** What the model answered (text and tool-call arguments), streaming included. */
  | 'llm_response'
  /** Arguments of a tool call, before the tool runs. */
  | 'tool_args'
  /** What a tool returned, before it flows back into the model (indirect prompt injection). */
  | 'tool_result'
  /** Tool descriptions and schemas of a remote tool server (tool poisoning). */
  | 'tool_description';

export const GUARDRAIL_STAGES: readonly GuardrailStage[] = [
  'llm_request',
  'llm_response',
  'tool_args',
  'tool_result',
  'tool_description',
];

/**
 * - `allow`: exemption. When it matches (its detectors fire, or it has none), later rules are skipped.
 * - `log`: record the hit only (a "flag").
 * - `redact`: replace what was found by placeholders (reversible for values sent to a model).
 * - `approve`: human-in-the-loop — refuse until someone approves this exact content. A caller that
 *   has no approval flow of its own treats it as `block`.
 * - `block`: refuse with the rule's user-facing message.
 */
export type GuardrailAction = 'allow' | 'log' | 'redact' | 'approve' | 'block';

/** Severity order used to combine several rules: the most severe wins. */
export const ACTION_SEVERITY: Record<GuardrailAction, number> = {
  allow: 0,
  log: 1,
  redact: 2,
  approve: 3,
  block: 4,
};

export type PiiType =
  | 'email'
  | 'phone'
  | 'cpf'
  | 'cnpj'
  | 'ssn'
  | 'credit_card'
  | 'iban'
  | 'ip_address';

export const PII_TYPES: readonly PiiType[] = [
  'email',
  'phone',
  'cpf',
  'cnpj',
  'ssn',
  'credit_card',
  'iban',
  'ip_address',
];

export type SecretType =
  | 'openai_key'
  | 'anthropic_key'
  | 'aws_access_key'
  | 'aws_secret_key'
  | 'github_token'
  | 'gitlab_token'
  | 'slack_token'
  | 'google_api_key'
  | 'stripe_key'
  | 'jwt'
  | 'bearer_token'
  | 'private_key'
  | 'generic_secret';

export const SECRET_TYPES: readonly SecretType[] = [
  'openai_key',
  'anthropic_key',
  'aws_access_key',
  'aws_secret_key',
  'github_token',
  'gitlab_token',
  'slack_token',
  'google_api_key',
  'stripe_key',
  'jwt',
  'bearer_token',
  'private_key',
  'generic_secret',
];

/** Something a detector found. `value` is the matched text; keep it in-process. */
export interface Finding {
  /** The detector kind (or a custom detector's name). */
  detector: string;
  /** e.g. `pii.credit_card`, `secret.aws_access_key`, `injection.ignore_previous`. */
  category: string;
  start: number;
  end: number;
  score: number;
  value: string;
  /**
   * Whether the finding can be redacted by replacing its span. `false` for whole-text verdicts
   * (a moderation or classifier call), which replace the whole segment when redacting.
   */
  spanned?: boolean;
  /**
   * What a redaction puts in place of this span. Undefined → a vault placeholder (`[EMAIL_1]`).
   * Detectors whose finding is an instruction rather than a value (injection, tool poisoning) set
   * this so the text is removed rather than tokenized.
   */
  replacement?: string;
}

/** Who wrote a piece of text (model request stage). */
export type SegmentSource = 'system' | 'user' | 'assistant' | 'tool';

/** A piece of text to scan, with where it came from. */
export interface Segment {
  text: string;
  source?: SegmentSource;
  /**
   * Part of the newest turn. Content that is only in re-sent history is acted upon (redacted
   * one-way instead of blocked) but its hits are reported as not fresh. Undefined → fresh.
   */
  fresh?: boolean;
}

/**
 * What the traffic is about. `stage` is the only field the engine reads itself; `tool` feeds the
 * `match.tools` globs. Extend it with whatever your rules' `when` predicates need (tenant, actor,
 * model, destination…).
 */
export interface GuardContext {
  stage: GuardrailStage;
  /** Tool name, on tool stages. */
  tool?: string;
}

/** A detector that runs your own code — NER, a classifier, a moderation endpoint, an LLM judge. */
export interface CustomDetector<C extends GuardContext = GuardContext> {
  kind: 'custom';
  /** Identifies the detector in findings and hits (`detector`). Also its memoization key. */
  name: string;
  detect(text: string, ctx: C): Finding[] | Promise<Finding[]>;
}

/** A detector as configured on a rule. */
export type DetectorSpec<C extends GuardContext = GuardContext> =
  /** Regex + checksum validators (Luhn, CPF/CNPJ mod 11, IBAN mod 97…). */
  | { kind: 'pii'; types?: readonly PiiType[] }
  /** API keys, tokens and private keys (patterns + entropy). */
  | { kind: 'secrets'; types?: readonly SecretType[] }
  /** Prompt-injection / jailbreak heuristics (EN, PT-BR, ES; hidden Unicode; encoded payloads). */
  | { kind: 'injection'; threshold?: number }
  /** Suspicious instructions hidden in tool descriptions (tool poisoning). */
  | { kind: 'tool_poisoning'; threshold?: number }
  /** Your own regular expressions (`(?i)` prefix = case-insensitive). */
  | { kind: 'regex'; patterns: readonly string[]; label?: string }
  /** Words or phrases (case- and accent-insensitive, whole words). */
  | { kind: 'keywords'; words: readonly string[]; label?: string }
  | CustomDetector<C>;

export type DetectorKind = DetectorSpec['kind'];

/** Scope a rule to part of the traffic. Every matcher that is set must match. */
export interface GuardrailMatch {
  /** Model request stage: which messages are scanned (default all). */
  sources?: readonly SegmentSource[];
  /** Tool stages: tool-name globs (`*` any run, `?` one character). Never matches model traffic. */
  tools?: readonly string[];
}

export interface GuardrailOptions {
  /** Shown to the person when the rule blocks or asks for approval. */
  message?: string;
  /** What happens when a detector throws: `open` = ignore (default), `closed` = block. */
  failMode?: 'open' | 'closed';
  /**
   * `redact` on `llm_request`: put the original values back into the answer the caller receives
   * (the model only ever sees placeholders). Default true.
   */
  restore?: boolean;
}

export interface GuardrailRule<C extends GuardContext = GuardContext> {
  id: string;
  /** Shown in hits and decisions. Default: `id`. */
  name?: string;
  /** Ascending order of evaluation; ties by name. Default 100. */
  priority?: number;
  /** Default true. */
  enabled?: boolean;
  stages: readonly GuardrailStage[];
  /** Empty → the rule fires on scope alone (an exemption, or a blanket block). */
  detectors: readonly DetectorSpec<C>[];
  action: GuardrailAction;
  match?: GuardrailMatch;
  /**
   * Anything scope-like the engine does not know about — the tenant, the actor's roles, the model
   * or its destination. Returning false leaves the rule out of this scan.
   */
  when?: (ctx: C) => boolean;
  options?: GuardrailOptions;
}
