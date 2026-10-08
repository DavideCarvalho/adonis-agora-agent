import type { ElicitationRequest } from '../../elicitation.js';
import type { MessageUsage } from '../../types.js';
import { encodeInterruptId } from './interrupt-id.js';
import {
  AG_UI_CUSTOM,
  AG_UI_PROTOCOL_VERSION,
  type AgUiEvent,
  type AgUiInterrupt,
  type AgUiSourceFrame,
  type AgUiTokenUsage,
} from './types.js';

export interface AgUiEncoderOptions {
  /** The ids the consumer sent on `RunAgentInput`: every boundary event echoes them. */
  threadId: string;
  runId: string;
  /** The library run whose stream is being projected (it mints interrupt ids and the `agora.run` event). */
  streamRunId: string;
  /** The library's thread id, when it differs from what the consumer calls the thread. */
  streamThreadId?: string;
  /**
   * Frames of the library run's stream that an earlier AG-UI run already delivered (a resume). They
   * are fed to the encoder like any other — it has to know what they opened — but produce no events.
   */
  skip?: number;
  /**
   * Tool calls a resuming request just answered. The run has not necessarily said so yet — a parked
   * run takes a moment to wake — so without this the encoder would read them as still waiting and
   * report the interrupt again before the answer had any effect.
   */
  answered?: readonly string[];
  /** Model id for the usage entry when the step frames carry none. */
  model?: string;
}

interface OpenCall {
  name: string;
  /** The arguments it was announced with, for an approval frame that does not repeat them. */
  input?: unknown;
  /** `TOOL_CALL_START` was written in THIS run (a resumed run meets results of calls it never saw open). */
  started: boolean;
  ended: boolean;
  sawDelta: boolean;
  answered: boolean;
}

interface Pending {
  interrupt: Omit<AgUiInterrupt, 'id'>;
  kind: 'approval' | 'elicitation' | 'proposal';
  parked: string;
  toolCallId: string;
  proposalId?: string;
}

const APPROVAL_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    reason: { type: 'string' },
    remember: { type: 'boolean' },
  },
  required: ['approved'],
};

/** The answer an elicitation expects: `{ answers: { <questionId>: string[] } }`. */
function elicitationSchema(request: ElicitationRequest): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const question of request.questions) {
    const options = question.options?.map((option) => option.value);
    properties[question.id] = {
      type: 'array',
      title: question.prompt,
      ...(question.description !== undefined ? { description: question.description } : {}),
      items:
        options !== undefined && options.length > 0 && question.allowFreeText !== true
          ? { type: 'string', enum: options }
          : { type: 'string' },
      ...(question.multiple === true ? {} : { maxItems: 1 }),
      ...(question.defaults !== undefined ? { default: question.defaults } : {}),
    };
  }
  return {
    type: 'object',
    properties: { answers: { type: 'object', properties } },
    required: ['answers'],
  };
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value);
  return json === undefined ? '' : json;
}

/**
 * Projects one library run's stream ({@link AgUiSourceFrame}s, in buffer order) onto AG-UI 1.0 events.
 *
 * A pure state machine: the same frames always give the same events, which is what lets a resuming
 * request — served by any replica — replay the run's buffer, skip what the interrupted AG-UI run
 * already delivered, and continue. It writes nothing itself; {@link agUiEvents} drives it and
 * decides when the run has stopped to ask.
 *
 * What maps where:
 *  - `text` → `TEXT_MESSAGE_*` (one message per stretch of text);
 *  - `reasoning` → a reasoning span with one reasoning message;
 *  - `step-start`/`step-finish` → `STEP_STARTED`/`STEP_FINISHED`, the step's usage folded into the
 *    run's `usage`;
 *  - `tool-input-*` → `TOOL_CALL_START`/`ARGS`/`END` (the call's kind as `metadata['agora.toolKind']`);
 *    `tool-output*` → `TOOL_CALL_RESULT`;
 *  - an approval or a question set the run parks on → an `Interrupt` on the closing `RUN_FINISHED`;
 *  - `cancelled` → the cancelled outcome; an error frame → `RUN_ERROR`;
 *  - generative UI, title, queue and the native approval/elicitation frames → `CUSTOM` events named
 *    in {@link AG_UI_CUSTOM}, for what AG-UI has no event for.
 *
 * Not mapped: sub-agent attribution (`subagentRunId`) — a delegated agent's frames are projected
 * flat, as the protocol allows of a producer that does not attribute.
 */
