import { describe, expect, it } from 'vitest';
import { mcpInputSchema } from '../src/mcp-client/tool-input.js';

const weatherSchema = {
  type: 'object',
  properties: {
    city: { type: 'string' },
    units: { enum: ['c', 'f'] },
  },
  required: ['city'],
  additionalProperties: false,
} as const;

async function validate(schema: Record<string, unknown>, input: unknown) {
  return mcpInputSchema(schema)['~standard'].validate(input);
}

describe('mcpInputSchema', () => {
  it('accepts a conforming input and hands the parsed value on', async () => {
    const result = await validate({ ...weatherSchema }, { city: 'Lisbon', units: 'c' });
    expect(result.issues).toBeUndefined();
    expect(result.issues === undefined ? result.value : undefined).toEqual({
      city: 'Lisbon',
      units: 'c',
    });
  });

  it("enforces the server's required properties", async () => {
    const result = await validate({ ...weatherSchema }, { units: 'c' });
    expect(result.issues?.[0]?.message).toContain('city');
  });

  it("enforces the server's types, enums and additionalProperties", async () => {
    const result = await validate({ ...weatherSchema }, { city: 12, units: 'kelvin', rogue: true });
    const message = result.issues?.[0]?.message ?? '';
    expect(message).toContain('must be string');
    expect(message).toContain('allowed values');
    expect(message).toContain('additional properties');
  });

  it('validates a draft-2020-12 schema, which the server may declare', async () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { n: { type: 'integer', minimum: 1 } },
      required: ['n'],
    };
    expect((await validate(schema, { n: 3 })).issues).toBeUndefined();
    expect((await validate(schema, { n: 0 })).issues).toBeDefined();
    expect((await validate(schema, { n: 'three' })).issues).toBeDefined();
  });

  it("exposes the server's JSON Schema so the model sees the real parameter shapes", () => {
    const schema = mcpInputSchema({ ...weatherSchema });
    expect(schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toEqual(
      weatherSchema,
    );
  });

  it('throws for a schema it cannot compile, rather than returning one that accepts anything', () => {
    expect(() =>
      mcpInputSchema({ type: 'object', properties: { a: { $ref: '#/definitions/missing' } } }),
    ).toThrow();
  });

  it('refuses a pattern that can backtrack exponentially, as it refuses one that will not compile', () => {
    expect(() =>
      mcpInputSchema({ type: 'object', properties: { s: { type: 'string', pattern: '(a+)+$' } } }),
    ).toThrow('(a+)+$');
  });

  it('compiles a schema whose patterns are the kind real servers publish', () => {
    expect(() =>
      mcpInputSchema({
        type: 'object',
        properties: {
          slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
          path: { type: 'string', pattern: '[^/]+(/[^/]+)*' },
        },
      }),
    ).not.toThrow();
  });

  it('is why the screen exists: the same pattern, admitted, stalls this thread on 24 characters', () => {
    const schema = mcpInputSchema(
      { type: 'object', properties: { s: { type: 'string', pattern: '(a+)+$' } } },
      { rejectUnsafePatterns: false },
    );

    const started = performance.now();
    schema['~standard'].validate({ s: `${'a'.repeat(23)}!` });

    expect(performance.now() - started).toBeGreaterThan(100);
  });
});
