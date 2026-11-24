import type { PoppyAuthRequest, PoppyPrincipal } from './auth.js';

/**
 * The Operations extension (version 3) as conversations use it: the operation a Company message
 * asks approval for, the approval a Personal Agent message carries, and the decline — all in
 * `extensions.operations` of a message (spec §8.4). Storage and verification of operations live
 * in the authorization server, reached through the global slot {@link POPPY_OPERATIONS_SLOT}.
 *
 * @experimental Implements the Operations extension, version 3
 * (https://personalagentprotocol.org/docs/1.0/extensions/operations).
 * The surface may still change between minor releases of this package while it settles.
 */

/** The extension's name in `poppy.json` and `Poppy-Extensions`. */
export const POPPY_OPERATIONS_EXTENSION = 'operations';
/** The version of the Operations extension conversations speak. */
export const POPPY_OPERATIONS_VERSION = '3';

/** One action the Company performs once it is approved (Operations §3). */
export interface PoppyOperation {
  operation_id: string;
  /** Identifies these terms; changes whenever the terms or `expires_at` change. */
  revision: string;
  /** The terms in plain language, for the User. */
  summary?: string;
  /** The terms as JSON: everything that affects the action. */
  terms: Record<string, unknown>;
  /** The last time an approval of this revision is accepted (RFC 3339). */
  expires_at: string;
}

/** How an operation was approved (Operations §5, §6): `user`, `agent`, or a later value. */
export type PoppyApprover = 'user' | 'agent' | (string & {});

/** An approval of one revision (Operations §6). Unknown members are ignored. */
export interface PoppyApproval {
  operation_id: string;
  revision: string;
  approver: PoppyApprover;
  /** Unix seconds. */
  approved_at?: number;
  /** Only with `user`: how the User answered (`tap`, `typed`, `voice`, …). */
  input_type?: string;
  /** The Personal Agent's own record of the approval. */
  reference?: string;
}

/** Another way to do an action (spec §9.2). */
export interface PoppyAlternative {
  instructions?: string;
  references?: { type: string; url?: string; [field: string]: unknown }[];
  [field: string]: unknown;
}

/** A declined approval (Operations §6): nothing was performed. */
export interface PoppyDecline {
  operation_id: string;
  revision: string;
  /** Why, in short plain language for the User. */
  reason?: string;
  alternative?: PoppyAlternative;
}

/** What a Company message or a Personal Agent message carries in `extensions.operations`. */
export type PoppyOperationsContent =
  | { operation: PoppyOperation }
  | { declined: PoppyDecline }
  | { approval: PoppyApproval };

/**
 * What the app (or this package) asks the operations service to require approval for.
 * `action` names the action — two requests with the same `action` are the same action, so a
 * changed `terms` gets the same `operation_id` with a new revision (Operations §3, "New terms").
 */
export interface PoppyOperationInput {
  /** Which interface the request came through. Conversations send `'conversation'`. */
  interface: 'api' | 'mcp' | 'conversation' | 'website' | (string & {});
  /** Stable key of the action, chosen by the caller. */
  action: string;
  /** The terms of the action (Operations §3). */
  terms: Record<string, unknown>;
  /** The terms in plain language (basic Markdown allowed, no links or images). */
  summary?: string;
  /** When an approval of this revision lapses. Default: the service's. */
  expiresAt?: Date | string;
  /** Continue this operation (a new revision of the same action). */
  operationId?: string;
  /** The conversation the operation belongs to, for `interface: 'conversation'`. */
  conversationId?: string;
  /**
   * The approval, when it did not come in a `Poppy-Approval` header — a conversation carries it in
   * the message (`extensions.operations.approval`). `null`: the request carries none.
   */
  approval?: PoppyApproval | null;
}

/**
 * What {@link PoppyOperationsService.require} answers. `ok: true` — the request carries a valid
 * approval of exactly these terms (checks 1–3 of Operations §6): perform the action, then call
 * `markPerformed`. `ok: false` — perform nothing and answer `status`, `body` and `headers`: `403`
 * `approval_required` with the operation, `403` `approval_declined`, `503` while it is being
 * performed, a challenge for an operation that belongs to an account, `400` `invalid_request`.
 */
export type PoppyOperationRequireResult =
  | { ok: true; approval: PoppyApproval; operation?: PoppyOperation }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    };

/** An operation as the service keeps it, with where it stands (Operations §6, §7). */
export type PoppyStoredOperation = PoppyOperation & {
  status?: 'pending' | 'approved' | 'performing' | 'performed' | (string & {});
};

/**
 * The operations service an authorization server installs in {@link POPPY_OPERATIONS_SLOT}
 * (`@adonis-agora/authkit-poppy` does): it stores operations, verifies approvals and keeps each
 * operation performed at most once. Conversations call it; without it, they never ask for
 * approval with operations.
 *
 * @experimental Implements the Operations extension, version 3.
 */
