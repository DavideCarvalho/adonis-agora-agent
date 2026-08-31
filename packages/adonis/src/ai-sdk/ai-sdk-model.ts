import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import {
  type AssistantContent,
  type CallSettings,
  type Experimental_DownloadFunction,
  type FilePart,
  type FlexibleSchema,
  type ImagePart,
  type JSONValue,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ProviderMetadata,
  type ModelMessage as SdkModelMessage,
  streamText,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
  type TypedToolCall,
  tool,
} from 'ai';
import type { ZodTypeAny } from 'zod';
import type {
  MessageAttachment,
  MessageUsage,
  ModelMessage,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
  ToolCallRequest,
  ToolDefinition,
  ToolResult,
} from '../index.js';

/**
 * Pass-through settings forwarded to the AI SDK `streamText` call (headers, temperature,
 * `maxOutputTokens`, `providerOptions`, …). `model`, `instructions`, `messages`, `tools`, and
 * `abortSignal` are owned by the adapter and always win over anything set here.
 */
export type AiSdkModelOptions = CallSettings & {
  /**
   * Override the AI SDK's file/attachment downloader (`experimental_download` on `streamText`).
   * The SDK's DEFAULT downloader refuses localhost/private hostnames (SSRF guard), which breaks
   * attachment parts whose staging presigns against a local object store (e.g. MinIO in dev) —
   * the model call dies with `AI_DownloadError: URL with hostname localhost is not allowed`.
   * Attachment URLs come from the host's own staging SPI — never from user input — so relaxing
   * the guard with a plain fetch is the host's legitimate call. Pair with the ready-made
   * {@link import('./attachment-fetch-downloader.js').attachmentFetchDownloader}.
   */
  experimental_download?: Experimental_DownloadFunction;
};

/**
 * Adapt a Vercel AI SDK v7 `LanguageModel` to the core `ModelProvider` SPI so a host app writes
 * zero provider code. Streams text deltas to `args.sink`, returns the assembled text, requested
 * tool calls, usage, and (when a gateway reports it) the real USD cost. It never executes tools —
 * tools are handed to the SDK WITHOUT an `execute` fn, so the SDK returns tool-calls for the agent
 * loop to run as its own (replay-safe) steps.
 */
export function aiSdkModel(model: LanguageModel, opts?: AiSdkModelOptions): ModelProvider {
  return {
    async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
      const result = streamText({
        ...opts,
        model,
        instructions: args.system,
        messages: mapMessages(args.messages),
        tools: mapTools(args.tools),
        ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      });

      let text = '';
      for await (const part of result.stream) {
        if (part.type === 'text-delta') {
          text += part.text;
          await args.sink.write({ t: 'text', v: part.text });
        }
      }

      // The promise accessors resolve once the stream is fully consumed above. `modelId` and the
      // reported cost live on the final step (the top-level aliases are deprecated in AI SDK v7).
      const [toolCalls, usage, finalStep] = await Promise.all([
        result.toolCalls,
        result.usage,
        result.finalStep,
      ]);

      const modelId = finalStep.response.modelId;
      const costUsd = extractCostUsd(finalStep.providerMetadata);

      return {
        text,
        toolCalls: toolCalls.map(mapToolCall),
        usage: mapUsage(usage),
        ...(typeof modelId === 'string' && modelId.length > 0 ? { modelId } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    },
  };
}

/**
 * Map core `ModelMessage[]` → SDK messages. Tool calls ride on the assistant message as
 * `tool-call` content parts; tool results become a following `tool` message. A message can
 * therefore expand into two SDK messages, so we build the list imperatively.
 */
function mapMessages(messages: ModelMessage[]): SdkModelMessage[] {
  const out: SdkModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.content });
      continue;
    }
    if (message.role === 'user') {
      const toolResults = message.toolResults ?? [];
      // A pure tool-result carrier (`{ content: '', toolResults }`, pushed by the agent loop to
      // feed results back to the model) must NOT also emit an empty user turn — the SDK requires
      // the `tool` message to immediately follow the assistant `tool-call` message, and a wedged
      // empty user message in between breaks that adjacency (`AI_MissingToolResultsError`).
      if (message.content.length > 0 || toolResults.length === 0) {
        const attachments = message.attachments ?? [];
        out.push(
          attachments.length === 0
            ? { role: 'user', content: message.content }
            : { role: 'user', content: userContentWithAttachments(message.content, attachments) },
        );
      }
      pushToolResults(out, toolResults);
      continue;
    }

    const toolCalls = message.toolCalls ?? [];
    if (toolCalls.length > 0) {
      const content: Array<TextPart | ToolCallPart> = [];
      if (message.content.length > 0) {
        content.push({ type: 'text', text: message.content });
      }
      for (const call of toolCalls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        });
      }
      out.push({ role: 'assistant', content: assistantContent(content) });
    } else {
      out.push({ role: 'assistant', content: message.content });
    }

    pushToolResults(out, message.toolResults ?? []);
  }
  return out;
}

