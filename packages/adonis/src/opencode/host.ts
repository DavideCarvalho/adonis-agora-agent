import type { AgentUiComponent } from '../stream-events.js';
import type { Actor, AgentRunInput, StoredMessage } from '../types.js';
import type { OpenCodeClient, OpenCodePromptFile, OpenCodeSessionCreate } from './client.js';
import type { PendingAsk, TurnOutcome } from './turn.js';

/**
 * Where a turn runs and how its OpenCode session is set up — the part only the host knows. The
 * engine owns everything between the library and OpenCode (sessions per thread, the event stream,
 * the turn's frames, approvals and questions, cancel); the host answers these questions.
 *
 * Every method is called as a method of the host (`host.onSettled(…)`), so a class host can read
 * its own services off `this`.
 */
export interface OpenCodeHost {
  /**
   * The OpenCode server this actor's turns run on — one per tenant in a sandbox, one for the whole
   * deployment, anything. Asked once per turn, so a server that restarted is picked up.
   */
  server(actor: Actor): Promise<OpenCodeServer>;

  /**
   * How to create a session for a thread: location, model, OpenCode agent, permission rules.
   * Asked only when the thread has no live session on this server (its first turn, or the server
   * restarted since). `input.model` is the model the caller picked for this turn, when it picked one.
   */
  session(context: OpenCodeTurnContext): Promise<OpenCodeSessionCreate>;

  /**
   * Instructions entries refreshed on every turn (key → text), on top of the agent's own prompt
   * (its `systemPrompt` and persona, under `agora.system`). Profile, the project a chat is about…
   * An entry that disappears is not cleared: put an empty value to drop it.
   */
  instructions?(
    context: OpenCodeTurnContext & { sessionId: string },
  ): Promise<Record<string, string>>;

  /**
   * What the session is prompted with, when it is more than the user message: documents read into
   * the text, images as files the model can see. Omit → the user message, and `files`.
   */
  promptFor?(
    context: OpenCodeTurnContext & { sessionId: string },
  ): Promise<{ text: string; files?: OpenCodePromptFile[] }>;

  /**
   * The user message's attachments (`input.attachments`) in the form `session.prompt` takes them.
   * Omit → attachments are not sent to OpenCode. Not asked when `promptFor` answers.
   */
  files?(context: OpenCodeTurnContext): Promise<OpenCodePromptFile[]>;

  /**
   * Anything else to do on a NEW session before its first prompt — register MCP servers of your own
   * (`client.mcp.add`), write files… Runs right after `session` and before `instructions`.
   */
  prepare?(
    context: OpenCodeTurnContext & { sessionId: string; client: OpenCodeClient },
  ): Promise<void>;

  /**
   * `openCodeDurable()` only: the turn's workflow start options (tags, search attributes, a
   * concurrency quota) — like `durable.start` in the engine's options, from a host with services.
   */
  startOptions?(input: AgentRunInput, runId: string): Promise<Record<string, unknown>>;

  /** `openCodeDurable()` only: what a refused start becomes (e.g. a concurrency limit → a 429). */
  startError?(error: unknown, input: AgentRunInput): unknown;

  /**
   * May this turn keep the thread's session? Asked when the session is still on its server; `false`
   * opens a new one (told the conversation so far) — e.g. the person the session's tools act for
   * changed. Omit → always reuse.
   */
  reuse?(context: OpenCodeTurnContext & { session: OpenCodeSessionRef }): Promise<boolean>;

  /**
   * Every turn, once the session is known (`created`: opened for this turn) and before the prompt:
   * bring it up to date — the turn's model, permission rules that changed, tools.
   */
  beforePrompt?(
    context: OpenCodeTurnContext & { sessionId: string; client: OpenCodeClient; created: boolean },
  ): Promise<void>;

  /**
   * A person was asked something (an approval or a question form): post it where else they are —
   * a Slack thread, a Teams chat — or wake whoever waits on the run. May run again for the same ask
   * after a restart: make it idempotent. Errors are logged, never the run's.
   */
  onAsk?(context: OpenCodeTurnContext & { sessionId: string; ask: PendingAsk }): Promise<void>;

