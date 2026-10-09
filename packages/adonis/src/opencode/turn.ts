import {
  ASK_TOOL_NAME,
  type ElicitationRequest,
  type HumanReply,
  isHumanDecision,
  normalizeElicitationReply,
  settleElicitation,
} from '../elicitation.js';
import type { AgentStore } from '../spi/agent-store.js';
import type { ApprovalRequirement } from '../spi/approval-policy.js';
import type { SinkWriter, StreamFrame } from '../spi/token-stream-sink.js';
import type { AgentStreamEvent, AgentUiComponent } from '../stream-events.js';
import type {
  AgentRunInput,
  Decision,
  MessageUsage,
  ToolCallRequest,
  ToolResult,
} from '../types.js';
import type {
  OpenCodeClient,
  OpenCodeEvent,
  OpenCodeForm,
  OpenCodePermissionRequest,
} from './client.js';
import { toElicitation, toFormAnswer } from './forms.js';
import { errorText, openCodeLog } from './log.js';

/** How an OpenCode execution ended. */
export type TurnOutcome =
  | { status: 'succeeded' }
  | { status: 'failed'; error: string }
  | { status: 'interrupted' };

/**
 * Something the turn put to a person, with everything needed to hand the answer back to OpenCode
 * later — serializable, so a durable run journals it and replies from another process.
 */
export type PendingAsk =
  | {
      kind: 'approval';
      /** The OpenCode permission request id — also the tool-call id the decision is signalled under. */
      id: string;
      action: string;
      approver: string;
      expiresAt?: string;
      /** The assistant message the call hangs on (absent for a request recovered after a restart). */
      messageId?: string;
    }
  | {
      kind: 'form';
      id: string;
      form: OpenCodeForm;
      request: ElicitationRequest;
      messageId?: string;
    };

/** Where a turn stands: it needs a person, or it is over. */
export type Milestone =
  | { kind: 'ask'; ask: PendingAsk; timeoutMs?: number }
  | { kind: 'finished'; outcome: TurnOutcome };

export interface OpenCodeTurnArgs {
  runId: string;
  input: AgentRunInput;
  client: OpenCodeClient;
  sessionId: string;
  writer: SinkWriter;
  store: AgentStore;
  /** What an action needs before it runs (the agent's `ApprovalPolicy`). */
  approvalFor: (action: string) => Promise<ApprovalRequirement>;
  /** The model label usage is recorded under. */
  modelLabel: string;
  /**
   * An action OpenCode was allowed to run — by a person, a remembered approval or the policy. The
   * engine's MCP endpoint runs an `action` tool only against one of these.
   */
  onGranted?: (action: string, permissionId: string) => void;
}

const FAILED_STATUSES = new Set(['error', 'failed', 'denied', 'cancelled']);

/**
 * OpenCode tools the stream does not show as calls: the question tool IS the form, which streams as
 * an `elicitation` of its own.
 */
const HIDDEN_TOOLS = new Set(['question']);

interface ToolState {
  name: string;
  announced: boolean;
  available: boolean;
  settled: boolean;
  input: Record<string, unknown>;
  innerAnnounced: Set<number>;
  innerSettled: Set<number>;
}

/** One message's worth of the turn, persisted when a person is asked something and at the end. */
interface Segment {
  text: string;
  reasoning: string;
  reasoningMs: number;
  calls: ToolCallRequest[];
  results: ToolResult[];
  /** Components tools pushed (`ctx.emitUi`), last props per id. */
  ui: AgentUiComponent[];
}

function emptySegment(): Segment {
  return { text: '', reasoning: '', reasoningMs: 0, calls: [], results: [], ui: [] };
}

/**
 * The arguments of the call a permission is about. OpenCode puts a built-in tool's arguments
 * straight in `metadata` (`webfetch` → `{ url, format }`); calls that wrap others nest them under
 * `input` or `args`.
 */
function permissionArgs(request: OpenCodePermissionRequest): Record<string, unknown> {
  const metadata = request.metadata ?? {};
  const nested = metadata.input ?? metadata.args;
  if (nested !== null && typeof nested === 'object') return nested as Record<string, unknown>;
  return metadata;
}