/**
 * Append a `tool` message mapping each core `ToolResult` to an SDK `ToolResultPart`, when there
 * are any. Shared by the assistant branch (tool results following its own tool-calls) and the
 * user branch (the agent loop's `{ role: 'user', content: '', toolResults }` carrier) so both
 * faithfully surface results to the SDK instead of silently dropping them.
 */
function pushToolResults(out: SdkModelMessage[], toolResults: ToolResult[]): void {
  if (toolResults.length === 0) {
    return;
  }
  out.push({
    role: 'tool',
    content: toolResults.map(
      (result): ToolResultPart => ({
        type: 'tool-result',
        toolCallId: result.id,
        toolName: result.name,
        output: toModelOutput(result),
      }),
    ),
  });
}

/** `Array<TextPart | ToolCallPart>` is a valid `AssistantContent`; name the widening explicitly. */
function assistantContent(parts: Array<TextPart | ToolCallPart>): AssistantContent {
  return parts;
}

/**
 * Build a multimodal user content array: the text (when non-empty) followed by one part per
 * attachment — `image/*` → an image part, everything else → a file part (Bedrock Claude reads a PDF
 * this way). The attachment's `url` is passed straight through as the part's source; making it
 * reachable by the provider is the consumer's concern (the staging SPI's job), not the adapter's.
 */
function userContentWithAttachments(
  text: string,
  attachments: MessageAttachment[],
): Array<TextPart | ImagePart | FilePart> {
  const parts: Array<TextPart | ImagePart | FilePart> = [];
  if (text.length > 0) {
    parts.push({ type: 'text', text });
  }
  for (const attachment of attachments) {
    parts.push(
      attachment.contentType.startsWith('image/')
        ? { type: 'image', image: new URL(attachment.url), mediaType: attachment.contentType }
        : {
            type: 'file',
            data: new URL(attachment.url),
            mediaType: attachment.contentType,
            filename: attachment.name,
          },
    );
  }
  return parts;
}

/**
 * NOTE: core tool `output` is `unknown`, but the SDK's structured `json` output demands a
 * `JSONValue`. Rather than an unsafe cast we serialise every result to text — the model reads
 * tool output as text regardless, and the loop already validated the tool INPUT via the schema.
 */
function toModelOutput(result: ToolResult): { type: 'text'; value: string } {
  if (result.error !== undefined) {
    return { type: 'text', value: result.error };
  }
  const { output } = result;
  if (typeof output === 'string') {
    return { type: 'text', value: output };
  }
  return { type: 'text', value: JSON.stringify(output ?? null) };
}

/**
 * Map core `ToolDefinition[]` → an SDK `ToolSet`. Each tool is built WITHOUT an `execute` fn so the
 * SDK surfaces the tool-call for the agent loop to run, instead of executing it inline.
 */
function mapTools(tools: ToolDefinition[]): ToolSet {
  const set: ToolSet = {};
  for (const definition of tools) {
    set[definition.name] = tool({
      description: definition.description,
      inputSchema: toSdkInputSchema(definition.inputSchema),
    });
  }
  return set;
}

