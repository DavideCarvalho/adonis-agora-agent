import { randomUUID } from 'node:crypto';
import type { AgentDeps } from '../agent-deps.js';
import type { AgentDepsFactory } from '../agent-deps-factory.js';
import { streamErrorFrame } from '../agent-loop.js';
import { type ChatQueueService, isThreadTurn } from '../chat-queue-service.js';
import { RUN_ENDED_BEFORE_TOOL_CALL } from '../dangling-tool-calls.js';
import type { HumanReply } from '../elicitation.js';
import { buildMemoryBlock, offerMemories } from '../memory.js';
import { offerSkills, type ScopeContext } from '../skills.js';
import type { AgentStore } from '../spi/agent-store.js';
import { DefaultApprovalPolicy } from '../spi/approval-policy.js';
import { isChatQueueStore, releaseThreadRun } from '../spi/chat-queue.js';
import type { SinkWriter, TokenStreamSink } from '../spi/token-stream-sink.js';
import type { AiToolCtx } from '../spi/tool.js';
import type { AgentUiComponent } from '../stream-events.js';
import type { ToolRegistry } from '../tool-registry.js';
import type {
  Actor,
  AgentRunInput,
  Persona,
  PromptBuilder,
  PromptContext,
  StoredMessage,
} from '../types.js';
import type { OpenCodeClient, OpenCodePermissionRule } from './client.js';
import { OpenCodeEventHub } from './event-hub.js';
import type {
  OpenCodeAmendment,
  OpenCodeHost,
  OpenCodeRunResult,
  OpenCodeServer,
  OpenCodeSessionRef,
  OpenCodeSessionStore,
} from './host.js';
import { errorText, openCodeLog } from './log.js';
import { type Milestone, OpenCodeTurn, type PendingAsk, type TurnOutcome } from './turn.js';

/**
 * The app's tools, served to OpenCode sessions over the engine's own MCP endpoint
 * (`POST <agent path>/opencode/mcp`, mounted by the engine).
 */
export interface OpenCodeToolsOptions {
  /**
   * The URL the OpenCode server calls that endpoint at, passed to it verbatim (no default). It is
   * resolved from where OpenCode runs, not from the app: e.g. `http://127.0.0.1:3333/agent/opencode/mcp`
   * on the same machine, the app's Compose service or Kubernetes Service name otherwise.
   * `/agent` is the agent's route prefix (`path`).
   */
  url: string;
  /** The MCP server's name in OpenCode; its tools are `<server>.<tool>` / `<server>_<tool>`. Default `'agora'`. */
  server?: string;
  /**
   * The secret the endpoint's bearer tokens are signed with. Default: derived from the app's
   * `APP_KEY`; without one, a random per-process secret (which only works with one process).
   */
  secret?: string;
  /**
   * How long a token OpenCode is given stays valid. A token only ever reaches a turn of its own
   * actor that is running on the session that calls, and it is re-issued on the turns of a session
   * once it is half-way through. Default 7 days.
   */
  ttlMs?: number;
}

