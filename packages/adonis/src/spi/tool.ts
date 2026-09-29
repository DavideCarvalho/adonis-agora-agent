import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Actor, PageContext, Persona } from '../types.js';

/**
 * Per-invocation context handed to a tool handler. Host-supplied bits are optional. Identity lives
 * on {@link AiToolCtx.actor} — read `ctx.actor.id` / `ctx.actor.tenantRef` (single source of truth;
 * no denormalized copies).
 */
export interface AiToolCtx {
  actor: Actor;
  threadId: string;
  runId: string;
  requestId: string;
  persona?: Persona;
  /** The agent running the turn, when it has a name. */
  agentName?: string;
  pageContext?: PageContext;
  /** Optional host handle (e.g. an ORM EntityManager) the app threads through options. */
  host?: unknown;
  /**
   * Pushes a UI component into the run's stream at the current position (between the text
   * tokens already emitted and the ones still to come). Optional: only the agent-loop's own
   * assembly provides it; other ctx builders may omit it.
   */
  emitComponent?(name: string, data: unknown): void | Promise<void>;
  /**
   * Push a component into the conversation: streamed at once as a `ui` frame (a `component` frame
   * under the legacy envelope) and persisted on the assistant message once the step's tools settle,
   * so a reload shows it where the live stream did. `id` defaults to `<toolCallId>:ui:<n>`; pushing
   * an `id` again replaces that component. `props` must be JSON. Always present — outside a
   * conversation (an MCP call) it accepts the push and does nothing, so a tool never has to branch.
   */
  emitUi(
    component: string,
    props: Record<string, unknown>,
    options?: { id?: string; version?: number },
  ): Promise<{ id: string }>;
}

/**
 * A tool implementation. `I` is the parsed (Zod-validated) input; `O` is what `execute` returns
 * (serialized back to the model). `O` defaults to `unknown` — so `ToolHandler<I>` keeps working —
 * but typing it lets the compiler check the return against what the tool promises.
 */
export interface ToolHandler<I = unknown, O = unknown> {
  execute(input: I, ctx: AiToolCtx): Promise<O> | O;
  /**
   * What the model is told about this tool for THIS turn — a description and/or input schema that
   * depend on who is asking (a per-tenant component catalog, a per-plan list of options). Called
   * when the turn's tool list is built, after every gate has passed; whatever it returns replaces
   * the registered spec's `description` / `inputSchema` in the definition the model sees. Omit, or
   * return `undefined`, to use the registered spec as is.
   *
   * It shapes what the model is SHOWN only: the registry still validates a call against the
   * registered `inputSchema`, so a tool whose accepted input varies per turn registers a permissive
   * schema and validates in `execute`.
   */
  describe?(
    scope: ToolDescribeScope,
  ): ToolDescription | undefined | Promise<ToolDescription | undefined>;
}

/** Who a turn's tool list is being built for — what {@link ToolHandler.describe} can vary on. */
export interface ToolDescribeScope {
  actor: Actor;
  /** Absent where the list is built outside a conversation (the MCP server's `tools/list`). */
  threadId?: string;
  agentName?: string;
}

/** A per-turn override of a tool's model-facing definition ({@link ToolHandler.describe}). */
export interface ToolDescription {
  description?: string;
  inputSchema?: StandardSchemaV1;
}
