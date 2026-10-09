import { getToolName } from 'ai';
import type { ToolConfirmation, ToolPresentation, ToolPresentationTone } from '../../../index.js';
import type { AnyToolUIPart, TranscriptToolCall } from '../transcript/model.js';
import { fillTemplate, phraseFor, type ToolCatalog } from './phrasing.js';
import { type ResolvedResultView, resolveResultView } from './result-view.js';

/**
 * Where one call stands, as a person reads it:
 *  - `running` — input streaming or the tool executing;
 *  - `awaiting-approval` — an `action` call parked on a person;
 *  - `done` / `failed` / `denied` — settled. A tool that RETURNS `{ error }` has failed just as much
 *    as one that threw; the two arrive differently and read the same to a person.
 */
export type ToolCallStatus =
  | 'running'
  | 'awaiting-approval'
  | 'done'
  | 'failed'
  | 'denied'
  | 'queued'
  | 'executing'
  | 'succeeded';

export interface ToolCallState {
  status: ToolCallStatus;
  isSettled: boolean;
  isFailed: boolean;
  isDenied: boolean;
  output: unknown;
  error: string | null;
}

/** Whether the stream classified this call as an `action` (it parks for approval before it runs). */
export function isActionCall(part: AnyToolUIPart): boolean {
  const metadata = (part as { toolMetadata?: unknown }).toolMetadata;
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    (metadata as Record<string, unknown>).toolKind === 'action'
  );
}

export function toolCallState(part: AnyToolUIPart): ToolCallState {
  const output = 'output' in part ? part.output : undefined;
  if (
    output !== null &&
    typeof output === 'object' &&
    'proposalId' in output &&
    'executed' in output &&
    output.executed === false
  )
    return {
      status: 'awaiting-approval',
      isSettled: false,
      isFailed: false,
      isDenied: false,
      output,
      error: null,
    };
  const errorText = 'errorText' in part ? part.errorText : undefined;
  const outputError =
    output !== null && typeof output === 'object' && 'error' in output
      ? String((output as { error: unknown }).error)
      : undefined;
  const isDenied = part.state === 'output-denied';
  const isFailed = part.state === 'output-error' || (outputError !== undefined && !isDenied);
  const isSettled = part.state === 'output-available' || part.state === 'output-error' || isDenied;
  const isAwaiting =
    part.state === 'approval-requested' || (part.state === 'input-available' && isActionCall(part));
  const status: ToolCallStatus = isDenied
    ? 'denied'
    : isFailed
      ? 'failed'
      : isSettled
        ? 'done'
        : isAwaiting
          ? 'awaiting-approval'
          : 'running';
  return {
    status,
    isSettled,
    isFailed,
    isDenied,
    output,
    error: errorText ?? outputError ?? null,
  };
}

/**
 * Which failed calls the model went on to correct, by call id: a call that failed and was followed,
 * in the same run, by a SUCCESS of the same tool. The operator wants to know a retry happened, not
 * to read every attempt. A failed read is not corrected by a successful query.
 */
export function correctedCallIds(parts: readonly AnyToolUIPart[]): Set<string> {
  const corrected = new Set<string>();
  const lastSuccessByTool = new Map<string, number>();
  parts.forEach((part, index) => {
    if (part.state === 'output-available' && !toolCallState(part).isFailed) {
      lastSuccessByTool.set(getToolName(part), index);
    }
  });
  parts.forEach((part, index) => {
    const successAt = lastSuccessByTool.get(getToolName(part));
    if (successAt !== undefined && index < successAt && toolCallState(part).isFailed) {
      corrected.add(part.toolCallId);
    }
  });
  return corrected;
}

/**
 * Which failed calls the model retried AT ONCE, by call id: a failure whose next tool call (in
 * message order) is the same tool and has not failed — it succeeded, or is still running. A chain
 * of failures that ends in a success is retried whole. What a person should not see: the model
 * fixing its own malformed call (a `ui__render` it left the envelope out of) before the view it
 * then drew. A failure the model moved on from, or that the retry failed too, stays.
 */
export function retriedCallIds(parts: readonly AnyToolUIPart[]): Set<string> {
  const retried = new Set<string>();
  let next: { name: string; ok: boolean } | undefined;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] as AnyToolUIPart;
    const name = getToolName(part);
    const state = toolCallState(part);
    if (state.isFailed) {
      if (next?.name === name && next.ok) {
        retried.add(part.toolCallId);
        continue;
      }
      next = { name, ok: false };
    } else {
      next = { name, ok: !state.isDenied };
    }
  }
  return retried;
}

/** Everything a surface needs to talk about one call without naming it. */
export interface ToolCallDescription {
  status: ToolCallStatus;
  /** "Querying orders" / "Queried orders" — or the generic fallback when the tool declared nothing. */
  phrase: string;
  /** The server's noun phrase for the tool; `null` when it declared no presentation. */
  label: string | null;
  icon: string | null;
  tone: ToolPresentationTone;
  detail: string | null;
  /** The approval prompt, templated over the call's input; `null` when the tool declared none. */
  confirm: { title: string; verb: string; detail: string | null } | null;
  /** The output read through its view, once the call is `done`; `null` otherwise or when nothing to draw. */
  result: ResolvedResultView | null;
  error: string | null;
  presentation: ToolPresentation | null;
}