export interface OpenCodeEngineSettings {
  /** The id a run gets (e.g. a tenant prefix your durable store partitions by). Default: a random UUID. */
  runId?: (input: AgentRunInput) => string;
  /**
   * `openCodeDurable()` only: how each turn's workflow run starts — tags, search attributes, a
   * concurrency quota (`WorkflowEngine.start` options) — and what a refused start becomes (e.g. a
   * concurrency limit → a 429 for the person sending).
   */
  durable?: {
    start?: (
      input: AgentRunInput,
      runId: string,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
    startError?: (error: unknown, input: AgentRunInput) => unknown;
  };
  /** How many earlier messages a NEW session is told about (a thread whose session was lost). Default 20. */
  historyMessages?: number;
  /** The instructions key the agent's own prompt is put under. Default `'agora.system'`. */
  systemKey?: string;
  /** Serve the app's tools to the sessions. Omit → the session has the host's tools only. */
  tools?: OpenCodeToolsOptions;
  /** Where skills are written, relative to the session's directory. Default `'.opencode/skills'`. */
  skillsDir?: string;
  /**
   * How long `observe` waits for a milestone before failing the turn. Default 30 minutes. A turn
   * parked on a person is not observing: this bounds one stretch of OpenCode working on its own.
   */
  turnTimeoutMs?: number;
}

/** A thread's session, as the steps of a turn pass it along (and a durable run journals it). */
export interface SessionHandle {
  sessionId: string;
  serverKey: string;
  bootId?: string;
  directory?: string;
}

/** What the engine's MCP endpoint tells the turns about the call it is serving. */
export interface OpenCodeToolCall {
  actor: Actor;
  /** The OpenCode server the endpoint's token was issued for. */
  serverKey: string;
  /** The MCP request id, so two calls' unnamed components stay apart. */
  requestId: string;
  /** The call's `_meta` — OpenCode names its session there (`ai.opencode/sessionID`). */
  meta: Readonly<Record<string, unknown>> | undefined;
}

/** The turn a tool call over MCP belongs to — see {@link OpenCodeTurns.callContext}. */
export interface OpenCodeCallContext {
  input: AgentRunInput;
  runId: string;
  ctx: Pick<AiToolCtx, 'threadId' | 'runId' | 'emitUi'> & { agentName?: string };
}

interface LiveTurn {
  turn: OpenCodeTurn;
  input: AgentRunInput;
  handle: SessionHandle;
  client: OpenCodeClient;
  stop: () => void;
}

/** One action OpenCode was allowed to run in a run: an approval the MCP endpoint may spend. */
interface Grant {
  id: string;
  action: string;
}

/** The context the engine's runners and endpoint are built from. */
export interface OpenCodeTurnsDeps {
  host: OpenCodeHost;
  sessions: OpenCodeSessionStore;
  settings: OpenCodeEngineSettings;
  factory: AgentDepsFactory;
  store: AgentStore;
  sink: TokenStreamSink;
  registry: ToolRegistry;
  queue?: ChatQueueService;
  /** Mints the bearer token a session's tools endpoint is registered with (`settings.tools`). */
  mintToolsToken?: (actor: Actor, serverKey: string) => string;
}

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TOOLS_TTL_MS = 7 * 24 * 60 * 60_000;
/** Tool kinds the LOOP serves (delegation, `ask`, `skill`, `remember`): never served over MCP. */
const LOOP_SERVED_KINDS = new Set(['agent', 'ask', 'skill', 'memory']);

/**
 * The steps of an OpenCode turn — `begin` (thread, session, instructions), `prompt`, `observe`
 * (until a person is asked something or the execution ends), `reply`, `settle` — so an in-memory
 * runner can run them in a row and a durable one can checkpoint each. A step may run in a process
 * that did not run the one before (a durable run resumed elsewhere): the live turn is rebuilt from
 * the session, catching up on what OpenCode asked while nobody listened.
 */
export class OpenCodeTurns {
  private readonly events = new OpenCodeEventHub();
  private readonly live = new Map<string, LiveTurn>();
  /** Actions approved per run, and the approvals the MCP endpoint already spent. */
  private readonly grants = new Map<string, Grant[]>();
  private readonly spent = new Set<string>();
  /** When the tools endpoint was last registered for a location (`server|boot|directory`). */
  private readonly toolsIssued = new Map<string, number>();
  readonly host: OpenCodeHost;
  private readonly sessions: OpenCodeSessionStore;
  readonly settings: OpenCodeEngineSettings;
  private readonly factory: AgentDepsFactory;
  private readonly store: AgentStore;
  private readonly sink: TokenStreamSink;
  readonly registry: ToolRegistry;
  private readonly queue: ChatQueueService | undefined;
  private readonly mintToolsToken: OpenCodeTurnsDeps['mintToolsToken'];

  /** Starts the next queued message of the thread; set by the runner (it owns `start`). */
  startNext: ((next: AgentRunInput, runId: string) => Promise<unknown>) | undefined;

  constructor(deps: OpenCodeTurnsDeps) {
    this.host = deps.host;
    this.sessions = deps.sessions;
    this.settings = deps.settings;
    this.factory = deps.factory;
    this.store = deps.store;
    this.sink = deps.sink;
    this.registry = deps.registry;
    this.queue = deps.queue;
    this.mintToolsToken = deps.mintToolsToken;
  }

  /** The tools server's name in OpenCode. */
  get toolsServer(): string {
    return this.settings.tools?.server ?? 'agora';
  }

  /** The agent's deps (prompt, approval policy, allow-list, skills, memory) for a turn. */
  depsFor(input: Pick<AgentRunInput, 'agentName'>): AgentDeps {
    return this.factory.forAgent(input.agentName);
  }

  /** The tools a turn may reach: the agent's allow-list, narrowed by its persona's. */
  allowedTools(input: Pick<AgentRunInput, 'agentName' | 'persona'>): string[] | undefined {
    const deps = this.depsFor(input);
    const persona = personaOf(deps, input.persona);
    const agent = deps.toolAllowList;
    const own = persona?.allowedTools;
    if (agent === undefined) return own;
    if (own === undefined) return agent;
    return agent.filter((name) => own.includes(name));
  }

  /** Whether the memory provider writes, so the endpoint serves `remember`. */
  memoryWritable(input: Pick<AgentRunInput, 'agentName'>): boolean {
    return (
      this.settings.tools !== undefined && this.depsFor(input).memory?.provider.write !== undefined
    );
  }

  /** The runs this process is following now (an updater drains on it). */
  liveRuns(): string[] {
    return [...this.live.keys()];
  }

  /** Stop following every run, and close the event streams. */
  close(): void {
    for (const live of this.live.values()) live.stop();
    this.live.clear();
    this.events.close();
  }

  // ---- tools over MCP --------------------------------------------------------------------------

