import {
  type DataUIPart,
  type DynamicToolUIPart,
  type FileUIPart,
  getToolName,
  isDataUIPart,
  isFileUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai';
import {
  type ElicitationInput,
  readElicitationInput,
  validateElicitationAnswer,
} from '../../../elicitation-input.js';
import type { ToolConfirmation } from '../../../index.js';
import type { ApprovalTarget } from '../approvals/proposals.js';
import { coerceAnswer, type RawAnswer } from '../elicitation/answers.js';
import type { ToolCatalog } from '../presentation/phrasing.js';
import {
  describeToolCall,
  groupToolActivity,
  type ToolActivityGroup,
  type ToolCallDescription,
} from '../presentation/tool-activity.js';
import { readReasoningMs } from '../reasoning/timing.js';

/** A tool UI part on a `UIMessage` — a static `tool-*` part or the `dynamic-tool` part. */
export type AnyToolUIPart = ToolUIPart | DynamicToolUIPart;

/**
 * The AI SDK's chat status, plus `reconnecting`: a turn is in flight and its stream dropped, and the
 * transport is re-attaching (`useAgentChat`). A busy status, like `streaming`.
 */
export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'reconnecting' | 'error';

/** Server-aggregated usage for an assistant turn. */
export interface MessageUsageInfo {
  inputTokens: number;
  outputTokens: number;
  /**
   * `null` when no price is on record for the model that ran the turn. Distinct from `0`, which is
   * a turn that genuinely cost nothing — printing `$0` for an unpriced turn states a number the
   * store never had.
   */
  costUsd: number | null;
}

/** A run of contiguous prose. `isStreaming` is the PART's own state, not the message's. */
export interface TranscriptTextBlock {
  kind: 'text';
  key: string;
  text: string;
  isStreaming: boolean;
}

/** One file on a message — an uploaded attachment, or one the model produced. */
export interface TranscriptFile {
  /** Presigned or otherwise directly fetchable. Display-only: the model reads its own copy. */
  url: string;
  mediaType: string;
  filename: string | null;
  /** `image/*`, which a renderer can show inline rather than as a link. */
  isImage: boolean;
}

/** A run of contiguous files. Grouped so a renderer can lay several out as one strip. */
export interface TranscriptFilesBlock {
  kind: 'files';
  key: string;
  files: TranscriptFile[];
}

/**
 * A run of contiguous reasoning. Carries its own disclosure state because a thread can hold many
 * of them and each is toggled independently; `isOpen` defaults to `isStreaming` (thinking is worth
 * watching live, worth folding away once answered) until `toggle` is called for that run.
 */
export interface TranscriptReasoningBlock {
  kind: 'reasoning';
  key: string;
  text: string;
  isStreaming: boolean;
  /**
   * How long the model thought, in ms — the backend's measurement once the run closed (live) or as
   * persisted (reloaded). `null` while it still streams, or when nothing was recorded: pair it with
   * `useElapsed(block.isStreaming)` for a ticking label (`block.durationMs ?? elapsed`).
   */
  durationMs: number | null;
  isOpen: boolean;
  toggle: (open?: boolean) => void;
}

/**
 * A decision a run is waiting on a human for, and which one a parked call is currently sending.
 *
 * One call settles one way at a time, and WHICH one is what lets a surface report progress on the
 * affordance the person pressed instead of on all of them.
 */
export type SettleAction = 'approve' | 'reject' | 'answer' | 'skip';

/** One such decision: whether it can be made, whether it is on its way, and how to send it. */
export interface TranscriptSettleState {
  available: boolean;
  /** True from the click until the run resumes and settles the call. */
  isSubmitting: boolean;
  run: () => void;
}

/** How an approval stands. */
export type TranscriptApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'superseded';

/**
 * Who has to settle a parked call, until when, and — once it settled — how. From the stream's
 * `approval-requested` / `approval-settled` frames, or the same parts a reloaded thread carries.
 * `null` on a call whose runner never said (the call can still be awaiting approval).
 */
export interface TranscriptApproval {
  target?: ApprovalTarget;
  executionStatus?: 'queued' | 'executing' | 'succeeded' | 'failed' | null;
  confirmation?: ToolConfirmation;
  /** Open vocabulary the host defines: `'requester'`, `'admin'`, a role… */
  approver: string;
  /** ISO-8601; `null` when the request never lapses. Pair with `useApprovalCountdown`. */
  expiresAt: string | null;
  /** Why the call needs a person, when the runner said. */
  reason: string | null;
  /**
   * `pending` until a settlement arrives; then what it said. Falls back to the call's own state
   * (denied → `rejected`, an output → `approved`) for a runner that streams no settlement.
   */
  status: TranscriptApprovalStatus;
  /** The approval also covers later calls of this tool in this thread. */
  remember: boolean;
  /** Opaque ref of who decided; `null` while pending, on an expiry, or when the runner did not say. */
  decidedBy: string | null;
  /** The surface the decision came through (`'web'`, `'slack'`, `'remembered'`, …). */
  decidedVia: string | null;
  /** What the person said when declining. */
  decisionReason: string | null;
}

/** What an approval can carry beyond yes. */
export interface ApproveOptions {
  /** Approve later calls of the same tool in the same thread without asking again. */
  remember?: boolean;
}

/** One call in a tool run, with whatever human decision it is parked on. */
export interface TranscriptToolCall {
  part: AnyToolUIPart;
  toolCallId: string;
  name: string;
  /** `read` / `action` as the stream classified the call; `null` when the backend did not say. */
  toolKind: string | null;
  /** The call this one ran inside (a code-mode `execute`, a delegated agent); `null` for a top-level call. */
  parentId: string | null;
  /**
   * Calls nested under this one within the same block, in stream order. Always empty for a call
   * nothing names as its parent.
   */
  children: TranscriptToolCall[];
  /** Who has to decide, when the runner said so. See {@link TranscriptApproval}. */
  approval: TranscriptApproval | null;
  /**
   * How to talk about this call without naming it — status, phrase, label, icon, approval prompt,
   * resolved result — from the server's presentation when `toolCatalog` was given, generic otherwise.
   */
  description: ToolCallDescription;
  /**
   * Parked on a person. An `action` tool's input lands and its output never follows on its own —
   * the loop waits for an approval between the two — so a settled-looking card that never settles
   * IS the pending approval.
   */
  isAwaitingApproval: boolean;
  /** `run({ remember: true })` approves this tool for the rest of the thread. */
  approve: TranscriptSettleState & { run: (options?: ApproveOptions) => void };
  reject: TranscriptSettleState;
  /** A failed decision — the call is still parked, so the affordance stays live. */
  error: string | null;
  /**
   * The server's machine-readable reason for {@link error}, when it gave one. `run_not_active`
   * means the turn that asked has ended: nothing is waiting for the decision, and pressing again
   * will be refused again — word it yourself and let the person send the message again.
   */
  errorCode: string | null;
}

/**
 * A run of CONSECUTIVE tool parts, grouped so a UI can collapse "5 tools ran" into one affordance.
 * Any non-tool part between two tool parts ends the run — including the AI SDK's `step-start`
 * markers, so tools from different steps never merge into one group.
 */
export interface TranscriptToolBlock {
  kind: 'tools';
  key: string;
  parts: AnyToolUIPart[];
  /** The same calls, each with its human-decision state. Same order as `parts`. */
  calls: TranscriptToolCall[];
  /**
   * The same calls as a tree: every call whose parent is NOT in this block, each carrying its
   * nested calls in `children`. Equal to `calls` when nothing is nested.
   */
  roots: TranscriptToolCall[];
  /**
   * The run folded into activity groups ("Database query ×3"), over `roots`, keyed by each tool's
   * presentation label (else its name). For another grouping, call `groupToolActivity` yourself.
   */
  activity: ToolActivityGroup[];
}

/**
 * A component the server pushed into the message (the stream's `ui` frame, or a persisted
 * `data-ui` part). Rendered by looking `component` up in the host's own registry.
 */
export interface TranscriptUiBlock {
  kind: 'ui';
  key: string;
  /** The component's identity within the message. */
  id: string;
  component: string;
  props: Record<string, unknown>;
  /** Schema version of `props`; `null` when the server did not stamp one. */
  version: number | null;
  fallbackText?: string;
  componentVersions?: Record<string, number>;
  /** The tool call that pushed it (`ctx.emitUi`); `null` for a component pushed outside a tool. */
  toolCallId: string | null;
  /**
   * A preview drawn while the model writes the call's arguments (genui `streaming: 'partial'`):
   * unvalidated, replaced in place by the final push. Absent on a final component.
   */
  partial?: true;
}

/** One choice a question offers, with its live selection state. */
export interface TranscriptQuestionOption {
  value: string;
  label: string;
  /** A single character the request suggested as a shortcut; `null` when it suggested none. */
  hotkey: string | null;
  isSelected: boolean;
  /** Pre-picked by the agent — what an untouched question submits as. */
  isDefault: boolean;
  /** Single choice: replaces the selection. Multiple: adds or removes this value. */
  select: () => void;
}

/** One question of a set, numbered against the whole. */
export interface TranscriptQuestion {
  id: string;
  prompt: string;
  /** A line of help under the prompt; `null` when the request gave none. */
  description: string | null;
  /**
   * How the answer is typed — `{ type, placeholder?, required?, min?, max?, pattern? }` — or `null`
   * for a plain pick from `options`. Render the control from `input.type`; `select` still picks
   * from `options`.
   */
  input: ElicitationInput | null;
  multiple: boolean;
  /** 1-based. The request carries every question up front, so "Question 1 of N" is honest. */
  position: number;
  options: TranscriptQuestionOption[];
  selected: string[];
  /**
   * The user has not touched this question, so a submission leaves it out and the server applies
   * the same defaults it showed. Distinct from "selected happens to equal the defaults": only the
   * first is recorded as `defaulted` rather than as a choice the user made.
   */
  isPristine: boolean;
  /** The first selected value, or `''` — what a single text/number/date field shows. */
  value: string;
  /**
   * Set a typed answer from whatever the control produced (a string, a number, a checkbox's
   * boolean, a `Date`, a list); coerced to the question's canonical strings with `coerceAnswer`.
   * `null`/`''` clears it. Does nothing once the set settled.
   */
  setValue: (raw: RawAnswer) => void;
  /**
   * Why the current selection would be refused (the server's own rules — `validateAnswer`), or
   * `null`. A pristine required question with no default reads `requires an answer`; show it once
   * the user tried to submit, or right away — the model does not decide that for you.
   */
  error: string | null;
}

/** How a question set settled, once it did. */
export interface TranscriptElicitationOutcome {
  answers: Record<string, string[]>;
  /** The user declined to answer and let the agent proceed on its own picks. */
  skipped: boolean;
  /** Questions filled from their own defaults rather than by the human. */
  defaulted: string[];
  /** The questions against the chosen labels, as the model read them back. */
  summary: string | null;
  /** Who answered (or skipped) — an approval's `decidedBy`. `null` when the run did not record it. */
  answeredBy: string | null;
  /** The surface it came through (`'web'`, `'slack'`, …) — an approval's `decidedVia`. */
  answeredVia: string | null;
}

/**
 * A question set the run put to the user, parked until someone settles it — the intake an agent
 * declares and the model's own `ask` produce the same block, because the loop streams the same
 * frame for both.
 */
export interface TranscriptElicitationBlock {
  kind: 'elicitation';
  key: string;
  /** The parked tool call — what `answer`/`skip` route by. */
  toolCallId: string;
  preamble: string | null;
  questions: TranscriptQuestion[];
  questionCount: number;
  /** Still waiting on a human. */
  isPending: boolean;
  /** Every question's current selection is acceptable (no question has an `error`). */
  isValid: boolean;
  outcome: TranscriptElicitationOutcome | null;
  /** A failed submission — the run is still parked, so the form stays live. */
  error: string | null;
  /** The server's machine-readable reason for {@link error} (`run_not_active`, …), when it gave one. */
  errorCode: string | null;
  answer: TranscriptSettleState;
  skip: TranscriptSettleState;
}

/** One retrieved passage, as it rides a retrieval tool call's output. Mirrors core's `Passage`. */
export interface RetrievedPassage {
  id: string;
  text: string;
  score: number;
  /** Citation-facing origin — a document title, URL or row id. */
  source?: string;
  metadata?: Record<string, unknown>;
}

/** The passages of one origin, folded together so a citation line reads once per source. */
export interface TranscriptSource {
  /** The `source` string the retriever stamped, falling back to the passage id when it stamped none. */
  id: string;
  label: string;
  passageCount: number;
  /** Highest relevance among this source's passages; the scale is the retriever's. */
  topScore: number;
  passages: RetrievedPassage[];
}

/**
 * The provenance behind an answer: a run of CONSECUTIVE retrieval tool parts, aggregated by origin.
 * Detection is structural — a tool output shaped `{ passages: [{ id, text, ... }] }` — because the
 * tool's NAME is not fixed: inject-mode retrieval persists as `retrieve`, and `createRetrievalTool`
 * lets the host rename `search_knowledge` to anything.
 */
export interface TranscriptSourcesBlock {
  kind: 'sources';
  key: string;
  /** What was searched, when the tool call recorded a `{ query }` input. */
  query: string | null;
  sources: TranscriptSource[];
  passageCount: number;
}

export type TranscriptBlock =
  | TranscriptTextBlock
  | TranscriptFilesBlock
  | TranscriptReasoningBlock
  | TranscriptToolBlock
  | TranscriptSourcesBlock
  | TranscriptElicitationBlock
  | TranscriptUiBlock;

/** Where a question set's selection state is held, and where its settlement is sent. */
export interface ElicitationBlockOptions {
  /** The values a question is showing, or `undefined` while the user has not touched it. */
  picked: (toolCallId: string, questionId: string) => string[] | undefined;
  pick: (toolCallId: string, questionId: string, values: string[]) => void;
  canAnswer: boolean;
  canSkip: boolean;
  answer: (toolCallId: string) => void;
  skip: (toolCallId: string) => void;
  /** Which decision this call is sending, or `null` for none. */
  submitting: (toolCallId: string) => SettleAction | null;
  errorOf: (toolCallId: string) => string | null;
  /** The `code` of the error `errorOf` reports, when the server sent one. */
  errorCodeOf?: (toolCallId: string) => string | null;
}

/** Where an approval decision is sent, and what the last one did. */
export interface ApprovalBlockOptions {
  canApprove: boolean;
  canReject: boolean;
  approve: (toolCallId: string, options?: ApproveOptions, target?: ApprovalTarget) => void;
  reject: (toolCallId: string, target?: ApprovalTarget) => void;
  /** Which decision this call is sending, or `null` for none. */
  submitting: (toolCallId: string) => SettleAction | null;
  errorOf: (toolCallId: string) => string | null;
  /** The `code` of the error `errorOf` reports, when the server sent one. */
  errorCodeOf?: (toolCallId: string) => string | null;
}

export interface BuildBlocksOptions {
  /** Disclosure lookup for a reasoning run; `isStreaming` is the fallback when untouched. */
  isReasoningOpen: (key: string, isStreaming: boolean) => boolean;
  toggleReasoning: (key: string, open?: boolean) => void;
  /**
   * Lift retrieval tool parts out of the tool run into a `sources` block. Off by default, so a
   * renderer wired to draw tool cards keeps receiving them as the tool calls they are.
   */
  sources?: boolean;
  /**
   * Lift a question set out of the tool run into an `elicitation` block. Omitted → it stays a tool
   * card, which is all a host that has nowhere to send an answer could render anyway.
   */
  elicitation?: ElicitationBlockOptions;
  /** Wire approve/reject onto the calls parked on a human. Omitted → they are reported, not actionable. */
  approval?: ApprovalBlockOptions;
  /** Server-declared tool presentations (`useToolCatalog`), for each call's `description`. */
  toolCatalog?: ToolCatalog;
}

/**
 * Walk a message's parts into renderable blocks, buffering consecutive tool parts into one run and
 * consecutive files into one strip. A `data-ui` part becomes a `ui` block. A
 * `data-approval-requested` part is metadata about a call — it is folded into that call's
 * `approval` and takes no position of its own. Other `data-*` parts are dropped rather than guessed
 * at, but they still terminate a tool run — their position in the transcript is meaningful even
 * when their content is not modelled here.
 */
export function buildTranscriptBlocks(
  message: UIMessage,
  options: BuildBlocksOptions,
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let toolBuffer: AnyToolUIPart[] = [];
  let retrievalBuffer: AnyToolUIPart[] = [];
  let fileBuffer: FileUIPart[] = [];
  let toolCounter = 0;
  let textCounter = 0;
  let fileCounter = 0;
  let reasoningCounter = 0;
  let sourcesCounter = 0;
  let elicitationCounter = 0;
  const approvals = readApprovals(message.parts ?? []);

  function flushTools() {
    if (toolBuffer.length === 0) {
      return;
    }
    const calls = toolBuffer.map((part) =>
      buildToolCall(
        part,
        options.approval,
        approvalOf(approvals.get(part.toolCallId), part),
        options.toolCatalog,
      ),
    );
    const roots = nestToolCalls(calls);
    blocks.push({
      kind: 'tools',
      key: `${message.id}-tools-${toolCounter++}`,
      parts: toolBuffer,
      calls,
      roots,
      activity: groupToolActivity(roots, {
        ...(options.toolCatalog !== undefined ? { catalog: options.toolCatalog } : {}),
      }),
    });
    toolBuffer = [];
  }

  function flushSources() {
    if (retrievalBuffer.length === 0) {
      return;
    }
    blocks.push(buildSourcesBlock(`${message.id}-sources-${sourcesCounter++}`, retrievalBuffer));
    retrievalBuffer = [];
  }

  function flushFiles() {
    if (fileBuffer.length === 0) {
      return;
    }
    blocks.push({
      kind: 'files',
      key: `${message.id}-files-${fileCounter++}`,
      files: fileBuffer.map((part) => ({
        url: part.url,
        mediaType: part.mediaType,
        filename: part.filename ?? null,
        isImage: part.mediaType.startsWith('image/'),
      })),
    });
    fileBuffer = [];
  }

  function flushAll() {
    flushTools();
    flushSources();
    flushFiles();
  }

  const settledCalls = new Set<string>();
  for (const part of message.parts ?? []) {
    if (
      isToolUIPart(part) &&
      (part.state === 'output-available' ||
        part.state === 'output-error' ||
        part.state === 'output-denied')
    ) {
      settledCalls.add(part.toolCallId);
    }
  }

  for (const part of message.parts ?? []) {
    if (isToolUIPart(part)) {
      const elicitation = options.elicitation;
      if (elicitation !== undefined) {
        const request = readElicitationRequest(part);
        if (request !== null) {
          flushAll();
          blocks.push(
            buildElicitationBlock(
              `${message.id}-elicitation-${elicitationCounter++}`,
              part,
              request,
              elicitation,
            ),
          );
          continue;
        }
      }
      if (options.sources === true && readPassages(part) !== null) {
        flushTools();
        retrievalBuffer.push(part);
        continue;
      }
      flushSources();
      flushFiles();
      toolBuffer.push(part);
      continue;
    }
    if (isFileUIPart(part)) {
      flushTools();
      flushSources();
      fileBuffer.push(part);
      continue;
    }
    if (part.type === APPROVAL_PART || part.type === SETTLED_PART) {
      continue;
    }
    flushAll();
    if (isDataUIPart(part)) {
      const ui = part.type === UI_PART ? readUiComponent(part) : null;
      // A preview stands only while its call is being written: withdrawn (no props), or left by a
      // call that settled without replacing it, it is nothing to draw.
      if (
        ui?.partial === true &&
        (Object.keys(ui.props).length === 0 ||
          (ui.toolCallId !== null && settledCalls.has(ui.toolCallId)))
      ) {
        continue;
      }
      if (ui !== null) {
        blocks.push({ kind: 'ui', key: `${message.id}-ui-${ui.id}`, ...ui });
      }
      continue;
    }
    if (isTextUIPart(part)) {
      blocks.push({
        kind: 'text',
        key: `${message.id}-text-${textCounter++}`,
        text: part.text,
        isStreaming: part.state === 'streaming',
      });
      continue;
    }
    if (isReasoningUIPart(part)) {
      const key = `${message.id}-reasoning-${reasoningCounter++}`;
      const isStreaming = part.state === 'streaming';
      blocks.push({
        kind: 'reasoning',
        key,
        text: part.text,
        isStreaming,
        durationMs: readReasoningMs(part),
        isOpen: options.isReasoningOpen(key, isStreaming),
        toggle: (open?: boolean) => options.toggleReasoning(key, open),
      });
    }
  }
  flushAll();
  return blocks;
}

/**
 * Fold a run of retrieval parts into one provenance block. Sources keep the order the retriever
 * returned them in — that order IS the ranking — and the query is taken from the first call that
 * recorded one.
 */
function buildSourcesBlock(key: string, parts: AnyToolUIPart[]): TranscriptSourcesBlock {
  const byId = new Map<string, TranscriptSource>();
  let query: string | null = null;
  let passageCount = 0;

  for (const part of parts) {
    query ??= readQuery(part);
    for (const passage of readPassages(part) ?? []) {
      passageCount++;
      const id = passage.source ?? passage.id;
      const existing = byId.get(id);
      if (existing) {
        existing.passageCount++;
        existing.topScore = Math.max(existing.topScore, passage.score);
        existing.passages.push(passage);
        continue;
      }
      byId.set(id, {
        id,
        label: passage.source ?? passage.id,
        passageCount: 1,
        topScore: passage.score,
        passages: [passage],
      });
    }
  }

  return { kind: 'sources', key, query, sources: [...byId.values()], passageCount };
}

/** A call whose output has landed one way or another is nobody's decision any more. */
function isSettled(state: string): boolean {
  return state === 'output-available' || state === 'output-error' || state === 'output-denied';
}

function toolKind(part: AnyToolUIPart): string | undefined {
  const metadata = (part as { toolMetadata?: unknown }).toolMetadata;
  return isRecord(metadata) && typeof metadata.toolKind === 'string'
    ? metadata.toolKind
    : undefined;
}

/**
 * An `action` tool's input lands and then nothing follows: the loop waits on a person between the
 * call and its execution. So a call classified `action` and stuck at `input-available` IS the
 * pending approval — there is no separate frame that says so.
 */
function isAwaitingApproval(part: AnyToolUIPart): boolean {
  if (part.state === 'approval-requested') {
    return true;
  }
  if (part.state !== 'input-available') {
    return false;
  }
  // A question set parks the same way and is persisted as an action, but it is settled by
  // answering it, not by approving it.
  return toolKind(part) === 'action' && readElicitationRequest(part) === null;
}

function toolParentId(part: AnyToolUIPart): string | null {
  const metadata = (part as { toolMetadata?: unknown }).toolMetadata;
  return isRecord(metadata) && typeof metadata.parentId === 'string' ? metadata.parentId : null;
}

/**
 * Arrange a block's calls into a tree by `parentId`. A call whose parent is not in the block (or
 * that names itself, or would close a cycle) stays a root, so nothing a runner sends is ever lost
 * from the tree — at worst it is shown flat.
 */
function nestToolCalls(calls: TranscriptToolCall[]): TranscriptToolCall[] {
  const byId = new Map(calls.map((call) => [call.toolCallId, call]));
  const roots: TranscriptToolCall[] = [];
  for (const call of calls) {
    const parent = call.parentId !== null ? byId.get(call.parentId) : undefined;
    if (parent === undefined || isAncestor(call, parent, byId)) {
      roots.push(call);
      continue;
    }
    parent.children.push(call);
  }
  return roots;
}

/** True when `candidate` is `call` itself or sits under it — attaching would close a cycle. */
function isAncestor(
  call: TranscriptToolCall,
  candidate: TranscriptToolCall,
  byId: Map<string, TranscriptToolCall>,
): boolean {
  const seen = new Set<string>();
  let current: TranscriptToolCall | undefined = candidate;
  while (current !== undefined && !seen.has(current.toolCallId)) {
    if (current.toolCallId === call.toolCallId) {
      return true;
    }
    seen.add(current.toolCallId);
    current = current.parentId !== null ? byId.get(current.parentId) : undefined;
  }
  return false;
}

function buildToolCall(
  part: AnyToolUIPart,
  options: ApprovalBlockOptions | undefined,
  approval: TranscriptApproval | null,
  catalog: ToolCatalog | undefined,
): TranscriptToolCall {
  const toolCallId = part.toolCallId;
  const awaiting =
    approval?.target?.kind === 'proposal'
      ? approval.status === 'pending'
      : isAwaitingApproval(part);
  // Per decision, not per call: the two are never in flight together, and a surface that read one
  // flag for both would report the refusal it is carrying out as an approval in progress.
  const sending = awaiting ? (options?.submitting(toolCallId) ?? null) : null;
  return {
    part,
    toolCallId,
    name: getToolName(part),
    toolKind: toolKind(part) ?? null,
    parentId: toolParentId(part),
    children: [],
    approval,
    description: proposalDescription(
      describeToolCall(
        part,
        catalog,
        approval?.confirmation === undefined ? {} : { confirmation: approval.confirmation },
      ),
      approval,
    ),
    isAwaitingApproval: awaiting,
    approve: {
      available: awaiting && options?.canApprove === true,
      isSubmitting: sending === 'approve',
      // Read by field, not passed through: `onClick={call.approve.run}` hands this a click event,
      // and a host's handler must not receive that as its options.
      run: (approveOptions?: ApproveOptions) =>
        approval?.target === undefined
          ? approveOptions?.remember === true
            ? options?.approve(toolCallId, { remember: true })
            : options?.approve(toolCallId)
          : options?.approve(
              toolCallId,
              approveOptions?.remember === true ? { remember: true } : undefined,
              approval.target,
            ),
    },
    reject: {
      available: awaiting && options?.canReject === true,
      isSubmitting: sending === 'reject',
      run: () =>
        approval?.target === undefined
          ? options?.reject(toolCallId)
          : options?.reject(toolCallId, approval.target),
    },
    error: options?.errorOf(toolCallId) ?? null,
    errorCode: options?.errorCodeOf?.(toolCallId) ?? null,
  };
}

/** A question as the request wrote it, before any of the user's picks are applied. */
interface ElicitationQuestionData {
  id: string;
  prompt: string;
  description: string | null;
  input: ElicitationInput | null;
  multiple: boolean;
  allowFreeText: boolean;
  defaults: string[];
  options: { value: string; label: string; hotkey: string | null }[];
}

/**
 * The question set a tool call carries, or `null` for any other tool. Read from the call's INPUT
 * and by shape rather than by tool name: the same set is authored by an agent's intake and by the
 * model's own `ask`, it replays from the store under whatever name the row holds, and a client
 * that learned to recognise one name would render only half of them.
 */
function readElicitationRequest(
  part: AnyToolUIPart,
): { preamble: string | null; questions: ElicitationQuestionData[] } | null {
  const input = (part as { input?: unknown }).input;
  if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length === 0) {
    return null;
  }
  const questions: ElicitationQuestionData[] = [];
  for (const candidate of input.questions) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.prompt !== 'string'
    ) {
      return null;
    }
    // A typed question may carry no options; anything else is a pick and must offer some.
    const input = readElicitationInput(candidate.input) ?? null;
    const rawOptions = Array.isArray(candidate.options) ? candidate.options : [];
    if (rawOptions.length === 0 && (input === null || input.type === 'select')) {
      return null;
    }
    const options: ElicitationQuestionData['options'] = [];
    for (const option of rawOptions) {
      if (
        !isRecord(option) ||
        typeof option.value !== 'string' ||
        typeof option.label !== 'string'
      ) {
        return null;
      }
      options.push({
        value: option.value,
        label: option.label,
        hotkey: typeof option.hotkey === 'string' ? option.hotkey : null,
      });
    }
    questions.push({
      id: candidate.id,
      prompt: candidate.prompt,
      description: typeof candidate.description === 'string' ? candidate.description : null,
      input,
      multiple: candidate.multiple === true,
      allowFreeText: candidate.allowFreeText === true,
      defaults: Array.isArray(candidate.defaults)
        ? candidate.defaults.filter((value): value is string => typeof value === 'string')
        : [],
      options,
    });
  }
  return {
    preamble: typeof input.preamble === 'string' ? input.preamble : null,
    questions,
  };
}

