/**
 * Constraining a turn's ANSWER to a schema. See `AgentLoopDeps.outputSchema` for where this sits in
 * the loop and why it is a separate model call rather than a constraint on the turn's own calls.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The turn produced an answer that does not satisfy `outputSchema`, and the bounded repair attempts
 * did not fix it. A DEFINED outcome of asking for structured output, not a crash: it carries the
 * validation issues and the text that failed them, so a caller can log what the model actually said
 * instead of guessing from a parse error.
 */
export class StructuredOutputError extends Error {
  /** Why it failed the schema. Empty only when the text was not JSON at all. */
  readonly issues: readonly StandardSchemaV1.Issue[];
  /** The last text the model produced, verbatim. */
  readonly text: string;
  /** How many model calls were spent trying (1 = the formatting pass, no repairs). */
  readonly attempts: number;

  constructor(issues: readonly StandardSchemaV1.Issue[], text: string, attempts: number) {
    const detail =
      issues.length > 0
        ? issues.map((issue) => issue.message).join('; ')
        : 'the model did not reply with JSON';
    super(`Structured output invalid after ${attempts} attempt(s): ${detail}`);
    this.name = 'StructuredOutputError';
    this.issues = issues;
    this.text = text;
    this.attempts = attempts;
  }
}

/** A validated answer, or the issues that stopped it being one. */
export type StructuredOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; issues: readonly StandardSchemaV1.Issue[] };

/**
 * Pull a JSON value out of a model reply, tolerating the code fences and lead-in prose a provider
 * that cannot constrain its own generation still emits. `undefined` when there is no JSON in there
 * at all — distinct from a JSON `null`, which is a value the schema may well accept.
 */
export function extractJson(text: string): unknown {
  const candidates = [text, text.match(/\{[\s\S]*\}/)?.[0], text.match(/\[[\s\S]*\]/)?.[0]];
  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      /* try the next shape */
    }
  }
  return undefined;
}

/**
 * Validate one attempt. The provider's own parsed `object` is preferred when it reported one (a
 * provider that constrained generation already did the parse), but it is validated all the same —
 * "the provider says it matched" is not the same claim as "it matches", and a provider that ignored
 * `outputSchema` entirely must fail here rather than downstream.
 */
export async function validateStructured<T>(args: {
  schema: StandardSchemaV1<unknown, T>;
  text: string;
  reported: unknown;
}): Promise<StructuredOutcome<T>> {
  const candidate = args.reported !== undefined ? args.reported : extractJson(args.text);
  if (candidate === undefined) {
    return { ok: false, issues: [] };
  }
  const result = await args.schema['~standard'].validate(candidate);
  return result.issues !== undefined
    ? { ok: false, issues: result.issues }
    : { ok: true, value: result.value };
}

/**
 * What the formatting pass is told to do. Written for a model that is being shown a finished answer
 * and asked to restate it — never to extend or improve it, which would make the structured result
 * disagree with the prose the user already read.
 */
export const DEFAULT_STRUCTURED_OUTPUT_INSTRUCTION =
  "Restate the assistant's final answer as a single JSON value matching the required schema. Use only information already present in the conversation — add nothing, and answer nothing that was not asked. Reply with ONLY the JSON: no prose, no explanation, no code fences.";

/** Appends the previous attempt's validation issues, so a repair call knows what to fix. */
export function repairInstruction(args: {
  instruction: string;
  issues: readonly StandardSchemaV1.Issue[];
}): string {
  const detail =
    args.issues.length > 0
      ? args.issues
          .map((issue) => `${(issue.path ?? []).join('.') || '(root)'}: ${issue.message}`)
          .join('\n')
      : 'the previous reply was not valid JSON';
  return `${args.instruction}\n\nYour previous reply was rejected:\n${detail}`;
}