  /**
   * The turn a tool call over the engine's MCP endpoint belongs to, or `undefined` when it belongs
   * to none — which the endpoint refuses: it exists only to serve turns. OpenCode names its session in
   * every call's `_meta` (`ai.opencode/sessionID`); the call is that session's running turn's, and
   * only when the endpoint's caller is the person that turn runs for, on the server the token was
   * issued for. A session this process is not following is found through OpenCode (`session.get` →
   * the thread it was created for → the thread's running turn); its components still reach the
   * stream, as a message of their own.
   */
  async callContext(call: OpenCodeToolCall): Promise<OpenCodeCallContext | undefined> {
    const sessionId = sessionOfMeta(call.meta);
    if (sessionId === undefined) return undefined;
    const scope = (runId: string) => `${runId}:${call.requestId || randomUUID()}`;
    for (const [runId, live] of this.live) {
      if (live.handle.sessionId !== sessionId) continue;
      if (live.input.actor.id !== call.actor.id || live.handle.serverKey !== call.serverKey) {
        return undefined;
      }
      return {
        input: live.input,
        runId,
        ctx: {
          threadId: live.input.threadId,
          runId,
          ...(live.input.agentName !== undefined ? { agentName: live.input.agentName } : {}),
          emitUi: uiEmitter(scope(runId), async (component) => {
            await live.turn.pushUi(component);
            await this.uiPushed(live.input, runId, component);
          }),
        },
      };
    }
    const threadId = await this.threadOfSession(call.actor, sessionId);
    if (threadId === undefined) return undefined;
    if ((await this.store.getThreadActorRef(threadId)) !== call.actor.id) return undefined;
    const known = await this.sessions.get(threadId);
    if (known === null || known.sessionId !== sessionId || known.serverKey !== call.serverKey) {
      return undefined;
    }
    const runId = await this.activeRun(threadId);
    if (runId === null) return undefined;
    // Followed elsewhere: what this call knows of the run.
    const input: AgentRunInput = {
      threadId,
      actor: call.actor,
      userText: '',
      ...(known.agentName !== undefined ? { agentName: known.agentName } : {}),
      ...(known.persona !== undefined ? { persona: known.persona } : {}),
    };
    return {
      input,
      runId,
      ctx: {
        threadId,
        runId,
        ...(known.agentName !== undefined ? { agentName: known.agentName } : {}),
        emitUi: uiEmitter(scope(runId), async (component) => {
          const writer = await this.sink.open(runId);
          await writer.write({ t: 'event', event: { kind: 'ui', ...component } });
          await this.store.appendMessage({
            threadId,
            role: 'assistant',
            content: '',
            runId,
            ui: [component],
          });
          await this.uiPushed(input, runId, component);
        }),
      },
    };
  }

