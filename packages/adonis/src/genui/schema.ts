import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';

/** A JSON Schema document (draft-07 / 2020-12 subset). Plain data, so a catalog can be stored and shipped. */
export type JsonSchema = Record<string, unknown>;

/** One problem with a value, addressed by its path from the root of the value. */
export interface GenuiIssue {
  path: (string | number)[];
  message: string;
}

export type GenuiValidation<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; issues: GenuiIssue[] };

/**
 * Validates a value against a JSON Schema. The package ships {@link builtinJsonSchemaValidator} (a
 * dependency-free subset that covers what component props use); pass {@link ajvValidator} to a
 * catalog for full JSON Schema.
 */
export interface JsonSchemaValidator {
  validate(schema: JsonSchema, value: unknown): GenuiIssue[];
}

/** A component's props schema: any Standard Schema (Zod, Valibot, ArkType) or a JSON Schema object. */
export type PropsSchema = StandardSchemaV1 | JsonSchema;

export function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '~standard' in schema &&
    typeof (schema as StandardSchemaV1)['~standard']?.validate === 'function'
  );
}

/**
 * The JSON Schema a props schema presents to a model: the schema itself for a JSON Schema, the
 * Standard JSON Schema converter's output for a Standard Schema that has one (Zod 4, Valibot,
 * ArkType). `undefined` when neither is available (e.g. Zod 3) — the model then gets the
 * component's description only.
 */
export function toJsonSchema(schema: PropsSchema): JsonSchema | undefined {
  if (!isStandardSchema(schema)) {
    return schema;
  }
  const standard = schema['~standard'] as StandardSchemaV1['~standard'] &
    Partial<StandardJSONSchemaV1['~standard']>;
  const converter = standard.jsonSchema;
  if (converter === undefined || typeof converter.input !== 'function') {
    return undefined;
  }
  try {
    return converter.input({ target: 'draft-07' });
  } catch {
    return undefined;
  }
}

/** Validate against either kind of props schema. A Standard Schema's own (possibly transformed) output wins. */
export async function validateProps(
  schema: PropsSchema,
  value: unknown,
  validator: JsonSchemaValidator,
): Promise<GenuiValidation> {
  if (isStandardSchema(schema)) {
    const result = await schema['~standard'].validate(value);
    if (result.issues !== undefined) {
      return { ok: false, issues: toGenuiIssues(result.issues) };
    }
    return { ok: true, value: result.value };
  }
  const issues = validator.validate(schema, value);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/**
 * {@link validateProps} without waiting: the verdict when it is available synchronously (always
 * for JSON Schema, and for every Standard Schema whose `validate` does not return a promise — Zod,
 * Valibot and ArkType all answer synchronously for synchronous schemas), `undefined` otherwise. What
 * a renderer uses to decide on its first paint instead of flashing a placeholder.
 */
export function validatePropsSync(
  schema: PropsSchema,
  value: unknown,
  validator: JsonSchemaValidator,
): GenuiValidation | undefined {
  if (!isStandardSchema(schema)) {
    const issues = validator.validate(schema, value);
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
  }
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    result.catch(() => undefined);
    return undefined;
  }
  return result.issues !== undefined
    ? { ok: false, issues: toGenuiIssues(result.issues) }
    : { ok: true, value: result.value };
}

function toGenuiIssues(issues: readonly StandardSchemaV1.Issue[]): GenuiIssue[] {
  return issues.map((issue) => ({
    path: (issue.path ?? []).map((segment) =>
      typeof segment === 'object' && segment !== null && 'key' in segment
        ? (segment.key as string | number)
        : (segment as string | number),
    ),
    message: issue.message,
  }));
}

/** `a.b[0].c: message; …` — what a model is handed back when its props were refused. */
export function formatIssues(issues: readonly GenuiIssue[]): string {
  return issues
    .map(
      (issue) => `${issue.path.length > 0 ? formatPath(issue.path) : '(root)'}: ${issue.message}`,
    )
    .join('; ');
}

