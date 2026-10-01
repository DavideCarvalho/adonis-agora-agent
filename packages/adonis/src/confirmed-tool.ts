import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type BrandedFunctionalTool, type DefineToolOptions, defineTool } from './ai-tool-ref.js';
import {
  confirmTokenExpiry,
  DEFAULT_CONFIRM_TTL_MS,
  hashConfirmToken,
  signConfirmToken,
  verifyConfirmToken,
} from './confirm-token.js';
import type { ConfirmTokenStore } from './spi/confirm-token-store.js';
import type { AiToolCtx } from './spi/tool.js';

/** The two fields {@link defineConfirmedTool} adds to a tool's input. */
export interface ConfirmFields {
  /** `true` to commit; absent (or `false`) to preview. */
  confirm?: boolean;
  /** The `confirmToken` the preview returned. */
  confirmToken?: string;
}

/** The words a confirmed tool says to the model. Each has an English default. */
export interface ConfirmedToolMessages {
  /** Sent with every preview: how to confirm. `{minutes}` is replaced with the token's lifetime. */
  confirm?: string;
  /** Thrown for a missing, tampered, mismatched or expired token. */
  invalid?: string;
  /** Thrown for a token that already committed. */
  used?: string;
}

const DEFAULT_MESSAGES: Required<ConfirmedToolMessages> = {
  confirm:
    'Nothing was written. Show this preview to the user and ask them to confirm. To commit, call this tool again with the SAME arguments plus "confirm": true and this "confirmToken" (valid for {minutes} minutes).',
  invalid:
    'Invalid or expired confirmation: nothing was written. Call the tool without "confirm" to get a fresh preview, then confirm with the "confirmToken" it returns, without changing the arguments.',
  used: 'This preview was already confirmed: nothing was written again. To repeat the operation, ask for a new preview.',
};

/** Thrown by a confirmed tool that refused a confirmation. Nothing was written. */
export class ConfirmTokenError extends Error {
  constructor(
    /** `invalid`: missing, tampered, mismatched or expired. `used`: it already committed once. */
    readonly reason: 'invalid' | 'used',
    message: string,
  ) {
    super(message);
    this.name = 'ConfirmTokenError';
  }
}

/** What {@link defineConfirmedTool} takes besides the usual tool options. */
export interface ConfirmedToolOptions extends Omit<DefineToolOptions, 'kind'> {
  name: string;
  /**
   * The HMAC key the tokens are signed with — the app key, or a secret of its own. A function is
   * read on every call. Required: there is no default, and an empty one throws.
   */
  secret: string | (() => string);
  /** How long a preview stays confirmable. Default 15 minutes. */
  ttlMs?: number;
  /**
   * Makes a token single use. WITHOUT a store a token commits as many times as it is sent until it
   * expires — a retry or a repeated call writes twice.
   */
  store?: ConfirmTokenStore;
  messages?: ConfirmedToolMessages;
}

/** What a step reports: a sentence for the model to relay, and the structured detail behind it. */
export interface ConfirmedToolOutcome {
  summary: string;
  data?: unknown;
}

/** The three steps of a confirmed write. */
export interface ConfirmedToolSteps<Args, Prepared> {
  /**
   * Resolve and validate everything the write needs, applying the SAME rules the commit relies on.
   * Throw to refuse. Writes nothing. Runs for the preview AND again for the confirmation — state may
   * have changed in between — and a refusal here does not spend the token.
   */
  prepare(args: Args, ctx: AiToolCtx): Promise<Prepared> | Prepared;
  /** What is about to happen. Writes nothing. */
  preview(prepared: Prepared, ctx: AiToolCtx): Promise<ConfirmedToolOutcome> | ConfirmedToolOutcome;
  /** Write, and say what was written. A throw gives the token back. */
  commit(prepared: Prepared, ctx: AiToolCtx): Promise<ConfirmedToolOutcome> | ConfirmedToolOutcome;
}

/** A confirmed tool's answer to a call without `confirm`. */
export interface ConfirmedToolPreview {
  status: 'preview';
  summary: string;
  data?: unknown;
  confirmToken: string;
  /** ISO-8601 instant the token stops working. */
  expiresAt: string;
  /** Instructions for the model: show the preview, then call again with the token. */
  confirm: string;
}

/** A confirmed tool's answer to a confirmation that committed. */
export interface ConfirmedToolDone {
  status: 'done';
  summary: string;
  data?: unknown;
}