  /**
   * Spend one approval of `tool` in `runId` — what the MCP endpoint asks before it runs an `action`.
   * OpenCode asks the person (or the policy answers) before it calls an action tool; the endpoint
   * runs it only against an approval this engine saw granted, so a caller that skipped OpenCode's
   * permission rules (anything that got hold of the token) cannot run an action unapproved. The
   * approval is the run's own: live in this process, else read off the run's persisted calls.
   */
  async spendApproval(runId: string, threadId: string, tool: string): Promise<boolean> {
    const names = new Set([tool, `${this.toolsServer}.${tool}`, `${this.toolsServer}_${tool}`]);
    const local = (this.grants.get(runId) ?? []).find(
      (grant) => names.has(grant.action) && !this.spent.has(grant.id),
    );
    if (local !== undefined) {
      this.spent.add(local.id);
      return true;
    }
    const thread = await this.store.getThread(threadId);
    for (const message of thread?.messages ?? []) {
      if (message.runId !== runId) continue;
      for (const call of message.toolCalls ?? []) {
        if (!names.has(call.name) || this.spent.has(call.id)) continue;
        const result = message.toolResults?.find((r) => r.id === call.id);
        const approved = (result?.output as { approved?: unknown } | undefined)?.approved === true;
        if (approved) {
          this.spent.add(call.id);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Push a component into the run an OpenCode session is serving, for the host's own trusted
   * callers (no caller check — the MCP endpoint checks its own). `false` when no run is live on
   * that session in this process.
   */
  async pushToSession(sessionId: string, component: AgentUiComponent): Promise<boolean> {
    for (const [runId, live] of this.live) {
      if (live.handle.sessionId !== sessionId) continue;
      await live.turn.pushUi(component);
      await this.uiPushed(live.input, runId, component);
      return true;
    }
    return false;
  }

  private async uiPushed(input: AgentRunInput, runId: string, component: AgentUiComponent) {
    if (this.host.onUi === undefined) return;
    try {
      await this.host.onUi({ input, runId, component });
    } catch (error) {
      openCodeLog.warn(`onUi failed: ${errorText(error, 'error')}`);
    }
  }

  private async threadOfSession(actor: Actor, sessionId: string): Promise<string | undefined> {
    try {
      const server = await this.host.server(actor);
      const info = await server.client.session.get?.({ sessionID: sessionId });
      const threadId = info?.metadata?.threadId;
      return typeof threadId === 'string' ? threadId : undefined;
    } catch {
      return undefined;
    }
  }

  private async activeRun(threadId: string): Promise<string | null> {
    if (isChatQueueStore(this.store)) return this.store.activeRunForThread(threadId);
    return (await this.store.getThread(threadId))?.activeRunId ?? null;
  }

  // ---- begin -----------------------------------------------------------------------------------

  /**
   * Open the run's row, persist the user message (or rewind the thread for a regenerate), find or
   * create the thread's session, and refresh what the session is told this turn.
   */
  async begin(runId: string, input: AgentRunInput, durable = false): Promise<SessionHandle> {
    // A durable `begin` re-run after a crash finds its row already there.
    if ((await this.store.getRunActorRef(runId)) === null) {
      await this.store.recordRunStart({
        runId,
        threadId: input.threadId,
        actor: input.actor,
        durable,
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      });
    }
    const earlier = await this.prepareThread(runId, input);
    const server = await this.host.server(input.actor);
    const known = await this.sessions.get(input.threadId);
    const reusable =
      known !== null &&
      known.serverKey === server.key &&
      known.bootId === server.bootId &&
      ((await this.host.reuse?.({ input, runId, session: known })) ?? true);
    let handle: SessionHandle;
    let created = false;
    if (known !== null && reusable) {
      handle = {
        sessionId: known.sessionId,
        serverKey: known.serverKey,
        ...(known.bootId !== undefined ? { bootId: known.bootId } : {}),
        ...(known.directory !== undefined ? { directory: known.directory } : {}),
      };
      if (input.regenerate === true) await this.revertLastExchange(server.client, handle.sessionId);
      await this.addTools(input, server, handle.directory, false);
    } else {
      handle = await this.createSession(runId, input, server, earlier);
      created = true;
    }
    const persona = typeof input.persona === 'string' ? input.persona : input.persona?.id;
    if (created || known?.agentName !== input.agentName || known?.persona !== persona) {
      await this.sessions.set(input.threadId, {
        ...handle,
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        ...(persona !== undefined ? { persona } : {}),
      });
    }
    await this.host.beforePrompt?.({
      input,
      runId,
      sessionId: handle.sessionId,
      client: server.client,
      created,
    });
    await this.refreshInstructions(runId, input, server.client, handle.sessionId);
    return handle;
  }

  private async createSession(
    runId: string,
    input: AgentRunInput,
    server: OpenCodeServer,
    earlier: StoredMessage[],
    note?: string,
  ): Promise<SessionHandle> {
    const { client } = server;
    const context = { input, runId };
    const spec = await this.host.session(context);
    const directory = spec.location?.directory;
    const skills = await this.writeSkills(input, client, directory);
    const sessionId = (
      await client.session.create({
        ...spec,
        permissions: [
          ...(spec.permissions ?? []),
          ...this.toolRules(input),
          ...skills.map(
            (name): OpenCodePermissionRule => ({
              action: 'skill',
              resource: name,
              effect: 'allow',
            }),
          ),
        ],
        metadata: { ...(spec.metadata ?? {}), threadId: input.threadId },
      })
    ).id;
    const handle: SessionHandle = {
      sessionId,
      serverKey: server.key,
      ...(server.bootId !== undefined ? { bootId: server.bootId } : {}),
      ...(directory !== undefined ? { directory } : {}),
    };
    await this.sessions.set(input.threadId, handle satisfies OpenCodeSessionRef);
    await this.addTools(input, server, directory, true);
    await this.host.prepare?.({ ...context, sessionId, client });
    const transcript = transcriptOf(earlier, this.settings.historyMessages ?? 20);
    if (transcript || note) {
      await client.session.instructions.entry.put({
        sessionID: sessionId,
        key: 'agora.history',
        value: [
          transcript
            ? `The conversation so far (continue it; do not repeat it):\n${transcript}`
            : '',
          note ?? '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      });
    }
    return handle;
  }

  /** The user message, as the loop persists it (or, on a regenerate, the thread rewound to it). */
  private async prepareThread(runId: string, input: AgentRunInput): Promise<StoredMessage[]> {
    const thread = await this.store.getThread(input.threadId);
    const messages = thread?.messages ?? [];
    if (input.regenerate === true) {
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'user') {
          lastUser = i;
          break;
        }
      }
      const firstDropped = messages[lastUser + 1];
      if (firstDropped !== undefined) {
        await this.store.truncateFrom(input.threadId, firstDropped.id);
      }
      return messages.slice(0, Math.max(lastUser, 0));
    }
    await this.store.appendMessage({
      threadId: input.threadId,
      role: 'user',
      content: input.userText,
      runId,
      ...(typeof input.persona === 'string' ? { persona: input.persona } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
    });
    if (thread !== null && (thread.title === '' || thread.title === 'New chat')) {
      await this.store.setTitle(input.threadId, titleOf(input.userText));
    }
    return messages;
  }

  /** Rewind the session to before its last user message, so the regenerated answer replaces it. */
  private async revertLastExchange(client: OpenCodeClient, sessionId: string): Promise<void> {
    if (client.message === undefined || client.session.revert === undefined) return;
    const page = await client.message.list({ sessionID: sessionId, order: 'desc', limit: 50 });
    const last = page.data.find((m) => m.type === 'user');
    if (last === undefined) return;
    await client.session.revert.stage({ sessionID: sessionId, messageID: last.id, files: false });
    await client.session.revert.commit({ sessionID: sessionId });
  }

  /** The agent's prompt, the memory block and the host's entries — refreshed every turn. */
  private async refreshInstructions(
    runId: string,
    input: AgentRunInput,
    client: OpenCodeClient,
    sessionId: string,
  ): Promise<void> {
    const memory = await this.memoryBlock(input);
    const entries: Record<string, string> = {
      [this.settings.systemKey ?? 'agora.system']: await this.systemPrompt(input),
      ...(memory !== undefined ? { 'agora.memory': memory } : {}),
      ...((await this.host.instructions?.({ input, runId, sessionId })) ?? {}),
    };
    for (const [key, value] of Object.entries(entries)) {
      await client.session.instructions.entry.put({ sessionID: sessionId, key, value });
    }
  }

  /**
   * The agent's prompt as the loop resolves it: a persona's prompt stands in for the base (a
   * builder is handed the base as `basePrompt`), else the agent's `systemPrompt`.
   */
  private async systemPrompt(input: AgentRunInput): Promise<string> {
    const deps = this.depsFor(input);
    const persona = personaOf(deps, input.persona);
    const ctx: Omit<PromptContext, 'basePrompt'> = {
      actor: input.actor,
      ...(persona !== undefined ? { persona } : {}),
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
      ...(input.uiCapabilities !== undefined ? { uiCapabilities: input.uiCapabilities } : {}),
    };
    const resolve = async (prompt: string | PromptBuilder, basePrompt: string) =>
      typeof prompt === 'function' ? prompt({ ...ctx, basePrompt }) : prompt;
    const own = persona?.systemPrompt;
    if (own === undefined) return resolve(deps.systemPrompt, '');
    const base = typeof own === 'function' ? await resolve(deps.systemPrompt, '') : '';
    return resolve(own, base);
  }

  private scopeContext(input: AgentRunInput): ScopeContext {
    return {
      actor: input.actor,
      threadId: input.threadId,
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
    };
  }

  /** What is on file about the actor (`memory` in the config); writable when `remember` is served. */
  private async memoryBlock(input: AgentRunInput): Promise<string | undefined> {
    const memory = this.depsFor(input).memory;
    if (memory === undefined) return undefined;
    const digest = await offerMemories({
      config: memory,
      ctx: this.scopeContext(input),
      query: input.userText,
    });
    if (digest.entries.length === 0) return undefined;
    return buildMemoryBlock({
      entries: digest.entries,
      writable: this.memoryWritable(input),
      partial: digest.omitted > 0 || digest.recalled === true,
    });
  }

  /**
   * The agent's skills (`skills` in the config) as `SKILL.md` files under the session's directory,
   * where OpenCode's own `skill` tool finds them. Returns the names written.
   */
  private async writeSkills(
    input: AgentRunInput,
    client: OpenCodeClient,
    directory: string | undefined,
  ): Promise<string[]> {
    const skills = this.depsFor(input).skills;
    if (skills === undefined || client.file === undefined || directory === undefined) return [];
    const ctx = this.scopeContext(input);
    const offer = await offerSkills(skills, ctx);
    const dir = this.settings.skillsDir ?? '.opencode/skills';
    const written: string[] = [];
    for (const entry of offer.entries) {
      const body = await skills.provider.load({ name: entry.name, scope: entry.scope, ctx });
      if (body === null) continue;
      const file = `---\nname: ${entry.name}\ndescription: ${JSON.stringify(entry.description)}\n---\n\n${body}\n`;
      await client.file.write({
        location: { directory },
        path: `${dir}/${entry.name}/SKILL.md`,
        payload: new TextEncoder().encode(file),
      });
      written.push(entry.name);
    }
    return written;
  }

  /**
   * Permission rules for the app's tools: the MCP server allowed as a whole (OpenCode offers a
   * server's tools only when the server itself is allowed), then each `action` tool asked — the last
   * matching rule wins, so an action still lands on an approval card. Tools outside the agent's
   * allow-list, and the kinds only the loop serves, are denied.
   */
  private toolRules(input: AgentRunInput): OpenCodePermissionRule[] {
    if (this.settings.tools === undefined) return [];
    const server = this.toolsServer;
    const allow = this.allowedTools(input);
    const both = (name: string) => [`${server}.${name}`, `${server}_${name}`];
    const rules: OpenCodePermissionRule[] = [
      { action: `${server}*`, resource: '*', effect: 'allow' },
    ];
    for (const spec of this.registry.allSpecs()) {
      const offered =
        (allow === undefined || allow.includes(spec.name)) && !LOOP_SERVED_KINDS.has(spec.kind);
      if (offered && spec.kind === 'read') continue;
      const effect = offered && spec.kind === 'action' ? 'ask' : 'deny';
      for (const action of both(spec.name)) rules.push({ action, resource: '*', effect });
    }
    return rules;
  }

  /**
   * Register the tools endpoint at the session's location, with a bearer token for the turn's
   * actor. On a new session always; on a kept one when this process has not registered it yet or
   * its token is half-way through its life.
   */
  private async addTools(
    input: AgentRunInput,
    server: OpenCodeServer,
    directory: string | undefined,
    fresh: boolean,
  ): Promise<void> {
    const tools = this.settings.tools;
    if (tools === undefined || this.mintToolsToken === undefined) return;
    const { client } = server;
    if (client.mcp === undefined) {
      openCodeLog.warn('`tools` is set but the OpenCode client cannot add MCP servers (`mcp.add`)');
      return;
    }
    const key = `${server.key}|${server.bootId ?? ''}|${directory ?? ''}|${input.actor.id}`;
    const issued = this.toolsIssued.get(key);
    const ttl = tools.ttlMs ?? DEFAULT_TOOLS_TTL_MS;
    if (!fresh && issued !== undefined && Date.now() - issued < ttl / 2) return;
    await client.mcp.add({
      server: this.toolsServer,
      ...(directory !== undefined ? { location: { directory } } : {}),
      config: {
        type: 'remote',
        url: tools.url,
        headers: { Authorization: `Bearer ${this.mintToolsToken(input.actor, server.key)}` },
        oauth: false,
      },
    });
    this.toolsIssued.set(key, Date.now());
  }

  // ---- prompt / observe / reply ----------------------------------------------------------------

  /** Start listening to the session (so nothing it says is missed), then send the user message. */
  async prompt(runId: string, input: AgentRunInput, handle: SessionHandle): Promise<void> {
    const live = await this.ensureLive(runId, input, handle, false);
    try {
      const prompt = (await this.host.promptFor?.({
        input,
        runId,
        sessionId: handle.sessionId,
      })) ?? {
        text: input.userText,
        ...(input.attachments?.length && this.host.files
          ? { files: await this.host.files({ input, runId }) }
          : {}),
      };
      await live.client.session.prompt({
        sessionID: handle.sessionId,
        text: prompt.text,
        ...(prompt.files?.length ? { files: prompt.files } : {}),
      });
    } catch (error) {
      live.turn.fail(`OpenCode refused the message: ${errorText(error, 'unknown error')}`);
    }
  }

  /**
   * Wait for the turn's next milestone. In a process that was not following the turn (a resumed
   * durable run), the turn is rebuilt and first catches up on requests OpenCode raised meanwhile;
   * `session.wait` is the safety net for a terminal event that was missed.
   */
  async observe(runId: string, input: AgentRunInput, handle: SessionHandle): Promise<Milestone> {
    const live = await this.ensureLive(runId, input, handle, true);
    const { turn, client } = live;
    if (turn.hasMilestone()) return this.reached(runId, input, handle, await turn.next());
    // Set once this observation has its milestone: the safety nets below only act while it waits.
    let done = false;
    const next = turn.next().then((milestone) => {
      done = true;
      return milestone;
    });
    const timeoutMs = this.settings.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (!done) turn.fail('Timed out waiting for OpenCode.');
    }, timeoutMs);
    timer.unref?.();
    if (client.session.wait !== undefined) {
      void client.session
        .wait({ sessionID: handle.sessionId })
        .then(() => new Promise((resolve) => setTimeout(resolve, 2_000)))
        .then(async () => {
          if (done || turn.finished) return;
          await turn.catchUp().catch(() => undefined);
          // Let a milestone the catch-up reached settle this observation first.
          await new Promise((resolve) => setImmediate(resolve));
          // Idle with nothing open: the execution ended while its last events were lost.
          if (!done && !turn.finished) {
            turn.handle({
              type: 'session.execution.succeeded',
              data: { sessionID: handle.sessionId },
            });
          }
        })
        .catch(() => undefined);
    }
    try {
      return await this.reached(runId, input, handle, await next);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Hand a person's answer back to OpenCode. When the server restarted while the turn waited, the
   * request is gone with it: a new session is opened, told what the person decided, and prompted
   * to go on.
   */
  async reply(
    runId: string,
    input: AgentRunInput,
    handle: SessionHandle,
    ask: PendingAsk,
    reply: HumanReply,
  ): Promise<SessionHandle> {
    const server = await this.host.server(input.actor);
    if (server.key !== handle.serverKey || server.bootId !== handle.bootId) {
      return this.continueAfterRestart(runId, input, server, ask, reply);
    }
    const live = await this.ensureLive(runId, input, handle, false);
    await live.turn.decide(ask, reply);
    return handle;
  }

  private async continueAfterRestart(
    runId: string,
    input: AgentRunInput,
    server: OpenCodeServer,
    ask: PendingAsk,
    reply: HumanReply,
  ): Promise<SessionHandle> {
    const approved = 'approved' in reply && reply.approved === true;
    const note =
      ask.kind === 'approval'
        ? approved
          ? `The user approved the action ${ask.action} you asked permission for. Continue the task.`
          : `The user did not approve the action ${ask.action}. Continue without it and explain.`
        : `The user answered your question: ${JSON.stringify('answers' in reply ? reply.answers : {})}. Continue.`;
    const thread = await this.store.getThread(input.threadId);
    const handle = await this.createSession(runId, input, server, thread?.messages ?? [], note);
    await this.refreshInstructions(runId, input, server.client, handle.sessionId);
    this.drop(runId);
    const live = await this.ensureLive(runId, input, handle, false);
    // The old request's card settles as decided; OpenCode is told in the note.
    await live.turn.decide(ask, reply, { tellOpenCode: false });
    await live.client.session.prompt({ sessionID: handle.sessionId, text: note });
    return handle;
  }

  /** Interrupt the thread's session (cancel). */
  async interrupt(input: AgentRunInput): Promise<void> {
    const known = await this.sessions.get(input.threadId);
    if (known === null) return;
    const server = await this.host.server(input.actor);
    if (server.key !== known.serverKey || server.bootId !== known.bootId) return;
    await server.client.session.interrupt({ sessionID: known.sessionId });
  }

  private async ensureLive(
    runId: string,
    input: AgentRunInput,
    handle: SessionHandle,
    catchUp: boolean,
  ): Promise<LiveTurn> {
    const current = this.live.get(runId);
    if (current !== undefined && current.handle.sessionId === handle.sessionId) return current;
    current?.stop();
    const server = await this.host.server(input.actor);
    const deps = this.depsFor(input);
    const policy = deps.approvalPolicy ?? new DefaultApprovalPolicy();
    const writer = await this.sink.open(runId);
    const turn = new OpenCodeTurn({
      runId,
      input,
      client: server.client,
      sessionId: handle.sessionId,
      writer,
      store: this.store,
      approvalFor: async (action) =>
        policy.requirementFor({ name: action, kind: 'action' }, input.actor, {
          threadId: input.threadId,
          runId,
          ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        }),
      modelLabel: input.model ?? 'opencode',
      onGranted: (action, id) => {
        const grants = this.grants.get(runId) ?? [];
        grants.push({ action, id });
        this.grants.set(runId, grants);
      },
    });
    const stop = await this.events.listen(server.key, server.client, handle.sessionId, (event) =>
      turn.handle(event),
    );
    const live: LiveTurn = { turn, input, handle, client: server.client, stop };
    this.live.set(runId, live);
    if (catchUp && current === undefined) await turn.catchUp().catch(() => undefined);
    return live;
  }

  /** Stop following a run in this process. */
  drop(runId: string): void {
    this.live.get(runId)?.stop();
    this.live.delete(runId);
  }

  // ---- settle ----------------------------------------------------------------------------------

  /** A person was asked something: tell the host (cards in other channels, wake-ups). */
  private async reached(
    runId: string,
    input: AgentRunInput,
    handle: SessionHandle,
    milestone: Milestone,
  ): Promise<Milestone> {
    if (milestone.kind === 'ask' && this.host.onAsk !== undefined) {
      try {
        await this.host.onAsk({ input, runId, sessionId: handle.sessionId, ask: milestone.ask });
      } catch (error) {
        openCodeLog.warn(`onAsk failed: ${errorText(error, 'error')}`);
      }
    }
    return milestone;
  }

  /** What the run produced, as the host's settle hooks see it. */
  private async runResult(
    runId: string,
    input: AgentRunInput,
    outcome: TurnOutcome,
    durationMs: number,
  ): Promise<OpenCodeRunResult> {
    const thread = await this.store.getThread(input.threadId);
    const messages = (thread?.messages ?? []).filter(
      (m) => m.role === 'assistant' && m.runId === runId,
    );
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    for (const m of messages) {
      usage.inputTokens += m.usage?.inputTokens ?? 0;
      usage.outputTokens += m.usage?.outputTokens ?? 0;
      usage.costUsd += m.usage?.costUsd ?? 0;
    }
    return {
      runId,
      input,
      outcome,
      text: messages
        .map((m) => m.content)
        .filter(Boolean)
        .join('\n\n'),
      messages,
      usage,
      durationMs,
    };
  }

  /**
   * The host's last word on the answer before the stream ends: components to append (a guardrail
   * notice), or, for a failed run, the error the person reads instead of OpenCode's.
   */
  private async amend(writer: SinkWriter, result: OpenCodeRunResult): Promise<OpenCodeAmendment> {
    if (this.host.beforeSettle === undefined) return {};
    let amendment: OpenCodeAmendment = {};
    try {
      amendment = (await this.host.beforeSettle(result)) ?? {};
    } catch (error) {
      openCodeLog.warn(`beforeSettle failed: ${errorText(error, 'error')}`);
    }
    const ui = amendment.ui ?? [];
    const last = result.messages.at(-1);
    if (ui.length > 0) {
      for (const component of ui) {
        await writer.write({ t: 'event', event: { kind: 'ui', ...component } });
      }
      if (last !== undefined) await this.store.setMessageUi?.(last.id, [...(last.ui ?? []), ...ui]);
    }
    return amendment;
  }

  /** Delivery, telemetry, spend: after the run settled. Errors are the host's, never the run's. */
  private async settled(result: OpenCodeRunResult): Promise<void> {
    try {
      await this.host.onSettled?.(result);
    } catch (error) {
      openCodeLog.warn(`onSettled failed: ${errorText(error, 'error')}`);
    }
  }

  private forget(runId: string): void {
    this.drop(runId);
    for (const grant of this.grants.get(runId) ?? []) this.spent.delete(grant.id);
    this.grants.delete(runId);
  }

  /** End the run's stream and bookkeeping for how its execution ended. */
  async settle(
    runId: string,
    input: AgentRunInput,
    outcome: TurnOutcome,
    durationMs: number,
  ): Promise<void> {
    if (outcome.status === 'failed') {
      await this.settleFailed(runId, input, outcome.error, durationMs);
      return;
    }
    const totals = this.live.get(runId)?.turn.totals();
    this.forget(runId);
    const writer = await this.sink.open(runId);
    const result = await this.runResult(runId, input, outcome, durationMs);
    await this.amend(writer, result);
    if (outcome.status === 'interrupted') {
      await this.store.recordRunEnd({ runId, status: 'cancelled' });
      await Promise.resolve(
        this.store.failUnsettledToolCalls?.(runId, RUN_ENDED_BEFORE_TOOL_CALL),
      ).catch(() => 0);
      await this.handoff(writer, input, runId, 'cancelled');
      await releaseThreadRun(this.store, input.threadId, runId);
      await writer.write({ t: 'event', event: { kind: 'cancelled' } });
      await writer.end();
    } else {
      await this.store.recordRunEnd({
        runId,
        status: 'completed',
        finishedAt: Date.now(),
        stepCount: totals?.steps ?? 0,
        inputTokens: totals?.inputTokens ?? result.usage.inputTokens,
        outputTokens: totals?.outputTokens ?? result.usage.outputTokens,
        ...(totals?.costUsd !== undefined ? { costUsd: totals.costUsd } : {}),
      });
      await this.handoff(writer, input, runId, 'completed');
      await releaseThreadRun(this.store, input.threadId, runId);
      await writer.end();
    }
    await this.settled(result);
  }

  async settleFailed(
    runId: string,
    input: AgentRunInput,
    error: string,
    durationMs = 0,
  ): Promise<void> {
    this.forget(runId);
    const writer = await this.sink.open(runId);
    const result = await this.runResult(runId, input, { status: 'failed', error }, durationMs);
    const worded = (await this.amend(writer, result)).error;
    await this.store.recordRunEnd({ runId, status: 'failed', error });
    await Promise.resolve(
      this.store.failUnsettledToolCalls?.(runId, RUN_ENDED_BEFORE_TOOL_CALL),
    ).catch(() => 0);
    await this.handoff(writer, input, runId, 'failed', error);
    await releaseThreadRun(this.store, input.threadId, runId);
    // The host's wording is for the person and shown as is; OpenCode's own error follows the
    // library's rule (shown outside production, logged everywhere).
    await writer.write(
      worded !== undefined
        ? { t: 'error', code: 'run_failed', message: worded }
        : streamErrorFrame(new Error(error), runId),
    );
    await writer.end();
    await this.settled({ ...result, outcome: { status: 'failed', error: worded ?? error } });
  }

  /** As `InlineAgentRunner`: hand the thread to its next queued message, and say so on the stream. */
  private async handoff(
    writer: SinkWriter,
    input: AgentRunInput,
    runId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    error?: string,
  ): Promise<void> {
    const queue = this.queue;
    const startNext = this.startNext;
    if (queue === undefined || !queue.supported || startNext === undefined) return;
    if (!isThreadTurn(input)) return;
    try {
      const frame = await queue.handoff(
        { threadId: input.threadId, runId, outcome, ...(error !== undefined ? { error } : {}) },
        (next, nextRunId) => startNext(next, nextRunId),
      );
      if (frame !== undefined) await writer.write({ t: 'event', event: frame });
    } catch (failure) {
      openCodeLog.error(
        `could not advance the queue of thread ${input.threadId} after run ${runId}: ${errorText(failure, 'error')}`,
      );
    }
  }
}

/** The persona a turn names (an id, or the whole definition a direct caller handed over). */
function personaOf(deps: AgentDeps, persona: AgentRunInput['persona']): Persona | undefined {
  if (persona === undefined) return undefined;
  return typeof persona === 'string' ? deps.personas.get(persona) : persona;
}

function titleOf(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed || 'New chat';
}

function transcriptOf(messages: StoredMessage[], limit: number): string {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .slice(-limit)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`)
    .join('\n');
}

/** The `_meta` key OpenCode names its session with on every MCP call. */
export const SESSION_META_KEY = 'ai.opencode/sessionID';

function sessionOfMeta(meta: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const value = meta?.[SESSION_META_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `ctx.emitUi` over `push`, with the library's id and snapshot rules. */
function uiEmitter(
  scope: string,
  push: (component: AgentUiComponent) => Promise<void>,
): AiToolCtx['emitUi'] {
  let next = 0;
  return async (component, props, options = {}) => {
    if (typeof component !== 'string' || component.length === 0) {
      throw new Error('emitUi: component must be a non-empty string');
    }
    if (typeof props !== 'object' || props === null || Array.isArray(props)) {
      throw new Error('emitUi: props must be a JSON object');
    }
    const id = options.id ?? `${scope}:ui:${next++}`;
    await push({
      id,
      component,
      props: JSON.parse(JSON.stringify(props)) as Record<string, unknown>,
      ...(options.version !== undefined ? { version: options.version } : {}),
      ...(options.fallbackText !== undefined ? { fallbackText: options.fallbackText } : {}),
    });
    return { id };
  };
}