function formatPath(path: readonly (string | number)[]): string {
  return path
    .map((segment, index) =>
      typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join('');
}

/**
 * Structural type of an Ajv instance, so the package never imports Ajv: `new Ajv({ allErrors: true })`
 * satisfies it.
 */
export interface AjvLike {
  compile(schema: object): ((data: unknown) => boolean | Promise<unknown>) & {
    errors?: { instancePath?: string; message?: string }[] | null;
  };
}

/**
 * Full JSON Schema validation through the app's own Ajv instance. Compiled validators are cached
 * per schema object.
 */
export function ajvValidator(ajv: AjvLike): JsonSchemaValidator {
  const compiled = new WeakMap<object, ReturnType<AjvLike['compile']>>();
  return {
    validate(schema, value) {
      let fn = compiled.get(schema);
      if (fn === undefined) {
        fn = ajv.compile(schema);
        compiled.set(schema, fn);
      }
      if (fn(value) === true) {
        return [];
      }
      return (fn.errors ?? []).map((error) => ({
        path: (error.instancePath ?? '')
          .split('/')
          .filter((segment) => segment.length > 0)
          .map((segment) => {
            const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~');
            return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
          }),
        message: error.message ?? 'is invalid',
      }));
    },
  };
}

/**
 * A dependency-free JSON Schema validator for the keywords component props actually use: `type`
 * (incl. `integer`, `null`, type arrays), `enum`, `const`, `properties`, `required`,
 * `additionalProperties`, `items`, `minItems`/`maxItems`, `minLength`/`maxLength`/`pattern`,
 * `minimum`/`maximum`, `anyOf`/`oneOf`/`allOf`, `not`, and local `$ref`s (`#`, `#/$defs/…`,
 * `#/definitions/…`). Unknown keywords (e.g. `format`) are ignored. Use {@link ajvValidator} when
 * you need the rest.
 */
export const builtinJsonSchemaValidator: JsonSchemaValidator = {
  validate(schema, value) {
    const issues: GenuiIssue[] = [];
    check(schema, value, [], schema, issues, 0);
    return issues;
  },
};

const MAX_DEPTH = 64;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return typeOf(value) === type;
  }
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'object' && current !== null ? (current as JsonSchema) : undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function check(
  schema: unknown,
  value: unknown,
  path: (string | number)[],
  root: JsonSchema,
  issues: GenuiIssue[],
  depth: number,
): void {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    issues.push({ path, message: 'is not allowed' });
    return;
  }
  if (typeof schema !== 'object' || schema === null) return;
  if (depth > MAX_DEPTH) {
    issues.push({ path, message: 'is nested too deeply' });
    return;
  }
  const s = schema as Record<string, unknown>;

  if (typeof s.$ref === 'string') {
    const target = resolveRef(root, s.$ref);
    if (target === undefined) {
      issues.push({ path, message: `references unknown schema ${s.$ref}` });
      return;
    }
    check(target, value, path, root, issues, depth + 1);
  }

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((type) => matchesType(type, value))) {
      issues.push({ path, message: `must be ${types.join(' or ')}` });
      return;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((option) => deepEqual(option, value))) {
    issues.push({
      path,
      message: `must be one of ${s.enum.map((option) => JSON.stringify(option)).join(', ')}`,
    });
  }
  if ('const' in s && !deepEqual(s.const, value)) {
    issues.push({ path, message: `must be ${JSON.stringify(s.const)}` });
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      issues.push({ path, message: `must be at least ${s.minLength} characters` });
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      issues.push({ path, message: `must be at most ${s.maxLength} characters` });
    }
    if (typeof s.pattern === 'string') {
      let pattern: RegExp | undefined;
      try {
        pattern = new RegExp(s.pattern, 'u');
      } catch {
        pattern = undefined;
      }
      if (pattern !== undefined && !pattern.test(value)) {
        issues.push({ path, message: `must match ${s.pattern}` });
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      issues.push({ path, message: `must be >= ${s.minimum}` });
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      issues.push({ path, message: `must be <= ${s.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      issues.push({ path, message: `must have at least ${s.minItems} items` });
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      issues.push({ path, message: `must have at most ${s.maxItems} items` });
    }
    if (s.items !== undefined && !Array.isArray(s.items)) {
      value.forEach((item, index) => {
        check(s.items, item, [...path, index], root, issues, depth + 1);
      });
    }
  }

  if (matchesType('object', value)) {
    const record = value as Record<string, unknown>;
    const properties =
      typeof s.properties === 'object' && s.properties !== null
        ? (s.properties as Record<string, unknown>)
        : {};
    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (record[key] === undefined) {
          issues.push({ path: [...path, key], message: 'is required' });
        }
      }
    }
    for (const [key, entry] of Object.entries(record)) {
      if (key in properties) {
        if (entry !== undefined) {
          check(properties[key], entry, [...path, key], root, issues, depth + 1);
        }
      } else if (s.additionalProperties === false) {
        issues.push({ path: [...path, key], message: 'is not a known property' });
      } else if (typeof s.additionalProperties === 'object' && s.additionalProperties !== null) {
        check(s.additionalProperties, entry, [...path, key], root, issues, depth + 1);
      }
    }
  }

  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) check(sub, value, path, root, issues, depth + 1);
  }
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const options = (Array.isArray(s.anyOf) ? s.anyOf : s.oneOf) as unknown[];
    const passing = options.filter((sub) => {
      const nested: GenuiIssue[] = [];
      check(sub, value, path, root, nested, depth + 1);
      return nested.length === 0;
    }).length;
    if (Array.isArray(s.anyOf) ? passing === 0 : passing !== 1) {
      issues.push({
        path,
        message: Array.isArray(s.anyOf)
          ? 'does not match any allowed shape'
          : 'must match exactly one allowed shape',
      });
    }
  }
  if (s.not !== undefined) {
    const nested: GenuiIssue[] = [];
    check(s.not, value, path, root, nested, depth + 1);
    if (nested.length === 0) {
      issues.push({ path, message: 'matches a shape that is not allowed' });
    }
  }
}