  /** A tool pushed a component into the run (`ctx.emitUi` over the engine's MCP endpoint). */
  onUi?(context: OpenCodeTurnContext & { component: AgentUiComponent }): Promise<void>;

  /**
   * The run is over and about to settle: the last word on the answer — components appended to it
   * (a guardrail notice), and for a failed run the error the person reads instead of OpenCode's.
   */
  beforeSettle?(result: OpenCodeRunResult): Promise<OpenCodeAmendment | undefined>;

  /**
   * The run settled (the stream ended, the thread moved on): deliver the answer elsewhere, record
   * spend and telemetry. Errors are logged, never the run's.
   */
  onSettled?(result: OpenCodeRunResult): Promise<void>;
}

/** What a run produced, as the host's settle hooks see it. */
export interface OpenCodeRunResult {
  runId: string;
  input: AgentRunInput;
  outcome: TurnOutcome;
  /** The run's answer: its assistant messages' text, in order. */
  text: string;
  /** The run's assistant messages, as stored. */
  messages: StoredMessage[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  durationMs: number;
}

/** See {@link OpenCodeHost.beforeSettle}. */
export interface OpenCodeAmendment {
  ui?: AgentUiComponent[];
  /** For a failed run: what the person reads. */
  error?: string;
}

export interface OpenCodeServer {
  client: OpenCodeClient;
  /** Identifies the server across turns; sessions are only reused on the server that holds them. */
  key: string;
  /**
   * Changes whenever the server restarts and loses its sessions (a sandbox boot id). Omit for a
   * server whose sessions outlive restarts.
   */
  bootId?: string;
}

export interface OpenCodeTurnContext {
  input: AgentRunInput;
  runId: string;
}

/** The session a thread talks to, and where it lives. */
export interface OpenCodeSessionRef {
  sessionId: string;
  serverKey: string;
  bootId?: string;
  /** The session's directory (`location.directory`), when it has one. */
  directory?: string;
  /**
   * The agent (and persona id) the thread's latest turn ran as — what the tools endpoint checks a
   * call against when it lands on a process that is not following the turn.
   */
  agentName?: string;
  persona?: string;
}

/**
 * Which OpenCode session each thread uses. The default keeps it in memory, which is enough for one
 * process; a deployment with several replicas (or that wants sessions to survive a restart of its
 * own) persists it — on the thread row, or in Redis with {@link keyValueOpenCodeSessionStore}.
 */
export interface OpenCodeSessionStore {
  get(threadId: string): Promise<OpenCodeSessionRef | null>;
  set(threadId: string, ref: OpenCodeSessionRef): Promise<void>;
}

export class InMemoryOpenCodeSessionStore implements OpenCodeSessionStore {
  private readonly refs = new Map<string, OpenCodeSessionRef>();

  async get(threadId: string): Promise<OpenCodeSessionRef | null> {
    return this.refs.get(threadId) ?? null;
  }

  async set(threadId: string, ref: OpenCodeSessionRef): Promise<void> {
    this.refs.set(threadId, ref);
  }
}

/** The two calls of a key-value store a session store needs — an ioredis client (`@adonisjs/redis`) fits. */
export interface OpenCodeKeyValue {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<unknown>;
}

/**
 * Sessions kept in a shared key-value store (Redis…), so every process of a deployment finds the
 * session a thread already has — what running more than one process needs, alongside a
 * cross-process sink (`tokenSinks.redis()` / `tokenSinks.lucid()`). Keys are `<prefix><threadId>`.
 */
export function keyValueOpenCodeSessionStore(
  kv: OpenCodeKeyValue,
  prefix = 'agora:opencode:session:',
): OpenCodeSessionStore {
  return {
    async get(threadId) {
      const raw = await kv.get(`${prefix}${threadId}`);
      if (raw === null || raw === undefined) return null;
      try {
        const ref = JSON.parse(raw) as OpenCodeSessionRef;
        return typeof ref.sessionId === 'string' && typeof ref.serverKey === 'string' ? ref : null;
      } catch {
        return null;
      }
    },
    async set(threadId, ref) {
      await kv.set(`${prefix}${threadId}`, JSON.stringify(ref));
    },
  };
}