/**
 * Convert a core `StandardSchemaV1` into the schema the SDK feeds the model as tool parameters.
 * The SDK's own `asSchema` derives a precise JSON schema from exactly two kinds of Standard Schema,
 * so we hand those straight through and let it do the conversion:
 *
 *  - **Zod** (`~standard.vendor === 'zod'`) — the SDK runs zod-to-json-schema natively. Zod 3 does
 *    NOT expose the Standard JSON Schema extension, so this vendor tag is the only way to recognise
 *    it, and it's the common case (`@AiTool({ input: z.object(...) })`).
 *  - **Standard JSON Schema** (`~standard.jsonSchema`) — Valibot, ArkType, and Zod 4 implement the
 *    extension; the SDK calls its `input()` converter to derive the schema.
 *
 * Anything else is a bare Standard Schema the SDK can't introspect (its `asSchema` throws on one), so
 * we degrade to a permissive object schema — the model loses the parameter shapes, but the agent loop
 * still validates the tool input against the real schema via `~standard.validate` before running it.
 */
function toSdkInputSchema(schema: StandardSchemaV1): FlexibleSchema<unknown> {
  if (isZodSchema(schema) || hasStandardJsonSchema(schema)) {
    return schema;
  }
  return jsonSchema({ type: 'object', properties: {}, additionalProperties: true });
}

/**
 * True for a Zod schema. Zod tags its Standard Schema props with `vendor: 'zod'`, and its own type
 * declares `~standard`, so this narrows to `ZodTypeAny` — a member of the SDK's `FlexibleSchema` —
 * without a cast, letting the SDK convert it natively.
 */
function isZodSchema(schema: StandardSchemaV1): schema is ZodTypeAny {
  return schema['~standard'].vendor === 'zod';
}

/** True when the schema carries the Standard JSON Schema converter (`~standard.jsonSchema.input`). */
function hasStandardJsonSchema(
  schema: StandardSchemaV1,
): schema is StandardSchemaV1 & StandardJSONSchemaV1 {
  const standard = schema['~standard'];
  if (!('jsonSchema' in standard)) {
    return false;
  }
  const converter = standard.jsonSchema;
  return (
    typeof converter === 'object' &&
    converter !== null &&
    'input' in converter &&
    typeof converter.input === 'function'
  );
}

function mapToolCall(call: TypedToolCall<ToolSet>): ToolCallRequest {
  return { id: call.toolCallId, name: call.toolName, input: call.input };
}

/**
 * Map SDK usage → core `MessageUsage`. Cache/reasoning breakdowns are optional and only added when
 * the provider reports them (conditional spread, never an `undefined` assignment). AI SDK v7 carries
 * them on the `*Details` objects; the deprecated flat aliases (`cachedInputTokens`, `reasoningTokens`)
 * were removed.
 */
function mapUsage(usage: LanguageModelUsage): MessageUsage {
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/**
 * A gateway reports the ACTUAL spend for the turn; a direct provider (Anthropic/OpenAI/Bedrock)
 * doesn't, leaving this undefined so the governance read-model estimates from tokens. We read the
 * Vercel AI Gateway shape (`gateway.cost`) first, then OpenRouter (`openrouter.total_cost`, also
 * nested under `openrouter.usage.total_cost`).
 */
function extractCostUsd(metadata: ProviderMetadata | undefined): number | undefined {
  if (!metadata) {
    return undefined;
  }
  const gateway = metadata.gateway;
  const gatewayCost = gateway ? toFiniteNumber(gateway.cost) : undefined;
  if (gatewayCost !== undefined) {
    return gatewayCost;
  }
  const openrouter = metadata.openrouter;
  if (openrouter) {
    const direct = toFiniteNumber(openrouter.total_cost);
    if (direct !== undefined) {
      return direct;
    }
    const usage = asJsonObject(openrouter.usage);
    if (usage) {
      const nested = toFiniteNumber(usage.total_cost);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

function toFiniteNumber(value: JSONValue | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asJsonObject(
  value: JSONValue | undefined,
): { [key: string]: JSONValue | undefined } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
