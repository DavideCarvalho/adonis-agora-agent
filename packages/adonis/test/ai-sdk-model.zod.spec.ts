import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { JSONSchema7 } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { aiSdkModel } from '../src/ai-sdk/ai-sdk-model.js';
import type { SinkWriter, ToolDefinition } from '../src/index.js';

// A genuine end-to-end run: no mocking of the `ai` module. We drive the real `streamText` with a
// mock model that records exactly the tool JSON schema the SDK derived from each tool's Standard
// Schema — the thing the real model would see. This proves a real Zod schema reaches the model as
// its true parameter shapes rather than being flattened to a permissive object.

function createSink(): SinkWriter {
  return { write() {}, end() {} };
}

/**
 * The stream-part type the mock model must emit, derived from the SDK's own `doStream` contract so it
 * cannot drift — and without importing `@ai-sdk/provider` (not a dependency of this package). Without
 * the annotation the chunk array widens to a union of literal shapes padded with `?: never` members,
 * which is not assignable to the SDK's stream-part union.
 */
type StreamChunk =
  Awaited<ReturnType<MockLanguageModelV3['doStream']>> extends {
    stream: ReadableStream<infer C>;
  }
    ? C
    : never;

function recordingModel(): MockLanguageModelV3 {
  const chunks: StreamChunk[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: 'ok' },
    { type: 'text-end', id: '1' },
    {
      type: 'finish',
      // `LanguageModelV3FinishReason` is an object (`{ unified, raw }`) and `LanguageModelV3Usage`
      // nests the token counts — the bare `'stop'` string and the flat `{ inputTokens, outputTokens,
      // totalTokens }` form both predate the v3 provider spec. Values are incidental scaffolding:
      // this spec asserts only the tool JSON schemas the SDK hands the model.
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
  });
}

/** The JSON schema the SDK handed the model for `toolName`, dug out of the recorded call. */
function schemaSeenByModel(model: MockLanguageModelV3, toolName: string): JSONSchema7 {
  const tools = model.doStreamCalls[0]?.tools ?? [];
  const match = tools.find((entry) => entry.type === 'function' && entry.name === toolName);
  if (match?.type !== 'function') {
    throw new Error(`tool ${toolName} was not passed to the model`);
  }
  return match.inputSchema;
}

async function runWith(tools: ToolDefinition[]): Promise<MockLanguageModelV3> {
  const model = recordingModel();
  await aiSdkModel(model).runTurn({
    system: '',
    messages: [{ role: 'user', content: 'go' }],
    tools,
    sink: createSink(),
  });
  return model;
}

describe('aiSdkModel — Standard Schema → model params (real SDK)', () => {
  it('derives the real parameter shapes from a Zod tool schema', async () => {
    const tool: ToolDefinition = {
      name: 'getWeather',
      kind: 'read',
      description: 'weather',
      inputSchema: z.object({ city: z.string(), units: z.enum(['c', 'f']).optional() }),
    };

    const schema = schemaSeenByModel(await runWith([tool]), 'getWeather');

    // The model sees the true shape — not the permissive `{ additionalProperties: true }` fallback.
    expect(schema.type).toBe('object');
    expect(schema.properties).toMatchObject({
      city: { type: 'string' },
      units: { type: 'string', enum: ['c', 'f'] },
    });
    expect(schema.required).toEqual(['city']);
  });

  it('derives real shapes from a schema that implements the Standard JSON Schema extension', async () => {
    const inputSchema: StandardSchemaV1 & StandardJSONSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'valibot-like',
        validate: (value: unknown) => ({ value }),
        // The camelCase `jsonSchema` converter the spec (and the SDK) actually read.
        jsonSchema: {
          input: () => ({
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
          }),
          output: () => ({ type: 'object', properties: { key: { type: 'string' } } }),
        },
      },
    };
    const tool: ToolDefinition = {
      name: 'lookup',
      kind: 'read',
      description: 'lookup',
      inputSchema,
    };

    const schema = schemaSeenByModel(await runWith([tool]), 'lookup');

    expect(schema.properties).toMatchObject({ key: { type: 'string' } });
    expect(schema.required).toEqual(['key']);
  });

  it('degrades a bare Standard Schema (no vendor, no extension) to a permissive object', async () => {
    const inputSchema: StandardSchemaV1 = {
      '~standard': { version: 1, vendor: 'custom', validate: (value: unknown) => ({ value }) },
    };
    const tool: ToolDefinition = { name: 'bare', kind: 'read', description: 'bare', inputSchema };

    const schema = schemaSeenByModel(await runWith([tool]), 'bare');

    // No throw, and the SDK receives a valid (if shapeless) object schema; the agent loop still
    // validates input against the real Standard Schema before running the tool.
    expect(schema).toMatchObject({ type: 'object', additionalProperties: true });
  });
});