/**
 * One turn of an OpenCode session, as the library's stream and store see it. Fed the session's
 * events in order, it writes the protocol's frames and persists what the loop would have — the
 * assistant messages with their tool calls and results, the calls put to a person (so the
 * approve/answer routes find their run), usage per model step — and reports {@link Milestone}s: a
 * person was asked something, or the execution ended.
 *
 * The turn does not wait for people itself. Whoever drives it (`OpenCodeTurns`, under an in-memory
 * or a durable runner) takes the `ask` milestone, waits however it waits, and hands the answer back
 * with {@link decide} — which is what lets a durable run wait across a restart and reply from
 * another process, with a fresh turn object fed the journaled {@link PendingAsk}.
 */
export class OpenCodeTurn {
  /** Serializes the handling of events, so frames and rows land in the order OpenCode sent them. */
  private chain: Promise<void> = Promise.resolve();
  private segment = emptySegment();
  private readonly tools = new Map<string, ToolState>();
  /** Results already persisted per message, so a late settlement adds to them rather than replacing. */
  private readonly messageResults = new Map<string, ToolResult[]>();
  private readonly asked = new Set<string>();
  /** Calls of {@link HIDDEN_TOOLS}, by id. */
  private readonly hidden = new Set<string>();
  private readonly milestones: Milestone[] = [];
  private waiting: ((milestone: Milestone) => void) | undefined;
  private readonly usage: MessageUsage = { inputTokens: 0, outputTokens: 0 };
  private costUsd: number | undefined;
  private steps = 0;
  private stepOpen = false;
  private sawText = false;
  private separator = false;
  private reasoningSince: number | undefined;
  private wroteMessage = false;
  private ended = false;
  private stepError: string | undefined;

  constructor(private readonly a: OpenCodeTurnArgs) {}

  get sessionId(): string {
    return this.a.sessionId;
  }

  get finished(): boolean {
    return this.ended;
  }

