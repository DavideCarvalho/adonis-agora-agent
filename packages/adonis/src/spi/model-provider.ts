import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { MessageUsage, ModelMessage, ToolCallRequest, ToolDefinition } from '../types.js';
import type { SinkWriter } from './token-stream-sink.js';

export interface ModelTurnArgs {
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  /** The model writes streamed text deltas here as it generates them. */
  sink: SinkWriter;
  abortSignal?: AbortSignal;
  /**
   * Constrain this call's reply to a schema. Set only by the loop's structured-output formatting
   * pass, which is non-streamed and carries `tools: []` — most providers cannot serve a response
   * format and a tool set in the same request.
   *
   * An adapter that can constrain generation should, and report what it parsed as
   * {@link ModelTurnResult.object}. One that cannot may ignore it entirely: the loop validates the
   * reply either way, reading the JSON out of the text when no `object` comes back.
   */
  outputSchema?: StandardSchemaV1;
}

/** The outcome of ONE assistant turn. The loop — not the model — drives tool execution. */
export interface ModelTurnResult {
  text: string;
  toolCalls: ToolCallRequest[];
  usage: MessageUsage;
  /**
   * The model actually used this turn (e.g. `anthropic.claude-...`), recorded with usage for
   * cost accounting. When set it wins over the module's configured `modelId`, so the accounting
   * label can't silently drift from the runtime. Omit if the provider can't report one.
   */
  modelId?: string;
  /**
   * The ACTUAL USD cost of this turn, when the provider knows it — a gateway (Vercel AI Gateway
   * `providerMetadata.gateway.cost`, OpenRouter `total_cost`) reports real spend; a direct provider
   * (Anthropic/OpenAI/Bedrock) reports only tokens and leaves this undefined. When set, the
   * governance read-model uses it verbatim; otherwise it estimates from tokens × the pricing table.
   */
  costUsd?: number;
  /**
   * What the provider parsed out of a reply it constrained to {@link ModelTurnArgs.outputSchema}.
   * The loop VALIDATES it regardless — "the provider says it matched" is not the same claim as "it
   * matches", and a provider that ignored the schema has to fail where the failure is repairable.
   * Omit when the adapter did not constrain generation.
   */
  object?: unknown;
}

/**
 * Thin wrapper over the actual LLM. The concrete impl (e.g. Vercel AI SDK `streamText`
 * over Bedrock/Anthropic) lives in the host app or an adapter; core stays provider-free.
 *
 * Contract: `runTurn` performs exactly one model turn, streaming deltas to `args.sink`,
 * and returns the assembled text + requested tool calls + usage. It MUST NOT execute
 * tools — the agent loop runs each as a (durable) step for replay-safety.
 */
export interface ModelProvider {
  runTurn(args: ModelTurnArgs): Promise<ModelTurnResult>;
}