export type ConfirmedToolResult = ConfirmedToolPreview | ConfirmedToolDone;

/** The JSON Schema of {@link ConfirmFields}, merged into the schema the model is shown. */
export const CONFIRM_JSON_SCHEMA_PROPERTIES = {
  confirm: {
    type: 'boolean',
    description:
      'Omit to get a preview (nothing is written). Send true, with confirmToken, to commit.',
  },
  confirmToken: {
    type: 'string',
    description: 'The confirmToken the preview returned. Required when confirm is true.',
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Split a call's input into the app's arguments and the two confirmation fields. */
function splitConfirm(input: unknown): { args: unknown; fields: ConfirmFields } {
  if (!isRecord(input)) return { args: input, fields: {} };
  const { confirm, confirmToken, ...args } = input;
  return {
    args,
    fields: {
      ...(typeof confirm === 'boolean' ? { confirm } : {}),
      ...(typeof confirmToken === 'string' ? { confirmToken } : {}),
    },
  };
}

type JsonSchemaConverter = (options?: unknown) => Record<string, unknown>;

/** The schema's Standard JSON Schema `input` converter, when it has one. */
function jsonSchemaInputOf(schema: StandardSchemaV1): JsonSchemaConverter | undefined {
  const standard = schema['~standard'] as { jsonSchema?: { input?: unknown } };
  const input = standard.jsonSchema?.input;
  return typeof input === 'function'
    ? (options) => (input as JsonSchemaConverter).call(standard.jsonSchema, options)
    : undefined;
}

/**
 * Wrap a tool's input schema so it also accepts {@link ConfirmFields}, without the app declaring
 * them. `validate` takes the two fields off, checks them itself, hands the REST to the app's schema
 * (so a strict schema never sees a key it did not declare) and puts them back on the validated value.
 *
 * The wrapper always carries the Standard JSON Schema extension, because that is the only form the
 * model gets to see: the app schema's own JSON Schema plus the two properties. A schema without the
 * extension (Zod 3, a bare Standard Schema) degrades to a permissive object that still declares the
 * two fields — `validate` stays the authority either way.
 */
export function withConfirmFields<Schema extends StandardSchemaV1>(
  schema: Schema,
): StandardSchemaV1<
  StandardSchemaV1.InferInput<Schema> & ConfirmFields,
  StandardSchemaV1.InferOutput<Schema> & ConfirmFields
> {
  const inner = schema['~standard'];
  const innerJsonSchema = jsonSchemaInputOf(schema);
  const describe = (options?: unknown): Record<string, unknown> => {
    const base = innerJsonSchema?.(options) ?? { additionalProperties: true };
    return {
      ...base,
      type: 'object',
      properties: {
        ...(isRecord(base.properties) ? base.properties : {}),
        ...CONFIRM_JSON_SCHEMA_PROPERTIES,
      },
    };
  };
  const wrapped = {
    '~standard': {
      version: 1,
      vendor: '@adonis-agora/agent',
      validate: async (value: unknown) => {
        if (!isRecord(value)) {
          return { issues: [{ message: 'expected an object' }] };
        }
        const issues: StandardSchemaV1.Issue[] = [];
        // `null` is how some models say "absent"; it is read as absent rather than refused.
        if (value.confirm != null && typeof value.confirm !== 'boolean') {
          issues.push({ message: 'expected a boolean', path: ['confirm'] });
        }
        if (value.confirmToken != null && typeof value.confirmToken !== 'string') {
          issues.push({ message: 'expected a string', path: ['confirmToken'] });
        }
        const { args, fields } = splitConfirm(value);
        const result = await inner.validate(args);
        if (result.issues !== undefined) {
          return { issues: [...issues, ...result.issues] };
        }
        if (issues.length > 0) {
          return { issues };
        }
        return { value: isRecord(result.value) ? { ...result.value, ...fields } : result.value };
      },
      jsonSchema: { input: describe, output: describe },
    },
  };
  return wrapped as unknown as StandardSchemaV1<
    StandardSchemaV1.InferInput<Schema> & ConfirmFields,
    StandardSchemaV1.InferOutput<Schema> & ConfirmFields
  >;
}

/**
 * A write with a human gate that lives INSIDE the tool: preview first, commit on confirmation.
 *
 * - Called without `confirm`: runs `prepare`, writes nothing, and returns the `preview` with a signed
 *   `confirmToken`.
 * - Called again with the SAME arguments, `confirm: true` and that token: runs `prepare` again, then
 *   `commit`.
 *
 * The token is an HMAC over the tool, `ctx.actor.id`, `ctx.actor.tenantRef`, the expiry and the
 * canonical arguments, so it cannot be replayed by another actor, in another tenant, on another
 * tool or with a changed argument. With a `store` it is also single use: it is claimed right before
 * `commit` (a refusal in `prepare` does not spend it) and released if `commit` throws.
 *
 * Registered as `kind: 'read'` on purpose. An `action` parks on the loop's HITL approval, which an
 * MCP caller cannot answer — `createMcpServer` keeps `action` tools off the surface, and MCP clients
 * without elicitation have no other channel. The gate being in the handler is what lets the same
 * tool serve the chat loop and MCP; the user sees the preview because the model has to relay it to
 * get a token it can confirm with.
 *
 * ```ts
 * export const refundOrder = defineConfirmedTool(
 *   { name: 'refund_order', description: '...', input: z.object({ orderId: z.string() }),
 *     secret: () => env.get('APP_KEY').release(), store: new LucidConfirmTokenStore(db) },
 *   {
 *     prepare: async ({ orderId }, ctx) => loadRefundableOrder(orderId, ctx.actor),
 *     preview: (order) => ({ summary: `Refund ${order.total} to ${order.customer}?`, data: order }),
 *     commit: async (order) => ({ summary: 'Refunded.', data: await refund(order) }),
 *   },
 * )
 * ```
 *
 * `input` is the app's own schema: `confirm` and `confirmToken` are added by
 * {@link withConfirmFields}, and `prepare` receives the arguments without them.
 */
export function defineConfirmedTool<Args = unknown, Prepared = unknown>(
  options: ConfirmedToolOptions,
  steps: ConfirmedToolSteps<Args, Prepared>,
): BrandedFunctionalTool {
  const { secret, ttlMs = DEFAULT_CONFIRM_TTL_MS, store, messages, ...toolOptions } = options;
  const text = { ...DEFAULT_MESSAGES, ...messages };
  const howToConfirm = text.confirm.replaceAll('{minutes}', String(Math.round(ttlMs / 60_000)));
  const secretNow = () => (typeof secret === 'function' ? secret() : secret);

  return defineTool<unknown, ConfirmedToolResult>(
    { ...toolOptions, kind: 'read', input: withConfirmFields(options.input) },
    async (input, ctx) => {
      const { args, fields } = splitConfirm(input);
      const subject = {
        tool: options.name,
        actorId: ctx.actor.id,
        ...(ctx.actor.tenantRef !== undefined ? { tenantRef: ctx.actor.tenantRef } : {}),
        args,
      };
      const confirming = fields.confirm === true;
      const token = fields.confirmToken;
      if (confirming && !verifyConfirmToken(token, subject, { secret: secretNow() })) {
        throw new ConfirmTokenError('invalid', text.invalid);
      }

      const prepared = await steps.prepare(args as Args, ctx);

      if (!confirming || token === undefined) {
        const preview = await steps.preview(prepared, ctx);
        const expiresAt = Date.now() + ttlMs;
        return {
          status: 'preview',
          summary: preview.summary,
          ...(preview.data !== undefined ? { data: preview.data } : {}),
          confirmToken: signConfirmToken(subject, { secret: secretNow(), expiresAt }),
          expiresAt: new Date(expiresAt).toISOString(),
          confirm: howToConfirm,
        };
      }

      // Claimed only now: everything `prepare` refuses leaves the token usable, and a commit that
      // throws gives it back so the same preview can be confirmed again.
      const hash = hashConfirmToken(token);
      if (store !== undefined) {
        const claimed = await store.claim({
          hash,
          actorRef: ctx.actor.id,
          tool: options.name,
          expiresAt: confirmTokenExpiry(token) ?? Date.now() + ttlMs,
        });
        if (!claimed) {
          throw new ConfirmTokenError('used', text.used);
        }
      }
      try {
        const done = await steps.commit(prepared, ctx);
        return {
          status: 'done',
          summary: done.summary,
          ...(done.data !== undefined ? { data: done.data } : {}),
        };
      } catch (error) {
        // The commit's own error is the one worth reporting, whatever the release does.
        await store?.release(hash).catch(() => undefined);
        throw error;
      }
    },
  );
}