export interface PoppyOperationsService {
  /**
   * Require approval for an action. `request` is the HTTP request (an Adonis `HttpContext` or a
   * {@link PoppyAuthRequest}); its `Poppy-Approval` header, or `input.approval`, is the approval.
   */
  require(
    request: PoppyAuthRequest | { request: unknown },
    principal: PoppyPrincipal,
    input: PoppyOperationInput,
  ): Promise<PoppyOperationRequireResult>;
  /** An operation the principal may see, or `null`. */
  get(principal: PoppyPrincipal, operationId: string): Promise<PoppyStoredOperation | null>;
  /** The action was performed: later approvals of it get the first answer (Operations §7). */
  markPerformed(operationId: string): Promise<void>;
}

/**
 * The contract with the authorization server is this global symbol, not a module (like
 * `Symbol.for('@adonis-agora/poppy:authenticate')`).
 */
export const POPPY_OPERATIONS_SLOT = Symbol.for('@adonis-agora/poppy:operations');

/** The operations service installed in the global slot, if any — read per use, so install order is free. */
export function globalPoppyOperations(): PoppyOperationsService | undefined {
  const value = (globalThis as Record<symbol, unknown>)[POPPY_OPERATIONS_SLOT];
  if (typeof value !== 'object' || value === null) return undefined;
  const service = value as Partial<PoppyOperationsService>;
  return typeof service.require === 'function' &&
    typeof service.get === 'function' &&
    typeof service.markPerformed === 'function'
    ? (service as PoppyOperationsService)
    : undefined;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an approval as a Personal Agent message carries it (`extensions.operations.approval`).
 * `null` when it is not one — a missing or malformed `operation_id`, `revision` or `approver`.
 * Optional members of the wrong type are dropped, never refused (Operations §6); `input_type` is
 * kept only with `user`.
 */
export function parsePoppyApproval(raw: unknown): PoppyApproval | null {
  if (!isRecord(raw)) return null;
  const { operation_id, revision, approver } = raw;
  if (typeof operation_id !== 'string' || !ID_PATTERN.test(operation_id)) return null;
  if (typeof revision !== 'string' || !ID_PATTERN.test(revision)) return null;
  if (typeof approver !== 'string' || approver === '') return null;
  const approvedAt = raw.approved_at;
  return {
    operation_id,
    revision,
    approver,
    ...(typeof approvedAt === 'number' && Number.isInteger(approvedAt)
      ? { approved_at: approvedAt }
      : {}),
    ...(approver === 'user' && typeof raw.input_type === 'string' && raw.input_type !== ''
      ? { input_type: raw.input_type }
      : {}),
    ...(typeof raw.reference === 'string' && ID_PATTERN.test(raw.reference)
      ? { reference: raw.reference }
      : {}),
  };
}

/** An RFC 9651 String. */
function sfString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * An approval as a `Poppy-Approval` header (a Dictionary Structured Field, Operations §6) — what an
 * operations service that reads only the header receives for a conversation's approval.
 */
export function formatPoppyApproval(approval: PoppyApproval): string {
  const members = [
    `operation_id=${sfString(approval.operation_id)}`,
    `revision=${sfString(approval.revision)}`,
    `approver=${sfString(approval.approver)}`,
  ];
  if (approval.approved_at !== undefined) members.push(`approved_at=${approval.approved_at}`);
  if (approval.input_type !== undefined) {
    members.push(`input_type=${sfString(approval.input_type)}`);
  }
  if (approval.reference !== undefined) members.push(`reference=${sfString(approval.reference)}`);
  return members.join(', ');
}

/** The operation of an `approval_required` answer, when it is one. */
export function operationOf(body: Record<string, unknown>): PoppyOperation | null {
  const operation = body.operation;
  if (!isRecord(operation)) return null;
  if (
    typeof operation.operation_id !== 'string' ||
    typeof operation.revision !== 'string' ||
    !isRecord(operation.terms) ||
    typeof operation.expires_at !== 'string'
  ) {
    return null;
  }
  return {
    operation_id: operation.operation_id,
    revision: operation.revision,
    ...(typeof operation.summary === 'string' ? { summary: operation.summary } : {}),
    terms: operation.terms,
    expires_at: operation.expires_at,
  };
}

/** The decline of an `approval_declined` answer — its members without `error` (Operations §6). */
export function declineOf(body: Record<string, unknown>, approval: PoppyApproval): PoppyDecline {
  return {
    operation_id: typeof body.operation_id === 'string' ? body.operation_id : approval.operation_id,
    revision: typeof body.revision === 'string' ? body.revision : approval.revision,
    ...(typeof body.reason === 'string' && body.reason !== '' ? { reason: body.reason } : {}),
    ...(isRecord(body.alternative) ? { alternative: body.alternative as PoppyAlternative } : {}),
  };
}