export interface DescribeToolCallOptions {
  /** Resolved strings from the call preflight override the tool catalog templates. */
  confirmation?: ToolConfirmation;
  /** Words for a tool the catalog does not describe. Default `Working` / `Done`. */
  fallback?: { running: string; done: string };
  /** Infer a result view from the output's shape when the tool declared none. Default `false`. */
  inferResult?: boolean;
}

export function describeToolCall(
  part: AnyToolUIPart,
  catalog: ToolCatalog | undefined,
  options: DescribeToolCallOptions = {},
): ToolCallDescription {
  const presentation = catalog?.[getToolName(part)];
  const state = toolCallState(part);
  const input = (part as { input?: unknown }).input;
  const confirm = presentation?.confirm;
  return {
    status: state.status,
    phrase: phraseFor(presentation, input, state.isSettled, options.fallback),
    label: presentation?.label ?? null,
    icon: presentation?.icon ?? null,
    tone: presentation?.tone ?? 'neutral',
    detail: presentation?.detail ?? null,
    confirm:
      options.confirmation !== undefined
        ? {
            title: options.confirmation.title,
            verb: options.confirmation.verb,
            detail: options.confirmation.detail ?? null,
          }
        : confirm === undefined
          ? null
          : {
              title: fillTemplate(confirm.title, input),
              verb: fillTemplate(confirm.verb, input),
              detail: confirm.detail !== undefined ? fillTemplate(confirm.detail, input) : null,
            },
    result:
      state.status === 'done'
        ? resolveResultView(state.output, presentation?.result, {
            ...(options.inferResult !== undefined ? { infer: options.inferResult } : {}),
          })
        : null,
    error: state.error,
    presentation: presentation ?? null,
  };
}

/**
 * Calls folded under one key — "Database query ×3" — with the state that matters most across them.
 */
export interface ToolActivityGroup {
  key: string;
  /** The server's label for the group's tool; `null` when it declared no presentation. */
  label: string | null;
  icon: string | null;
  /** Worst-first across the calls: running › awaiting-approval › failed › denied › done. */
  status: ToolCallStatus;
  count: number;
  /** The phrase of the group's LATEST call — what is happening now. */
  phrase: string;
  calls: TranscriptToolCall[];
  /** Calls nested under the group's calls (all depths), when nesting was not expanded. */
  innerCount: number;
}

export interface GroupToolActivityOptions {
  catalog?: ToolCatalog;
  /**
   * What makes two calls "the same activity". Default: the tool's presentation `label`, else its
   * name. Flippy-style source grouping passes its own (e.g. `github:search`).
   */
  keyOf?: (call: TranscriptToolCall, presentation: ToolPresentation | undefined) => string;
  /**
   * Replace a call that has nested calls with those calls (recursively), so the activity reads as
   * what the code-mode run DID rather than "ran code". Default `false`: groups are built over the
   * top-level calls, and `innerCount` says how much ran beneath them.
   */
  expandNested?: boolean;
  /** Drop failed calls the model corrected with a later success of the same tool. Default `false`. */
  hideCorrected?: boolean;
  fallback?: { running: string; done: string };
}

const STATUS_WEIGHT: Record<ToolCallStatus, number> = {
  running: 4,
  queued: 4,
  executing: 4,
  succeeded: 0,
  'awaiting-approval': 3,
  failed: 2,
  denied: 1,
  done: 0,
};

function descendants(call: TranscriptToolCall): TranscriptToolCall[] {
  return call.children.flatMap((child) => [child, ...descendants(child)]);
}

function leaves(call: TranscriptToolCall): TranscriptToolCall[] {
  return call.children.length === 0 ? [call] : call.children.flatMap(leaves);
}

/**
 * Fold a tool run into activity groups, in order of first appearance. Pass `block.roots` (the
 * transcript's call tree) so nesting is honoured; a flat `block.calls` works too and simply has
 * nothing nested.
 */
export function groupToolActivity(
  calls: readonly TranscriptToolCall[],
  options: GroupToolActivityOptions = {},
): ToolActivityGroup[] {
  const expanded = options.expandNested === true ? calls.flatMap(leaves) : [...calls];
  const corrected =
    options.hideCorrected === true
      ? correctedCallIds(expanded.map((call) => call.part))
      : new Set<string>();
  const groups = new Map<string, ToolActivityGroup>();
  for (const call of expanded) {
    if (corrected.has(call.toolCallId)) continue;
    const presentation = options.catalog?.[call.name];
    const key = options.keyOf?.(call, presentation) ?? presentation?.label ?? call.name;
    const status = call.description.status;
    const phrase = phraseFor(
      presentation,
      (call.part as { input?: unknown }).input,
      status !== 'running' && status !== 'awaiting-approval',
      options.fallback,
    );
    const inner = options.expandNested === true ? 0 : descendants(call).length;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        label: presentation?.label ?? null,
        icon: presentation?.icon ?? null,
        status,
        count: 1,
        phrase,
        calls: [call],
        innerCount: inner,
      });
      continue;
    }
    existing.count += 1;
    existing.calls.push(call);
    existing.phrase = phrase;
    existing.innerCount += inner;
    if (STATUS_WEIGHT[status] > STATUS_WEIGHT[existing.status]) existing.status = status;
  }
  return [...groups.values()];
}