/** What the run recorded for a settled question set, or `null` when it settled as something else. */
function readElicitationOutcome(part: AnyToolUIPart): TranscriptElicitationOutcome | null {
  const output = (part as { output?: unknown }).output;
  if (!isRecord(output) || !isRecord(output.answers) || typeof output.skipped !== 'boolean') {
    return null;
  }
  const answers: Record<string, string[]> = {};
  for (const [id, values] of Object.entries(output.answers)) {
    answers[id] = Array.isArray(values)
      ? values.filter((value): value is string => typeof value === 'string')
      : [];
  }
  return {
    answers,
    skipped: output.skipped,
    defaulted: Array.isArray(output.defaulted)
      ? output.defaulted.filter((id): id is string => typeof id === 'string')
      : [],
    summary: typeof output.summary === 'string' ? output.summary : null,
    answeredBy: typeof output.answeredBy === 'string' ? output.answeredBy : null,
    answeredVia: typeof output.answeredVia === 'string' ? output.answeredVia : null,
  };
}

function buildElicitationBlock(
  key: string,
  part: AnyToolUIPart,
  request: { preamble: string | null; questions: ElicitationQuestionData[] },
  options: ElicitationBlockOptions,
): TranscriptElicitationBlock {
  const toolCallId = part.toolCallId;
  const isPending = !isSettled(part.state);
  const outcome = isPending ? null : readElicitationOutcome(part);
  const questions = request.questions.map((question, index) => {
    const picked = isPending ? options.picked(toolCallId, question.id) : undefined;
    const selected = picked ?? outcome?.answers[question.id] ?? question.defaults;
    const pick = (values: string[]) => options.pick(toolCallId, question.id, values);
    // The same rules the answer route applies, over the same question shape core reads.
    const error = isPending
      ? validateElicitationAnswer(
          {
            id: question.id,
            prompt: question.prompt,
            options: question.options.map(({ value, label }) => ({ value, label })),
            ...(question.input !== null ? { input: question.input } : {}),
            ...(question.multiple ? { multiple: true } : {}),
            ...(question.allowFreeText ? { allowFreeText: true } : {}),
          },
          selected,
        )
      : null;
    return {
      id: question.id,
      prompt: question.prompt,
      description: question.description,
      input: question.input,
      multiple: question.multiple,
      position: index + 1,
      selected,
      value: selected[0] ?? '',
      error,
      setValue: (raw: RawAnswer) => {
        if (isPending) {
          pick(coerceAnswer(question, raw));
        }
      },
      isPristine: isPending
        ? picked === undefined
        : (outcome?.defaulted.includes(question.id) ?? true),
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label,
        hotkey: option.hotkey,
        isSelected: selected.includes(option.value),
        isDefault: question.defaults.includes(option.value),
        select: () => {
          if (!isPending) {
            return;
          }
          if (!question.multiple) {
            pick([option.value]);
            return;
          }
          pick(
            selected.includes(option.value)
              ? selected.filter((value) => value !== option.value)
              : [...selected, option.value],
          );
        },
      })),
    };
  });
  const sending = isPending ? options.submitting(toolCallId) : null;
  return {
    kind: 'elicitation',
    key,
    toolCallId,
    preamble: request.preamble,
    questions,
    questionCount: questions.length,
    isPending,
    isValid: questions.every((question) => question.error === null),
    outcome,
    error: options.errorOf(toolCallId),
    errorCode: options.errorCodeOf?.(toolCallId) ?? null,
    answer: {
      available: isPending && options.canAnswer,
      isSubmitting: sending === 'answer',
      run: () => options.answer(toolCallId),
    },
    skip: {
      available: isPending && options.canSkip,
      isSubmitting: sending === 'skip',
      run: () => options.skip(toolCallId),
    },
  };
}