export class AgUiEncoder {
  private position = 0;
  private started = false;
  private closed = false;
  private cancelled = false;
  private crossed = false;
  private messageSeq = 0;
  private stepSeq = 0;
  private openText: string | undefined;
  private openReasoning: string | undefined;
  /** The last text message of the current step: a tool call attaches to it. */
  private stepMessage: string | undefined;
  private readonly openSteps: string[] = [];
  private readonly calls = new Map<string, OpenCall>();
  private readonly pending = new Map<string, Pending>();
  private readonly usage = new Map<string, AgUiTokenUsage>();

  constructor(private readonly options: AgUiEncoderOptions) {}

  /** How many frames of the library stream this encoder has consumed. */
  get consumed(): number {
    return this.position;
  }

  /** The run is waiting on at least one approval or question set nobody has settled yet. */
  get waiting(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Is anything still in flight that is NOT waiting on a person — a tool call announced and neither
   * answered nor parked? While there is, more frames are coming without anyone's help.
   */
  get busy(): boolean {
    for (const [id, call] of this.calls) {
      if (!call.answered && !this.pending.has(id)) return true;
    }
    return false;
  }

  /** `RUN_STARTED`, and the library's own ids for the run. Call once, before the first frame. */
  start(): AgUiEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      {
        type: 'RUN_STARTED',
        threadId: this.options.threadId,
        runId: this.options.runId,
        protocolVersion: AG_UI_PROTOCOL_VERSION,
      },
      {
        type: 'CUSTOM',
        name: AG_UI_CUSTOM.run,
        value: {
          runId: this.options.streamRunId,
          threadId: this.options.streamThreadId ?? this.options.threadId,
        },
      },
    ];
  }

  /** The AG-UI events the next frame of the library stream stands for (possibly none). */
  encode(frame: AgUiSourceFrame): AgUiEvent[] {
    const position = this.position;
    this.position += 1;
    if (this.closed) return [];
    const skip = this.options.skip ?? 0;
    if (!this.crossed && position >= skip) this.crossBoundary();
    const events = this.project(frame, position);
    // A frame an earlier AG-UI run already delivered still moves the state (what is open, what is
    // pending; NOT what was spent — usage is per run) but writes nothing. The last of them is the
    // boundary: crossed at once, not when the next frame happens to arrive, because a run that was
    // just answered may take a moment to write one.
    if (position < skip) {
      if (this.position >= skip) this.crossBoundary();
      return [];
    }
    return events;
  }

  /**
   * The replayed frames are behind us: from here on events are written. The AG-UI run that delivered
   * them closed everything it had open before it finished, so this run starts with nothing open, and
   * what the resuming request answered is no longer waiting.
   */
  private crossBoundary(): void {
    this.crossed = true;
    this.openText = undefined;
    this.openReasoning = undefined;
    this.stepMessage = undefined;
    this.openSteps.length = 0;
    for (const call of this.calls.values()) {
      call.started = false;
      call.ended = true;
    }
    for (const id of this.options.answered ?? []) this.pending.delete(id);
  }

  private get replaying(): boolean {
    return this.position <= (this.options.skip ?? 0);
  }

  private project(event: AgUiSourceFrame, position: number): AgUiEvent[] {
    switch (event.kind) {
      case 'error': {
        this.closed = true;
        const usage = this.usageEntries();
        return [
          {
            type: 'RUN_ERROR',
            message: event.message,
            code: event.code,
            ...(usage.length > 0 ? { usage } : {}),
          },
        ];
      }
      case 'ui':
        return [
          this.custom(AG_UI_CUSTOM.ui, {
            id: event.id ?? `ui:${position}`,
            component: event.component,
            props: event.props,
            ...(event.version !== undefined ? { version: event.version } : {}),
            // What a client that cannot draw the component shows instead.
            ...(event.fallbackText !== undefined ? { fallbackText: event.fallbackText } : {}),
            ...(event.componentVersions !== undefined
              ? { componentVersions: event.componentVersions }
              : {}),
            ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
            // A preview of a call's streaming input: a repeat of this id replaces it in place.
            ...(event.partial === true ? { partial: true } : {}),
          }),
        ];
      case 'approval-requested': {
        const call = this.calls.get(event.id);
        const parked = event.runId ?? this.options.streamRunId;
        const toolName = event.toolName ?? call?.name ?? '';
        const input = event.input ?? call?.input ?? null;
        // An independent proposal: decided through the proposal service, not by signalling the run.
        const proposal = event.target?.kind === 'proposal' ? event.target : undefined;
        this.pending.set(event.id, {
          kind: proposal !== undefined ? 'proposal' : 'approval',
          parked,
          toolCallId: event.id,
          ...(proposal !== undefined ? { proposalId: proposal.proposalId } : {}),
          interrupt: {
            reason: 'tool_approval',
            // The tool's own wording ("Refund order #7?"), as the CUSTOM event's `confirmation`.
            message:
              event.reason ??
              event.confirmation?.title ??
              (toolName.length > 0 ? `Approve ${toolName}?` : 'Approve?'),
            toolCallId: event.id,
            responseSchema: APPROVAL_SCHEMA,
            ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
            metadata: {
              'agora.toolName': toolName,
              'agora.input': input,
              'agora.approver': event.approver,
              ...(event.target !== undefined ? { 'agora.target': event.target } : {}),
            },
          },
        });
        return [
          this.custom(AG_UI_CUSTOM.approvalRequested, {
            id: event.id,
            runId: parked,
            toolName,
            input,
            approver: event.approver,
            ...(event.target !== undefined ? { target: event.target } : {}),
            ...(event.confirmation !== undefined ? { confirmation: event.confirmation } : {}),
            ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
          }),
        ];
      }
      case 'elicitation': {
        const parked = event.runId ?? this.options.streamRunId;
        this.pending.set(event.id, {
          kind: 'elicitation',
          parked,
          toolCallId: event.id,
          interrupt: {
            reason: 'input_required',
            message:
              event.request.preamble ?? event.request.questions[0]?.prompt ?? 'Input required',
            // An intake's question set belongs to no tool call the stream announced.
            ...(this.calls.has(event.id) ? { toolCallId: event.id } : {}),
            responseSchema: elicitationSchema(event.request),
            metadata: { 'agora.request': event.request },
          },
        });
        return [
          this.custom(AG_UI_CUSTOM.elicitation, {
            id: event.id,
            runId: parked,
            request: event.request,
          }),
        ];
      }
      case 'text':
        return event.text.length > 0 ? this.textDelta(event.text) : [];
      case 'reasoning':
        return event.text.length > 0 ? this.reasoningDelta(event.text) : [];
      case 'step-start': {
        this.stepSeq += 1;
        const stepName = `step-${this.stepSeq}`;
        this.openSteps.push(stepName);
        this.stepMessage = undefined;
        return [...this.closeStreams(), { type: 'STEP_STARTED', stepName }];
      }
      case 'step-finish': {
        const out = this.closeStreams();
        if (!this.replaying) this.addUsage(event.usage, event.model);
        const stepName = this.openSteps.pop();
        if (stepName !== undefined) out.push({ type: 'STEP_FINISHED', stepName });
        if (event.usage !== undefined || event.costUsd !== undefined) {
          out.push(
            this.custom(AG_UI_CUSTOM.stepUsage, {
              ...(event.usage !== undefined ? { usage: event.usage } : {}),
              ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
              ...(event.reasoningMs !== undefined ? { reasoningMs: event.reasoningMs } : {}),
              ...(typeof event.model === 'string' ? { model: event.model } : {}),
            }),
          );
        }
        return out;
      }
      case 'tool-input-start': {
        if (this.calls.has(event.id)) return [];
        const out = this.closeStreams();
        this.calls.set(event.id, {
          name: event.name,
          started: true,
          ended: false,
          sawDelta: false,
          answered: false,
        });
        out.push(this.callStart(event.id, event.name, event.toolKind));
        return out;
      }
      case 'tool-input-delta': {
        const call = this.calls.get(event.id);
        if (call === undefined || call.ended || event.delta.length === 0) return [];
        call.sawDelta = true;
        return [{ type: 'TOOL_CALL_ARGS', toolCallId: event.id, delta: event.delta }];
      }
      case 'tool-input-available': {
        const known = this.calls.get(event.id);
        if (known?.ended === true) return [];
        const out = this.closeStreams();
        const call = known ?? {
          name: event.name,
          started: false,
          ended: false,
          sawDelta: false,
          answered: false,
        };
        if (!call.started) {
          call.started = true;
          out.push(this.callStart(event.id, event.name, event.toolKind));
        }
        if (!call.sawDelta) {
          out.push({
            type: 'TOOL_CALL_ARGS',
            toolCallId: event.id,
            delta: text(event.input ?? {}),
          });
        }
        call.ended = true;
        call.input = event.input;
        this.calls.set(event.id, call);
        out.push({ type: 'TOOL_CALL_END', toolCallId: event.id });
        return out;
      }
      case 'tool-output':
        return this.result(event.id, text(event.output));
      case 'tool-output-error':
        return this.result(event.id, event.error, { 'agora.outcome': 'error' });
      case 'tool-output-denied':
        return this.result(event.id, event.reason ?? 'denied', { 'agora.outcome': 'denied' });
      case 'approval-settled':
        this.pending.delete(event.id);
        return [this.custom(AG_UI_CUSTOM.approvalSettled, event)];
      case 'title':
        return [this.custom(AG_UI_CUSTOM.title, { title: event.title })];
      case 'queue':
        return [
          this.custom(AG_UI_CUSTOM.queue, {
            queue: event.queue,
            ...(event.started !== undefined ? { started: event.started } : {}),
          }),
        ];
      case 'cancelled':
        this.cancelled = true;
        return [];
      default:
        // A kind newer than this encoder: tolerated, as every reader of the stream must.
        return [];
    }
  }

  /**
   * The events that end the AG-UI run: whatever is still open is closed first, then `RUN_FINISHED`
   * with how it ended — interrupted when the run is waiting on someone, cancelled when it was
   * stopped, success otherwise. Nothing after a `RUN_ERROR`. `ended` says the library run's stream
   * itself ended, rather than this reader having stopped following it.
   */
  finish(ended = false): AgUiEvent[] {
    if (this.closed) return [];
    this.closed = true;
    if (!this.crossed) this.crossBoundary();
    // A library run that ended is waiting on no one, whatever it asked along the way.
    if (ended) this.pending.clear();
    const out = this.start();
    out.push(...this.closeStreams());
    for (const [id, call] of this.calls) {
      if (call.started && !call.ended) {
        call.ended = true;
        out.push({ type: 'TOOL_CALL_END', toolCallId: id });
      }
    }
    while (this.openSteps.length > 0) {
      out.push({ type: 'STEP_FINISHED', stepName: this.openSteps.pop() as string });
    }
    const usage = this.usageEntries();
    const interrupts = this.cancelled ? [] : this.interrupts();
    out.push({
      type: 'RUN_FINISHED',
      threadId: this.options.threadId,
      runId: this.options.runId,
      ...(this.cancelled
        ? { outcome: { type: 'cancelled' as const } }
        : interrupts.length > 0
          ? { outcome: { type: 'interrupt' as const, interrupts } }
          : {}),
      ...(usage.length > 0 ? { usage } : {}),
    });
    return out;
  }

  private interrupts(): AgUiInterrupt[] {
    return [...this.pending.values()].map((entry) => ({
      id: encodeInterruptId({
        kind: entry.kind,
        parked: entry.parked,
        stream: this.options.streamRunId,
        toolCallId: entry.toolCallId,
        position: this.position,
        ...(entry.proposalId !== undefined
          ? {
              proposalId: entry.proposalId,
              threadId: this.options.streamThreadId ?? this.options.threadId,
            }
          : {}),
      }),
      ...entry.interrupt,
    }));
  }

  private custom(name: string, value: unknown): AgUiEvent {
    return { type: 'CUSTOM', name, value };
  }

  private nextMessageId(): string {
    this.messageSeq += 1;
    return `${this.options.runId}:m${this.messageSeq}`;
  }

  private textDelta(delta: string): AgUiEvent[] {
    const out: AgUiEvent[] = [];
    if (this.openReasoning !== undefined) out.push(...this.closeReasoning());
    if (this.openText === undefined) {
      this.openText = this.nextMessageId();
      this.stepMessage = this.openText;
      out.push({ type: 'TEXT_MESSAGE_START', messageId: this.openText, role: 'assistant' });
    }
    out.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: this.openText, delta });
    return out;
  }

  private reasoningDelta(delta: string): AgUiEvent[] {
    const out: AgUiEvent[] = [];
    if (this.openText !== undefined) out.push(...this.closeText());
    if (this.openReasoning === undefined) {
      this.openReasoning = this.nextMessageId();
      out.push(
        { type: 'REASONING_START', messageId: this.openReasoning },
        { type: 'REASONING_MESSAGE_START', messageId: this.openReasoning, role: 'reasoning' },
      );
    }
    out.push({ type: 'REASONING_MESSAGE_CONTENT', messageId: this.openReasoning, delta });
    return out;
  }

  private closeText(): AgUiEvent[] {
    if (this.openText === undefined) return [];
    const messageId = this.openText;
    this.openText = undefined;
    return [{ type: 'TEXT_MESSAGE_END', messageId }];
  }

  private closeReasoning(): AgUiEvent[] {
    if (this.openReasoning === undefined) return [];
    const messageId = this.openReasoning;
    this.openReasoning = undefined;
    return [
      { type: 'REASONING_MESSAGE_END', messageId },
      { type: 'REASONING_END', messageId },
    ];
  }

  private closeStreams(): AgUiEvent[] {
    return [...this.closeReasoning(), ...this.closeText()];
  }

  private callStart(id: string, name: string, kind: 'read' | 'action' | undefined): AgUiEvent {
    return {
      type: 'TOOL_CALL_START',
      toolCallId: id,
      toolCallName: name,
      ...(this.stepMessage !== undefined ? { parentMessageId: this.stepMessage } : {}),
      // Whether the call reads or acts — AG-UI has no field for it; a consumer of this family
      // renders an action differently (and may be asked to approve it).
      ...(kind !== undefined ? { metadata: { 'agora.toolKind': kind } } : {}),
    };
  }

  private result(id: string, content: string, metadata?: Record<string, unknown>): AgUiEvent[] {
    const call = this.calls.get(id);
    if (call !== undefined) call.answered = true;
    else {
      this.calls.set(id, {
        name: '',
        started: false,
        ended: true,
        sawDelta: false,
        answered: true,
      });
    }
    this.pending.delete(id);
    return [
      ...this.closeStreams(),
      {
        type: 'TOOL_CALL_RESULT',
        messageId: `${this.options.runId}:tool:${id}`,
        toolCallId: id,
        content,
        role: 'tool',
        ...(metadata !== undefined ? { metadata } : {}),
      },
    ];
  }

  private addUsage(usage: MessageUsage | undefined, model: unknown): void {
    if (usage === undefined) return;
    const name = typeof model === 'string' && model.length > 0 ? model : this.options.model;
    const key = name ?? '';
    const entry = this.usage.get(key) ?? (name !== undefined ? { model: name } : {});
    // The library's accounting is already the protocol's: input and output are totals, cache and
    // reasoning counts are parts of them. A count the provider did not report stays absent.
    entry.inputTokens = (entry.inputTokens ?? 0) + usage.inputTokens;
    entry.outputTokens = (entry.outputTokens ?? 0) + usage.outputTokens;
    entry.totalTokens = entry.inputTokens + entry.outputTokens;
    if (usage.cacheReadTokens !== undefined) {
      entry.cachedInputTokens = (entry.cachedInputTokens ?? 0) + usage.cacheReadTokens;
    }
    if (usage.cacheWriteTokens !== undefined) {
      entry.cacheWriteInputTokens = (entry.cacheWriteInputTokens ?? 0) + usage.cacheWriteTokens;
    }
    if (usage.reasoningTokens !== undefined) {
      entry.reasoningTokens = (entry.reasoningTokens ?? 0) + usage.reasoningTokens;
    }
    this.usage.set(key, entry);
  }

  private usageEntries(): AgUiTokenUsage[] {
    return [...this.usage.values()];
  }
}
