import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { DevToolInputProperty, DevToolInputSchema } from './contract.js';

const PROPERTY_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array']);
const PROPERTY_KEYS = new Set(['type', 'description', 'enum', 'items', 'minimum', 'maximum']);
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Check that `schema` stays inside the dev-tools JSON Schema subset. Returns the problem, or `null`.
 * The subset is what a console query string can carry: scalars, string enums and arrays of strings.
 */
export function schemaProblem(schema: unknown): string | null {
  if (typeof schema !== 'object' || schema === null) return 'input must be an object schema';
  const candidate = schema as Partial<DevToolInputSchema> & Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (key !== 'type' && key !== 'properties' && key !== 'required') {
      return `input has "${key}", which is outside the dev-tools schema subset`;
    }
  }
  if (candidate.type !== 'object') return 'input.type must be "object"';
  const properties = candidate.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return 'input.properties must be an object';
  }
  for (const [name, property] of Object.entries(properties)) {
    if (!PROPERTY_NAME.test(name)) return `property "${name}" is not a valid name`;
    const problem = propertyProblem(property);
    if (problem !== null) return `property "${name}": ${problem}`;
  }
  if (candidate.required !== undefined) {
    if (!Array.isArray(candidate.required)) return 'input.required must be an array';
    for (const name of candidate.required) {
      if (typeof name !== 'string' || !(name in properties)) {
        return `input.required names "${String(name)}", which is not a property`;
      }
    }
  }
  return null;
}

function propertyProblem(property: unknown): string | null {
  if (typeof property !== 'object' || property === null) return 'must be an object';
  const candidate = property as DevToolInputProperty & Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (!PROPERTY_KEYS.has(key)) return `"${key}" is outside the dev-tools schema subset`;
  }
  if (!PROPERTY_TYPES.has(candidate.type)) return `type "${String(candidate.type)}" is not allowed`;
  if (candidate.type === 'array') {
    if (candidate.items?.type !== 'string' || Object.keys(candidate.items).length !== 1) {
      return 'an array must declare items: { type: "string" }';
    }
  } else if (candidate.items !== undefined) {
    return '"items" only goes with type "array"';
  }
  if (candidate.enum !== undefined) {
    if (candidate.type !== 'string' && candidate.type !== 'array') {
      return '"enum" only goes with type "string" or "array"';
    }
    if (!Array.isArray(candidate.enum) || !candidate.enum.every((v) => typeof v === 'string')) {
      return '"enum" must be an array of strings';
    }
  }
  for (const bound of ['minimum', 'maximum'] as const) {
    if (candidate[bound] === undefined) continue;
    if (candidate.type !== 'number' && candidate.type !== 'integer') {
      return `"${bound}" only goes with type "number" or "integer"`;
    }
    if (typeof candidate[bound] !== 'number') return `"${bound}" must be a number`;
  }
  return null;
}

type Issue = StandardSchemaV1.Issue;

/** Validate `input` against a subset schema. Extra properties are rejected. */
export function validateDevToolInput(
  schema: DevToolInputSchema,
  input: unknown,
): { value: Record<string, unknown> } | { issues: Issue[] } {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { issues: [{ message: 'expected an object' }] };
  }
  const issues: Issue[] = [];
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(key in schema.properties)) {
      issues.push({ message: `unknown property "${key}"`, path: [key] });
    }
  }
  for (const name of schema.required ?? []) {
    if (record[name] === undefined) issues.push({ message: `"${name}" is required`, path: [name] });
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = record[name];
    if (value === undefined) continue;
    const message = valueProblem(property, value);
    if (message !== null) issues.push({ message: `"${name}" ${message}`, path: [name] });
  }
  return issues.length > 0 ? { issues } : { value: { ...record } };
}

function valueProblem(property: DevToolInputProperty, value: unknown): string | null {
  switch (property.type) {
    case 'string':
      if (typeof value !== 'string') return 'must be a string';
      if (property.enum !== undefined && !property.enum.includes(value)) {
        return `must be one of ${property.enum.join(', ')}`;
      }
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (property.type === 'integer' && !Number.isInteger(value)) return 'must be an integer';
      if (property.minimum !== undefined && value < property.minimum) {
        return `must be at least ${property.minimum}`;
      }
      if (property.maximum !== undefined && value > property.maximum) {
        return `must be at most ${property.maximum}`;
      }
      return null;
    }
    case 'array':
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return 'must be an array of strings';
      }
      if (property.enum !== undefined) {
        const allowed = property.enum;
        const bad = value.find((item) => !allowed.includes(item));
        if (bad !== undefined) return `has "${bad}", not one of ${allowed.join(', ')}`;
      }
      return null;
  }
}

/** The JSON Schema MCP clients see in `tools/list`: the subset, closed to extra properties. */
export function devToolJsonSchema(schema: DevToolInputSchema): Record<string, unknown> {
  return {
    type: 'object',
    properties: schema.properties,
    ...(schema.required !== undefined && schema.required.length > 0
      ? { required: schema.required }
      : {}),
    additionalProperties: false,
  };
}

/**
 * Wrap a subset schema as a Standard Schema, so the agent's `ToolRegistry` and MCP server serve it
 * unchanged: `validate` runs {@link validateDevToolInput}, and `jsonSchema.input()` is what
 * `tools/list` shows.
 */
export function devToolStandardSchema(schema: DevToolInputSchema): StandardSchemaV1<
  Record<string, unknown>
> & {
  '~standard': { jsonSchema: { input(): Record<string, unknown> } };
} {
  return {
    '~standard': {
      version: 1,
      vendor: 'agora-dev-tools',
      validate: (input: unknown) => validateDevToolInput(schema, input),
      jsonSchema: { input: () => devToolJsonSchema(schema) },
    },
  };
}