  /** The turn's totals so far: tokens, cost, model steps. */
  totals(): { inputTokens: number; outputTokens: number; costUsd?: number; steps: number } {
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      ...(this.costUsd !== undefined ? { costUsd: this.costUsd } : {}),
      steps: this.steps,
    };
  }

  /** Feed one of the session's events. */
  handle(event: OpenCodeEvent): void {
    this.enqueue(() => this.onEvent(event));
  }

  /** End the turn as failed without an event (the prompt was refused, the stream is gone). */
  fail(error: string): void {
    this.enqueue(() => this.end({ status: 'failed', error }));
  }

  /**
   * A component a tool pushed (`ctx.emitUi`, through the engine's MCP endpoint): streamed as a `ui`
   * frame and persisted on the message being written, in the order it arrived. Pushing the same id
   * again replaces it.
   */
  pushUi(component: AgentUiComponent): Promise<void> {
    return new Promise((resolve, reject) => {
      this.chain = this.chain
        .then(async () => {
          await this.step();
          const ui = this.segment.ui;
          const at = ui.findIndex((existing) => existing.id === component.id);
          if (at >= 0) ui[at] = component;
          else ui.push(component);
          await this.event({ kind: 'ui', ...component });
        })
        .then(resolve, reject);
    });
  }

  /** The next milestone: one already reached, or the next one to come. */
  next(): Promise<Milestone> {
    const ready = this.milestones.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Whether a milestone is waiting to be taken. */
  hasMilestone(): boolean {
    return this.milestones.length > 0;
  }

  /**
   * Requests OpenCode raised while nobody listened (this process started after them, or the event
   * stream dropped): its open permissions and forms, handled as if their events had just arrived.
   * One already recorded in the store is reported without being recorded or streamed again.
   */
  async catchUp(): Promise<void> {
    const { client, sessionId } = this.a;
    const permissions = (await client.permission.list?.({ sessionID: sessionId })) ?? [];
    const forms = (await client.session.form.list?.({ sessionID: sessionId })) ?? [];
    await new Promise<void>((resolve) => {
      this.enqueue(async () => {
        for (const permission of permissions) await this.onPermission(permission, true);
        for (const form of forms) await this.onForm(form, true);
        resolve();
      });
    });
  }

  /**
   * Hand a person's answer to what the turn asked, and let OpenCode go on. `tellOpenCode: false`
   * only settles the call (stream and store): the request died with a restarted server, and the
   * new session is told the answer in its prompt instead.
   */
  decide(ask: PendingAsk, reply: HumanReply, opts: { tellOpenCode?: boolean } = {}): Promise<void> {
    const tell = opts.tellOpenCode ?? true;
    return new Promise((resolve, reject) => {
      this.chain = this.chain
        .then(() =>
          ask.kind === 'approval'
            ? this.decided(ask, reply, tell)
            : this.answered(ask, reply, tell),
        )
        .then(resolve, reject);
    });
  }

  private reach(milestone: Milestone): void {
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting(milestone);
    } else {
      this.milestones.push(milestone);
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error: unknown) => {
      openCodeLog.error(`run ${this.a.runId}: ${errorText(error, 'event handling failed')}`);
      // A turn whose bookkeeping broke can't be trusted to finish on its own.
      if (!this.ended) {
        this.ended = true;
        this.reach({
          kind: 'finished',
          outcome: { status: 'failed', error: errorText(error, 'event handling failed') },
        });
      }
    });
  }

  private async write(frame: StreamFrame): Promise<void> {
    await this.a.writer.write(frame);
  }

  private async event(event: AgentStreamEvent): Promise<void> {
    await this.write({ t: 'event', event });
  }

  private async step(): Promise<void> {
    if (this.stepOpen) return;
    this.stepOpen = true;
    await this.event({ kind: 'step-start' });
  }

  private endReasoning(): void {
    if (this.reasoningSince === undefined) return;
    this.segment.reasoningMs += Date.now() - this.reasoningSince;
    this.reasoningSince = undefined;
  }

  private tool(id: string, name = 'tool'): ToolState {
    let state = this.tools.get(id);
    if (state === undefined) {
      state = {
        name,
        announced: false,
        available: false,
        settled: false,
        input: {},
        innerAnnounced: new Set(),
        innerSettled: new Set(),
      };
      this.tools.set(id, state);
      this.segment.calls.push({ id, name, input: state.input, kind: 'read' });
    }
    return state;
  }

  private async announce(id: string, name: string): Promise<ToolState> {
    const state = this.tool(id, name);
    if (!state.announced) {
      state.announced = true;
      await this.event({ kind: 'tool-input-start', id, name: state.name, toolKind: 'read' });
    }
    return state;
  }

  private async makeAvailable(id: string): Promise<ToolState> {
    const state = await this.announce(id, this.tools.get(id)?.name ?? 'tool');
    if (!state.available) {
      state.available = true;
      await this.event({
        kind: 'tool-input-available',
        id,
        name: state.name,
        input: state.input,
        toolKind: 'read',
      });
    }
    return state;
  }

  private setInput(id: string, input: unknown, name?: string): void {
    const state = this.tool(id, name);
    if (input === null || typeof input !== 'object') return;
    Object.assign(state.input, input as Record<string, unknown>);
  }

  /** Code-mode calls made inside a tool (`metadata.toolCalls`), nested under it by `parentId`. */
  private async innerCalls(parentId: string, raw: unknown): Promise<void> {
    if (!Array.isArray(raw)) return;
    const parent = this.tool(parentId);
    for (const [index, call] of raw.entries()) {
      const id = `${parentId}.${index}`;
      const name = String(call?.tool ?? 'tool');
      const input =
        call?.input !== null && typeof call?.input === 'object'
          ? (call.input as Record<string, unknown>)
          : {};
      if (!parent.innerAnnounced.has(index)) {
        parent.innerAnnounced.add(index);
        this.segment.calls.push({ id, name, input, kind: 'read', parentId });
        await this.event({
          kind: 'tool-input-available',
          id,
          name,
          input,
          toolKind: 'read',
          parentId,
        });
      }
      const status = String(call?.status ?? '').toLowerCase();
      if (
        parent.innerSettled.has(index) ||
        status === 'running' ||
        status === 'pending' ||
        !status
      ) {
        continue;
      }
      parent.innerSettled.add(index);
      if (FAILED_STATUSES.has(status)) {
        this.segment.results.push({ id, name, output: { status }, error: status });
        await this.event({ kind: 'tool-output-error', id, error: status });
      } else {
        this.segment.results.push({ id, name, output: { status } });
        await this.event({ kind: 'tool-output', id, output: { status } });
      }
    }
  }

  private async onEvent(e: OpenCodeEvent): Promise<void> {
    if (this.ended) return;
    const d = e.data ?? {};
    switch (e.type) {
      case 'session.text.delta': {
        const delta = typeof d.delta === 'string' ? d.delta : '';
        if (!delta) return;
        this.endReasoning();
        // Whitespace before anything was said is noise.
        if (!this.sawText && !delta.trim()) return;
        await this.step();
        const text = this.separator && this.sawText ? `\n\n${delta}` : delta;
        this.separator = false;
        this.sawText = true;
        this.segment.text += text;
        await this.write({ t: 'text', v: text });
        return;
      }
      case 'session.text.ended':
        // The next step's text starts a new paragraph.
        this.separator = true;
        return;
      case 'session.reasoning.delta': {
        const delta = typeof d.delta === 'string' ? d.delta : '';
        if (!delta) return;
        this.reasoningSince ??= Date.now();
        await this.step();
        this.segment.reasoning += delta;
        await this.event({ kind: 'reasoning', text: delta });
        return;
      }
      case 'session.tool.input.started':
        this.endReasoning();
        if (HIDDEN_TOOLS.has(String(d.name))) {
          this.hidden.add(String(d.id));
          return;
        }
        await this.step();
        await this.announce(String(d.id), String(d.name ?? 'tool'));
        return;
      case 'session.tool.called':
        if (this.hidden.has(String(d.id))) return;
        await this.step();
        this.setInput(String(d.id), d.input, typeof d.name === 'string' ? d.name : undefined);
        await this.makeAvailable(String(d.id));
        return;
      case 'session.skill.activated': {
        const name = String(d.id ?? d.name ?? 'skill');
        const id = `skill:${name}:${this.tools.size}`;
        await this.step();
        await this.announce(id, 'skill');
        this.setInput(id, { name });
        await this.makeAvailable(id);
        await this.settleTool(id, true);
        return;
      }
      case 'session.tool.progress':
        if (this.hidden.has(String(d.id))) return;
        await this.step();
        await this.makeAvailable(String(d.id));
        await this.innerCalls(String(d.id), d.metadata?.toolCalls);
        return;
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = String(d.id);
        if (this.hidden.has(id)) return;
        await this.step();
        await this.makeAvailable(id);
        await this.innerCalls(id, d.metadata?.toolCalls);
        await this.settleTool(
          id,
          e.type === 'session.tool.success',
          errorText(d.error, 'tool failed'),
        );
        return;
      }
      case 'session.step.ended':
        this.endReasoning();
        await this.stepEnded(d);
        return;
      case 'session.step.failed':
        this.stepError = errorText(d.error, 'the model call failed');
        return;
      case 'session.renamed':
        if (typeof d.title === 'string' && d.title.trim()) {
          await this.a.store.setTitle(this.a.input.threadId, d.title.trim());
          await this.event({ kind: 'title', title: d.title.trim() });
        }
        return;
      case 'permission.asked':
        await this.onPermission(d as OpenCodePermissionRequest, false);
        return;
      case 'form.created':
        await this.onForm((d.form ?? d) as OpenCodeForm, false);
        return;
      case 'session.execution.succeeded':
        await this.end({ status: 'succeeded' });
        return;
      case 'session.execution.failed':
        await this.end({
          status: 'failed',
          error: errorText(d.error, this.stepError ?? 'the execution failed'),
        });
        return;
      case 'session.execution.interrupted':
        await this.end({ status: 'interrupted' });
        return;
      default:
        return;
    }
  }

  private async settleTool(id: string, ok: boolean, error = 'failed'): Promise<void> {
    const state = this.tool(id);
    if (state.settled) return;
    state.settled = true;
    if (ok) {
      this.segment.results.push({ id, name: state.name, output: { ok: true } });
      await this.event({ kind: 'tool-output', id, output: { ok: true } });
    } else {
      this.segment.results.push({ id, name: state.name, output: { ok: false }, error });
      await this.event({ kind: 'tool-output-error', id, error });
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: an OpenCode event payload, read defensively.
  private async stepEnded(d: Record<string, any>): Promise<void> {
    const usage: MessageUsage = {
      inputTokens: Number(d.tokens?.input) || 0,
      outputTokens: Number(d.tokens?.output) || 0,
      ...(Number(d.tokens?.cache?.read) ? { cacheReadTokens: Number(d.tokens.cache.read) } : {}),
      ...(Number(d.tokens?.cache?.write) ? { cacheWriteTokens: Number(d.tokens.cache.write) } : {}),
    };
    const costUsd = typeof d.cost === 'number' ? d.cost : undefined;
    this.steps += 1;
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    if (costUsd !== undefined) this.costUsd = (this.costUsd ?? 0) + costUsd;
    await this.a.store.recordUsage({
      threadId: this.a.input.threadId,
      actorRef: this.a.input.actor.id,
      runId: this.a.runId,
      modelId: this.a.modelLabel,
      purpose: 'chat',
      usage,
      ...(costUsd !== undefined ? { costUsd, costSource: 'provider' as const } : {}),
    });
    if (!this.stepOpen) return;
    this.stepOpen = false;
    await this.event({
      kind: 'step-finish',
      usage,
      costUsd: costUsd ?? null,
      ...(this.segment.reasoningMs > 0 ? { reasoningMs: this.segment.reasoningMs } : {}),
      model: this.a.modelLabel,
    });
  }

  /**
   * Persist what the turn produced since the last flush as one assistant message — the message a
   * call put to a person hangs on, or the turn's last one. Returns its id.
   */
  private async flush(final: boolean): Promise<string | undefined> {
    this.endReasoning();
    const s = this.segment;
    const empty = !s.text && !s.reasoning && s.calls.length === 0 && s.ui.length === 0;
    // A turn always leaves an answer behind, even an empty one, so the thread reads as answered.
    if (empty && !(final && !this.wroteMessage)) return undefined;
    this.segment = emptySegment();
    const { input } = this.a;
    const message = await this.a.store.appendMessage({
      threadId: input.threadId,
      role: 'assistant',
      content: s.text,
      runId: this.a.runId,
      ...(final
        ? {
            usage: {
              ...this.usage,
              ...(this.costUsd !== undefined ? { costUsd: this.costUsd } : {}),
            },
          }
        : {}),
      ...(typeof input.persona === 'string' ? { persona: input.persona } : {}),
      ...(s.reasoning ? { reasoning: s.reasoning, reasoningMs: s.reasoningMs } : {}),
      ...(s.calls.length > 0 ? { toolCalls: s.calls } : {}),
      ...(s.results.length > 0 ? { toolResults: s.results } : {}),
      ...(s.ui.length > 0 ? { ui: s.ui } : {}),
    });
    this.wroteMessage = true;
    this.messageResults.set(message.id, [...s.results]);
    return message.id;
  }

  /** A request recorded by an earlier process (a turn resumed after a restart). */
  private async alreadyRecorded(id: string): Promise<boolean> {
    return ((await this.a.store.toolCallApproval?.(id)) ?? null) !== null;
  }

  /** The persisted assistant message carrying call `id`, so its result lands on the same message. */
  private async messageOf(id: string): Promise<string | undefined> {
    const thread = await this.a.store.getThread(this.a.input.threadId);
    return thread?.messages.find((m) => m.toolCalls?.some((call) => call.id === id))?.id;
  }

  private async onPermission(
    request: OpenCodePermissionRequest,
    recovering: boolean,
  ): Promise<void> {
    if (this.asked.has(request.id)) return;
    this.asked.add(request.id);
    const { client, sessionId, input, store } = this.a;
    const action = String(request.action);
    const args = permissionArgs(request);

    if (recovering && (await this.alreadyRecorded(request.id))) {
      const state = await store.toolCallApproval?.(request.id);
      const messageId = await this.messageOf(request.id);
      this.reach({
        kind: 'ask',
        ask: {
          kind: 'approval',
          id: request.id,
          action,
          approver: state?.approver ?? 'requester',
          ...(state?.expiresAt ? { expiresAt: state.expiresAt } : {}),
          ...(messageId !== undefined ? { messageId } : {}),
        },
        ...(state?.expiresAt
          ? { timeoutMs: Math.max(0, Date.parse(state.expiresAt) - Date.now()) }
          : {}),
      });
      return;
    }

    await this.step();
    const requirement = await this.a.approvalFor(action);
    const remembered = requirement.required
      ? ((await store.rememberedApprovals?.(input.threadId)) ?? []).includes(action)
      : false;
    // No one needs to decide: the policy does not require it, or it was approved "for this
    // conversation" earlier. OpenCode asked because a rule said `ask`; the answer is yes.
    if (!requirement.required || remembered) {
      this.a.onGranted?.(action, request.id);
      await client.permission.reply({
        sessionID: sessionId,
        requestID: request.id,
        decision: 'once',
      });
      this.segment.calls.push({ id: request.id, name: action, input: args, kind: 'action' });
      this.segment.results.push({ id: request.id, name: action, output: { approved: true } });
      await this.event({
        kind: 'tool-input-available',
        id: request.id,
        name: action,
        input: args,
        toolKind: 'action',
      });
      await this.event({
        kind: 'approval-settled',
        id: request.id,
        status: 'approved',
        approver: requirement.approver,
        decidedVia: remembered ? 'remembered' : 'policy',
        ...(remembered ? { remember: true } : {}),
      });
      await this.event({ kind: 'tool-output', id: request.id, output: { approved: true } });
      return;
    }

    const ttlMs =
      requirement.ttlMs !== undefined && Number.isFinite(requirement.ttlMs) && requirement.ttlMs > 0
        ? Math.floor(requirement.ttlMs)
        : undefined;
    const expiresAt = ttlMs !== undefined ? new Date(Date.now() + ttlMs).toISOString() : undefined;
    this.segment.calls.push({ id: request.id, name: action, input: args, kind: 'action' });
    const messageId = (await this.flush(false)) as string;
    await store.recordToolCall({
      toolCallId: request.id,
      messageId,
      toolName: action,
      toolType: 'action',
      input: args,
      status: 'pending_approval',
      runId: this.a.runId,
      approver: requirement.approver,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
    await this.event({
      kind: 'tool-input-available',
      id: request.id,
      name: action,
      input: args,
      toolKind: 'action',
    });
    await this.write({
      t: 'approval',
      runId: this.a.runId,
      id: request.id,
      toolName: action,
      input: args,
      approver: requirement.approver,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
    this.reach({
      kind: 'ask',
      ask: {
        kind: 'approval',
        id: request.id,
        action,
        approver: requirement.approver,
        messageId,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      },
      ...(ttlMs !== undefined ? { timeoutMs: ttlMs } : {}),
    });
  }

  private async decided(
    ask: Extract<PendingAsk, { kind: 'approval' }>,
    reply: HumanReply,
    tell: boolean,
  ): Promise<void> {
    // Answers to a form are not a yes: an approval only ever settles on a decision.
    const decision: Decision = isHumanDecision(reply) ? reply : { approved: false };
    const { client, sessionId, store } = this.a;
    const { id, action } = ask;
    const status = decision.approved ? 'approved' : decision.expired ? 'expired' : 'rejected';
    if (decision.approved) this.a.onGranted?.(action, id);
    if (tell) {
      await client.permission.reply({
        sessionID: sessionId,
        requestID: id,
        decision: decision.approved ? 'once' : 'reject',
        ...(decision.approved
          ? {}
          : {
              message: decision.expired
                ? 'Nobody approved this action in time, so it was not run.'
                : `The user denied this action${decision.reason ? `: ${decision.reason}` : ''}. Do not retry it; tell the user what you would have done.`,
            }),
      });
    }
    const result: ToolResult = decision.approved
      ? { id, name: action, output: { approved: true } }
      : {
          id,
          name: action,
          output: { rejected: true, ...(decision.reason ? { reason: decision.reason } : {}) },
          error: decision.expired ? 'approval expired' : 'rejected by the user',
          denied: true,
          ...(decision.expired ? { expired: true as const } : {}),
        };
    await store.updateToolCall({
      toolCallId: id,
      status: decision.approved ? 'executed' : status === 'expired' ? 'expired' : 'rejected',
      output: result.output,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(decision.executedByRef !== undefined ? { executedByRef: decision.executedByRef } : {}),
      ...(decision.remember === true ? { remember: true } : {}),
      ...(decision.decidedVia !== undefined ? { decidedVia: decision.decidedVia } : {}),
    });
    await this.addResult(ask.messageId, result);
    await this.event({
      kind: 'approval-settled',
      id,
      status,
      approver: ask.approver,
      ...(decision.executedByRef !== undefined ? { decidedBy: decision.executedByRef } : {}),
      ...(decision.decidedVia !== undefined ? { decidedVia: decision.decidedVia } : {}),
      ...(decision.remember === true ? { remember: true } : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    });
    if (decision.approved) {
      await this.event({ kind: 'tool-output', id, output: { approved: true } });
    } else {
      await this.event({
        kind: 'tool-output-denied',
        id,
        ...(decision.expired
          ? { reason: 'approval expired' }
          : decision.reason
            ? { reason: decision.reason }
            : {}),
      });
    }
  }

  private async onForm(form: OpenCodeForm, recovering: boolean): Promise<void> {
    if (this.asked.has(form.id)) return;
    this.asked.add(form.id);
    const request = toElicitation(form.id, form);
    if (recovering && (await this.alreadyRecorded(form.id))) {
      const messageId = await this.messageOf(form.id);
      this.reach({
        kind: 'ask',
        ask: {
          kind: 'form',
          id: form.id,
          form,
          request,
          ...(messageId !== undefined ? { messageId } : {}),
        },
      });
      return;
    }
    const input = {
      ...(request.preamble !== undefined ? { preamble: request.preamble } : {}),
      questions: request.questions,
    };
    await this.step();
    this.segment.calls.push({ id: form.id, name: ASK_TOOL_NAME, input, kind: 'ask' });
    const messageId = (await this.flush(false)) as string;
    // A question waiting on a person is what `action` + `pending_approval` already mean — the loop
    // records its own questions the same way, so the answer route finds the run.
    await this.a.store.recordToolCall({
      toolCallId: form.id,
      messageId,
      toolName: ASK_TOOL_NAME,
      toolType: 'action',
      input,
      status: 'pending_approval',
      runId: this.a.runId,
    });
    await this.write({ t: 'elicitation', runId: this.a.runId, id: form.id, request });
    this.reach({ kind: 'ask', ask: { kind: 'form', id: form.id, form, request, messageId } });
  }

  private async answered(
    ask: Extract<PendingAsk, { kind: 'form' }>,
    reply: HumanReply,
    tell: boolean,
  ): Promise<void> {
    const { client, sessionId } = this.a;
    const { form, request } = ask;
    // An Approve pressed on a form confirms its defaults; a Reject skips it.
    const answer = normalizeElicitationReply(reply);
    if (!tell) {
      // The form died with the server; the new session is told the answer.
    } else if (answer.skipped === true) {
      await client.session.form.cancel({ sessionID: sessionId, formID: form.id });
    } else {
      await client.session.form.reply({
        sessionID: sessionId,
        formID: form.id,
        answer: toFormAnswer(form, answer.answers),
      });
    }
    const result = settleElicitation({ request, reply: answer });
    await this.a.store.updateToolCall({
      toolCallId: form.id,
      status: result.skipped ? 'rejected' : 'executed',
      output: result,
      ...(result.skipped ? { error: 'skipped by the user' } : {}),
      ...(answer.answeredByRef !== undefined ? { executedByRef: answer.answeredByRef } : {}),
      ...(answer.answeredVia !== undefined ? { decidedVia: answer.answeredVia } : {}),
    });
    await this.addResult(ask.messageId, { id: form.id, name: ASK_TOOL_NAME, output: result });
    await this.event({ kind: 'tool-output', id: form.id, output: result });
  }

  private async addResult(messageId: string | undefined, result: ToolResult): Promise<void> {
    if (messageId === undefined) return;
    // A message persisted by an earlier process: its results are in the store, not in this map.
    let known = this.messageResults.get(messageId);
    if (known === undefined) {
      const thread = await this.a.store.getThread(this.a.input.threadId);
      known = [...(thread?.messages.find((m) => m.id === messageId)?.toolResults ?? [])];
    }
    const results = [...known.filter((r) => r.id !== result.id), result];
    this.messageResults.set(messageId, results);
    await this.a.store.setMessageToolResults(messageId, results);
  }

  private async end(outcome: TurnOutcome): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (
      outcome.status !== 'failed' ||
      this.segment.text ||
      this.segment.calls.length > 0 ||
      this.segment.ui.length > 0
    ) {
      await this.flush(true);
    }
    if (this.stepOpen) {
      this.stepOpen = false;
      await this.event({ kind: 'step-finish' });
    }
    this.reach({ kind: 'finished', outcome });
  }
}