const UI_PART = 'data-ui';
const APPROVAL_PART = 'data-approval-requested';
const SETTLED_PART = 'data-approval-settled';

/** What the approval parts of a message say about one call, before its own state is consulted. */
interface ApprovalParts {
  target?: ApprovalTarget;
  executionStatus?: TranscriptApproval['executionStatus'];
  confirmation?: ToolConfirmation;
  approver: string | null;
  expiresAt: string | null;
  reason: string | null;
  status: Exclude<TranscriptApprovalStatus, 'pending'> | null;
  remember: boolean;
  decidedBy: string | null;
  decidedVia: string | null;
  decisionReason: string | null;
}

const SETTLED_STATUSES: readonly string[] = ['approved', 'rejected', 'expired', 'superseded'];

/** The approval metadata on a message, by call id. The latest frame of each kind for a call wins. */
function readApprovals(parts: UIMessage['parts']): Map<string, ApprovalParts> {
  const out = new Map<string, ApprovalParts>();
  const entry = (id: string): ApprovalParts => {
    let found = out.get(id);
    if (found === undefined) {
      found = {
        approver: null,
        expiresAt: null,
        reason: null,
        status: null,
        remember: false,
        decidedBy: null,
        decidedVia: null,
        decisionReason: null,
      };
      out.set(id, found);
    }
    return found;
  };
  for (const part of parts) {
    if (
      part.type !== APPROVAL_PART &&
      part.type !== SETTLED_PART &&
      part.type !== 'data-action-proposal'
    ) {
      continue;
    }
    const data = (part as DataUIPart<Record<string, unknown>>).data;
    if (!isRecord(data) || typeof data.id !== 'string') {
      continue;
    }
    const approval = entry(data.id);
    if (part.type === APPROVAL_PART || part.type === 'data-action-proposal') {
      if (
        isRecord(data.target) &&
        data.target.kind === 'proposal' &&
        typeof data.target.proposalId === 'string'
      ) {
        approval.target = {
          kind: 'proposal',
          proposalId: data.target.proposalId,
          ...(typeof data.target.threadId === 'string' ? { threadId: data.target.threadId } : {}),
        };
      }
      if (part.type === 'data-action-proposal') {
        if (
          typeof data.status === 'string' &&
          ['pending', 'approved', 'rejected', 'expired', 'superseded'].includes(data.status)
        )
          approval.status =
            data.status === 'pending'
              ? null
              : (data.status as Exclude<TranscriptApprovalStatus, 'pending'>);
        if (
          data.executionStatus === null ||
          data.executionStatus === 'queued' ||
          data.executionStatus === 'executing' ||
          data.executionStatus === 'succeeded' ||
          data.executionStatus === 'failed'
        )
          approval.executionStatus = data.executionStatus;
        approval.remember = data.remember === true;
        approval.decidedBy = typeof data.decidedBy === 'string' ? data.decidedBy : null;
        approval.decidedVia = typeof data.decidedVia === 'string' ? data.decidedVia : null;
      }
      if (typeof data.approver !== 'string') {
        continue;
      }
      approval.approver = data.approver;
      approval.expiresAt = typeof data.expiresAt === 'string' ? data.expiresAt : null;
      if (
        isRecord(data.confirmation) &&
        typeof data.confirmation.title === 'string' &&
        typeof data.confirmation.verb === 'string' &&
        (data.confirmation.detail === undefined || typeof data.confirmation.detail === 'string')
      ) {
        approval.confirmation = {
          title: data.confirmation.title,
          verb: data.confirmation.verb,
          ...(typeof data.confirmation.detail === 'string'
            ? { detail: data.confirmation.detail }
            : {}),
        };
      }
      approval.reason = typeof data.reason === 'string' ? data.reason : null;
      continue;
    }
    if (typeof data.status !== 'string' || !SETTLED_STATUSES.includes(data.status)) {
      continue;
    }
    approval.status = data.status as ApprovalParts['status'];
    if (approval.approver === null && typeof data.approver === 'string') {
      approval.approver = data.approver;
    }
    approval.remember = data.remember === true;
    approval.decidedBy = typeof data.decidedBy === 'string' ? data.decidedBy : null;
    approval.decidedVia = typeof data.decidedVia === 'string' ? data.decidedVia : null;
    approval.decisionReason = typeof data.reason === 'string' ? data.reason : null;
  }
  return out;
}

/**
 * One call's approval: its parts, with the status completed from the call's own state when no
 * settlement was streamed. `null` when nothing on the message says who decides.
 */
function approvalOf(
  parts: ApprovalParts | undefined,
  call: AnyToolUIPart,
): TranscriptApproval | null {
  if (parts === undefined || parts.approver === null) {
    return null;
  }
  return {
    approver: parts.approver,
    ...(parts.target === undefined ? {} : { target: parts.target }),
    ...(parts.executionStatus === undefined ? {} : { executionStatus: parts.executionStatus }),
    ...(parts.confirmation !== undefined ? { confirmation: parts.confirmation } : {}),
    expiresAt: parts.expiresAt,
    reason: parts.reason,
    status: parts.status ?? (parts.target?.kind === 'proposal' ? 'pending' : statusFromPart(call)),
    remember: parts.remember,
    decidedBy: parts.decidedBy,
    decidedVia: parts.decidedVia,
    decisionReason: parts.decisionReason,
  };
}

function statusFromPart(call: AnyToolUIPart): TranscriptApprovalStatus {
  if (call.state === 'output-denied') {
    return 'rejected';
  }
  if (call.state === 'output-available' || call.state === 'output-error') {
    return 'approved';
  }
  return 'pending';
}

/** A pushed component, or `null` when the part does not carry one this model can address. */
function readUiComponent(
  part: DataUIPart<Record<string, unknown>>,
): Omit<TranscriptUiBlock, 'kind' | 'key'> | null {
  const data = part.data;
  if (!isRecord(data) || typeof data.component !== 'string') {
    return null;
  }
  const id = typeof data.id === 'string' ? data.id : part.id;
  if (id === undefined) {
    return null;
  }
  return {
    id,
    component: data.component,
    props: isRecord(data.props) ? data.props : {},
    version: typeof data.version === 'number' ? data.version : null,
    ...(isRecord(data.componentVersions) &&
    Object.values(data.componentVersions).every(
      (version) => typeof version === 'number' && Number.isSafeInteger(version) && version > 0,
    )
      ? { componentVersions: { ...data.componentVersions } as Record<string, number> }
      : {}),
    ...(typeof data.fallbackText === 'string' ? { fallbackText: data.fallbackText } : {}),
    toolCallId: typeof data.toolCallId === 'string' ? data.toolCallId : null,
    ...(data.partial === true ? { partial: true as const } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readQuery(part: AnyToolUIPart): string | null {
  const input = (part as { input?: unknown }).input;
  if (!isRecord(input) || typeof input.query !== 'string') {
    return null;
  }
  return input.query;
}

/**
 * The passages on a settled retrieval tool call, or `null` for any other tool. A call still in
 * flight, or one whose output is not a non-empty list of `{ id, text }` passages, is not provenance
 * yet and stays an ordinary tool part.
 */
function readPassages(part: AnyToolUIPart): RetrievedPassage[] | null {
  const output = (part as { output?: unknown }).output;
  if (!isRecord(output) || !Array.isArray(output.passages) || output.passages.length === 0) {
    return null;
  }
  const passages: RetrievedPassage[] = [];
  for (const candidate of output.passages) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.text !== 'string'
    ) {
      return null;
    }
    passages.push({
      id: candidate.id,
      text: candidate.text,
      score: typeof candidate.score === 'number' ? candidate.score : 0,
      ...(typeof candidate.source === 'string' ? { source: candidate.source } : {}),
      ...(isRecord(candidate.metadata) ? { metadata: candidate.metadata } : {}),
    });
  }
  return passages;
}

/** The message's prose, joined for the clipboard. Reasoning is excluded — it is not the answer. */
export function extractMessageText(parts: UIMessage['parts'] | undefined): string {
  const out: string[] = [];
  for (const part of parts ?? []) {
    if (isTextUIPart(part)) {
      out.push(part.text);
    }
  }
  return out.join('\n\n').trim();
}

export interface UsageSummary extends MessageUsageInfo {
  totalTokens: number;
  /** `$0`, `$0.0123`, `$0.012`, `$1.23` — precision follows magnitude so sub-cent turns stay legible. */
  costLabel: string;
  tokensLabel: string;
}

export function describeUsage(usage: MessageUsageInfo): UsageSummary {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  return {
    ...usage,
    totalTokens,
    costLabel: formatCostUsd(usage.costUsd),
    tokensLabel: formatTokensShort(totalTokens),
  };
}

export interface TimestampInfo {
  iso: string;
  date: Date;
  /** "just now" / "5 min. ago" / "Mar 3" — see {@link formatRelativeTime}. */
  relative: string;
  absolute: string;
}

/** `null` for an unparseable stamp, so a bad `created_at` renders nothing instead of "Invalid Date". */
export function describeTimestamp(createdAt: string | null | undefined): TimestampInfo | null {
  if (createdAt == null) {
    return null;
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return {
    iso: createdAt,
    date,
    relative: formatRelativeTime(date),
    absolute: date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
  };
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * "just now" within ±10s (server `created_at` can land a few ms ahead of the client clock), a
 * relative phrase up to a week, then a calendar date. Uses Intl.RelativeTimeFormat — no date-fns.
 */
export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  if (Math.abs(diffMs) < 10_000) {
    return 'just now';
  }
  if (diffMs > ONE_WEEK_MS) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const minutes = Math.round(-diffMs / 60_000);
  if (Math.abs(minutes) < 60) {
    return RELATIVE_TIME.format(minutes, 'minute');
  }
  const hours = Math.round(-diffMs / 3_600_000);
  if (Math.abs(hours) < 24) {
    return RELATIVE_TIME.format(hours, 'hour');
  }
  return RELATIVE_TIME.format(Math.round(-diffMs / 86_400_000), 'day');
}

function formatTokensShort(n: number): string {
  if (n < 1_000) {
    return `${n} tokens`;
  }
  if (n < 10_000) {
    return `${(n / 1_000).toFixed(1)}k tokens`;
  }
  return `${Math.round(n / 1_000)}k tokens`;
}

function formatCostUsd(cost: number | null): string {
  if (cost === null) {
    return '—';
  }
  if (cost === 0) {
    return '$0';
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}

function proposalDescription(
  description: TranscriptToolCall['description'],
  approval: TranscriptApproval | null,
): TranscriptToolCall['description'] {
  if (approval?.target?.kind !== 'proposal') return description;
  const status =
    approval.status === 'pending'
      ? 'awaiting-approval'
      : approval.status === 'approved'
        ? (approval.executionStatus ?? 'queued')
        : 'denied';
  const phrase =
    status === 'awaiting-approval'
      ? 'Awaiting approval'
      : status === 'queued'
        ? 'Queued'
        : status === 'executing'
          ? 'Executing'
          : status === 'succeeded'
            ? 'Succeeded'
            : status === 'failed'
              ? 'Failed'
              : approval.status === 'expired'
                ? 'Expired'
                : approval.status === 'superseded'
                  ? 'Replaced'
                  : 'Rejected';
  return { ...description, status, phrase, result: null };
}
