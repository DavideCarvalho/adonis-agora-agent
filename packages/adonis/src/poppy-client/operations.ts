/**
 * The Operations extension, version 3 (Personal Agent side): a Company refuses an action that needs
 * approval and returns the operation, the terms are approved by the User (or by this agent on an
 * instruction the User gave), and the same request goes again with the approval. Each interface
 * carries it its own way: APIs and the website's operations `endpoint` in the `Poppy-Approval`
 * header, MCP in the tool call's `_meta`, conversations in `extensions.operations`.
 *
 * Guarantees kept here: an approval covers one revision; a declined approval is never sent again; a
 * request carrying an approval that failed is sent again with the SAME approval, and no new operation
 * for the action is approved until the outcome is known; an agent approval that met new terms or a
 * decline never approves the next revision on the same instruction (the User is asked).
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type CompanyClient, throwForResponse } from './company.js';
import type { ConversationClient } from './conversations.js';
import { PoppyError, ResourceAuthError } from './errors.js';
import { readJson } from './http.js';
import type { OperationRecord } from './store.js';
import { parseDictionary, serializeDictionary } from './structured_fields.js';
import { safeAlternative } from './task_coverage.js';
import type {
  ConversationEvent,
  EventMessage,
  OperationApproval,
  OperationDecline,
  PoppyOperation,
} from './types.js';
import { nowSeconds, parseRetryAfter, randomId, requireSecureUrl, sleep } from './util.js';

export const OPERATIONS_EXTENSION = 'operations';
export const OPERATIONS_VERSION = '3';
/** The tool call `_meta` key an MCP approval goes under (Operations section 6). */
export const APPROVAL_META_KEY = 'personalagentprotocol.org/approval';

/** IDs have the characters of spec 8.2. */
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
/** A website reference: at most 2048 characters of A–Z, a–z, 0–9, `-`, `_`, `.` (section 4). */
const REF_RE = /^[A-Za-z0-9._-]{1,2048}$/;
/** A short code with no personal data in it (section 6). */
const INPUT_TYPE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
/** Ledger entries are kept this long after their terms expire. */
const KEEP_AFTER_EXPIRY_MS = 7 * 24 * 3600_000;

export type OperationInterface = 'api' | 'mcp' | 'conversation' | 'website';

/** What the agent asked for when an operation came back, to check its terms against (section 5). */
export interface AskedFor {
  /** APIs and websites: the request the action came from. */
  method?: string | undefined;
  url?: string | undefined;
  body?: unknown;
  /** MCP. */
  tool?: string | undefined;
  arguments?: Record<string, unknown> | undefined;
  /** Conversations. */
  conversationId?: string | undefined;
  message?: string | undefined;
  [k: string]: unknown;
}

/** What an approver is asked to decide. */
export interface ApprovalRequest {
  /** Show the User the Company's name with the terms (section 5). */
  company: { name: string; domain: string };
  operation: PoppyOperation;
  /** `summary` with link, image and HTML markup shown as text (section 3). */
  summaryText?: string | undefined;
  via: OperationInterface;
  asked: AskedFor;
  /**
   * Only the User can approve this one: an earlier agent approval met new terms, or the Company
   * declined an approval for this action (sections 5 and 6). An agent decision is then refused.
   */
  userOnly: boolean;
  why?: 'new_terms_after_agent_approval' | 'after_decline' | 'new_operation_after_agent_approval';
}

/**
 * An approval decision. `user`: the User approved through this agent's own interface (never text
 * from the Company). `agent`: an instruction the User gave covers these terms.
 */
export type ApprovalDecision =
  | { approver: 'user'; inputType?: string | undefined; approvedAt?: number | undefined }
  | { approver: 'agent'; approvedAt?: number | undefined };

/** Decides an operation. `null` or `undefined`: not approved, and the action isn't performed. */
export type OperationApprover = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision | null | undefined> | ApprovalDecision | null | undefined;

/** How an operation ended for this agent. The action is done only with `performed`. */
export type OperationOutcome =
  /** The Company performed the action and answered as it would without operations. */
  | { status: 'performed'; operation: PoppyOperation; approval: OperationApproval }
  /** Nobody approved it: tell the User the action wasn't performed. */
  | { status: 'not_approved'; operation: PoppyOperation }
  /** Its terms expired before an approval was sent. */
  | { status: 'expired'; operation: PoppyOperation }
  /** The Company declined the approval. Nothing was performed; never send it again. */
  | {
      status: 'declined';
      operation: PoppyOperation;
      approval: OperationApproval;
      decline: OperationDecline;
    }
  /**
   * A request carrying the approval failed, and the answer to its retry doesn't say whether it took
   * effect. Find out another way (the order in the Company's API) before approving anything else.
   */
  | { status: 'unknown'; operation: PoppyOperation; approval: OperationApproval }
  /** The request with the approval was refused for another reason (sign-in, Session): not performed. */
  | { status: 'refused'; operation: PoppyOperation; approval: OperationApproval }
  /** Conversations: the approval was sent; the Company Agent says how it went in a later message. */
  | { status: 'sent'; operation: PoppyOperation; approval: OperationApproval }
  /** Websites: the approval is recorded; have the browser make the action's request again. */
  | { status: 'recorded'; operation: PoppyOperation; approval: OperationApproval; ref: string };

export interface OperationOptions {
  /** Decides this call's operations instead of the agent's `operations.approve`. */
  approve?: OperationApprover | undefined;
  /** An earlier approval for this action was an agent approval: the User must be asked. */
  userOnly?: boolean | undefined;
}

/** A refusal that carries an operation (section 4) or declines an approval (section 6). */
export type OperationRefusal =
  | { kind: 'required'; operation: PoppyOperation }
  | { kind: 'declined'; decline: OperationDecline };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An operation as section 3 defines it, or `undefined` when it isn't one. */
export function parseOperation(raw: unknown): PoppyOperation | undefined {
  if (!isObject(raw)) return undefined;
  const { operation_id, revision, summary, terms, expires_at } = raw;
  if (typeof operation_id !== 'string' || !ID_RE.test(operation_id)) return undefined;
  if (typeof revision !== 'string' || !ID_RE.test(revision)) return undefined;
  if (!isObject(terms)) return undefined;
  if (typeof expires_at !== 'string' || !RFC3339_RE.test(expires_at)) return undefined;
  if (Number.isNaN(Date.parse(expires_at))) return undefined;
  if (summary !== undefined && typeof summary !== 'string') return undefined;
  return raw as PoppyOperation;
}

function parseDecline(raw: unknown, company?: CompanyClient): OperationDecline | undefined {
  if (!isObject(raw)) return undefined;
  const { operation_id, revision, reason, alternative } = raw;
  if (typeof operation_id !== 'string' || !ID_RE.test(operation_id)) return undefined;
  if (typeof revision !== 'string' || !ID_RE.test(revision)) return undefined;
  const out: OperationDecline = { operation_id, revision };
  if (typeof reason === 'string') out.reason = reason;
  const alt = company ? safeAlternative(company, alternative as never) : undefined;
  if (alt) out.alternative = alt;
  return out;
}

/**
 * A `summary` shown as text: it may use emphasis, paragraphs and lists, but links, images and HTML
 * MUST NOT be rendered (section 3). Their markup is escaped so a Markdown renderer shows it as text.
 */
export function operationSummaryText(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  return summary.replace(/[\\[\]<>]/g, (c) => `\\${c}`).replace(/!(?=\\\[)/g, '\\!');
}

/** Whether this agent uses the Operations extension, version 3, with this Company (section 2). */
export function usesOperations(company: CompanyClient): boolean {
  return company.declaredExtensions[OPERATIONS_EXTENSION] === OPERATIONS_VERSION;
}

/** The approval as JSON, for MCP `_meta` and conversations (section 6). */
export function approvalJson(approval: OperationApproval): Record<string, unknown> {
  const out: Record<string, unknown> = {
    operation_id: approval.operation_id,
    revision: approval.revision,
    approver: approval.approver,
  };
  if (approval.approved_at !== undefined) out.approved_at = approval.approved_at;
  if (approval.approver === 'user' && approval.input_type !== undefined)
    out.input_type = approval.input_type;
  if (approval.reference !== undefined) out.reference = approval.reference;
  return out;
}

/** `Poppy-Approval`: a Dictionary with Strings, and `approved_at` as an Integer (section 6). */
export function formatApprovalHeader(approval: OperationApproval): string {
  return serializeDictionary({
    operation_id: approval.operation_id,
    revision: approval.revision,
    approver: approval.approver,
    approved_at: approval.approved_at,
    input_type: approval.approver === 'user' ? approval.input_type : undefined,
    reference: approval.reference,
  });
}

/** `Poppy-Operation`: `sid` and `ref`, both Strings (section 4). `undefined` when malformed. */
export function parseOperationHeader(
  value: string | null | undefined,
): { sid: string; ref: string } | undefined {
  if (!value) return undefined;
  let dict: ReturnType<typeof parseDictionary>;
  try {
    dict = parseDictionary(value);
  } catch {
    return undefined;
  }
  const sid = dict.get('sid')?.value;
  const ref = dict.get('ref')?.value;
  if (typeof sid !== 'string' || typeof ref !== 'string' || !REF_RE.test(ref)) return undefined;
  return { sid, ref };
}

/* ------------------------------------------------------------------------- ledger */

function ledger(company: CompanyClient): Record<string, OperationRecord> {
  const all = company.state.operations ?? {};
  company.state.operations = all;
  const cutoff = Date.now() - KEEP_AFTER_EXPIRY_MS;
  for (const [id, rec] of Object.entries(all)) {
    if (Date.parse(rec.operation.expires_at) < cutoff && rec.updatedAt < cutoff) delete all[id];
  }
  return all;
}

/** This agent's record of an operation, if it met it. */
export function operationRecord(
  company: CompanyClient,
  operationId: string,
): OperationRecord | undefined {
  return company.state.operations?.[operationId];
}

function remember(
  company: CompanyClient,
  via: OperationInterface,
  operation: PoppyOperation,
  asked: AskedFor | undefined,
  patch: Partial<OperationRecord> = {},
): OperationRecord {
  const all = ledger(company);
  const prior = all[operation.operation_id];
  const rec: OperationRecord = {
    via,
    operation,
    approvals: prior?.approvals ?? [],
    status: 'pending',
    ...(prior?.declined ? { declined: true } : {}),
    ...(prior?.webRef !== undefined ? { webRef: prior.webRef } : {}),
    ...(asked !== undefined ? { asked } : prior?.asked !== undefined ? { asked: prior.asked } : {}),
    updatedAt: Date.now(),
    ...patch,
  };
  all[operation.operation_id] = rec;
  return rec;
}

function mark(company: CompanyClient, operationId: string, patch: Partial<OperationRecord>) {
  const rec = company.state.operations?.[operationId];
  if (rec) Object.assign(rec, patch, { updatedAt: Date.now() });
}

function recordSent(company: CompanyClient, approval: OperationApproval) {
  const rec = company.state.operations?.[approval.operation_id];
  if (!rec) return;
  if (!rec.approvals.some((a) => a.reference === approval.reference)) {
    rec.approvals.push({
      revision: approval.revision,
      approver: approval.approver,
      reference: approval.reference ?? '',
      approvedAt: approval.approved_at ?? nowSeconds(),
    });
  }
  rec.status = 'sent';
  rec.updatedAt = Date.now();
}

/* ------------------------------------------------------------------------- deciding */

/**
 * Asks the approver about one revision (section 5) and builds the approval: `approved_at`, an
 * `input_type` only with `user`, and a fresh random `reference`, so no two Companies ever get the
 * same one. `undefined` with an outcome when nothing is approved.
 */
export async function decide(
  company: CompanyClient,
  via: OperationInterface,
  operation: PoppyOperation,
  asked: AskedFor,
  opts: OperationOptions = {},
): Promise<{ approval: OperationApproval } | { outcome: OperationOutcome }> {
  const rec = remember(company, via, operation, asked);
  await company.save();
  if (Date.parse(operation.expires_at) <= Date.now()) {
    return { outcome: { status: 'expired', operation } };
  }
  const agentBefore = rec.approvals.some(
    (a) => a.approver === 'agent' && a.revision !== operation.revision,
  );
  const userOnly = rec.declined === true || agentBefore || opts.userOnly === true;
  const why: ApprovalRequest['why'] = rec.declined
    ? 'after_decline'
    : agentBefore
      ? 'new_terms_after_agent_approval'
      : opts.userOnly
        ? 'new_operation_after_agent_approval'
        : undefined;
  const approve = opts.approve ?? company.agent.opts.operations?.approve;
  const notApproved = { outcome: { status: 'not_approved', operation } as OperationOutcome };
  if (!approve) return notApproved;
  const decision = await approve({
    company: {
      name: company.document.organization.name,
      domain: company.document.organization.domain,
    },
    operation,
    summaryText: operationSummaryText(operation.summary),
    via,
    asked,
    userOnly,
    ...(why ? { why } : {}),
  });
  if (!decision || (decision.approver !== 'user' && decision.approver !== 'agent')) {
    return notApproved;
  }
  if (decision.approver === 'agent' && userOnly) {
    company.agent.log(
      `operation ${operation.operation_id}: an agent approval is refused here; the User must approve`,
    );
    return notApproved;
  }
  const approval: OperationApproval = {
    operation_id: operation.operation_id,
    revision: operation.revision,
    approver: decision.approver,
    approved_at: Math.floor(decision.approvedAt ?? nowSeconds()),
    reference: randomId('apr_', 12),
  };
  if (decision.approver === 'user' && decision.inputType !== undefined) {
    // 6: a short string, and nothing that identifies the User or their device.
    if (INPUT_TYPE_RE.test(decision.inputType)) approval.input_type = decision.inputType;
  }
  return { approval };
}

/* ------------------------------------------------------------------------- refusals */

/** The JSON refusal of an API or the operations `endpoint` (sections 4 and 6), if it is one. */
export async function operationRefusal(
  res: Response,
  company?: CompanyClient,
): Promise<OperationRefusal | undefined> {
  if (res.status !== 403) return undefined;
  const body = await readJson<Record<string, unknown>>(res.clone());
  if (!isObject(body)) return undefined;
  if (body.error === 'approval_required') {
    const operation = parseOperation(body.operation);
    return operation ? { kind: 'required', operation } : undefined;
  }
  if (body.error === 'approval_declined') {
    const decline = parseDecline(body, company);
    return decline ? { kind: 'declined', decline } : undefined;
  }
  return undefined;
}

/** The refusal in an MCP tool result (sections 4 and 6), if it is one. */
export function toolRefusal(
  result: unknown,
  company?: CompanyClient,
): OperationRefusal | undefined {
  if (!isObject(result) || result.isError !== true || !isObject(result.structuredContent)) {
    return undefined;
  }
  const sc = result.structuredContent;
  if (sc.error === 'approval_declined') {
    const decline = parseDecline(sc, company);
    return decline ? { kind: 'declined', decline } : undefined;
  }
  const operation = parseOperation(sc.operation);
  return operation ? { kind: 'required', operation } : undefined;
}

/* ------------------------------------------------------------------------- retries */

interface Attempt<T> {
  value?: T;
  /** The attempt failed (network error, 5xx): send it again with the same approval. */
  failed: boolean;
  /** Seconds a `503` asked to wait. */
  retryAfter?: number | undefined;
  error?: unknown;
}

/**
 * Sends a request carrying an approval until it doesn't fail, at most `maxRetries` more times
 * (section 7). `failedOnce` says whether any attempt failed: an answer with new terms then doesn't
 * say whether the action took effect.
 */
async function withRetries<T>(
  company: CompanyClient,
  attempt: () => Promise<Attempt<T>>,
): Promise<{ value?: T | undefined; failedOnce: boolean; error?: unknown }> {
  const max = company.agent.opts.operations?.maxRetries ?? 3;
  const maxWait = company.agent.opts.operations?.maxRetryAfterSeconds ?? 30;
  let failedOnce = false;
  for (let i = 0; ; i++) {
    const r = await attempt();
    if (!r.failed) return { value: r.value as T, failedOnce };
    failedOnce = true;
    if (i >= max) return { value: r.value, failedOnce, error: r.error };
    // Retry-After, but never a tight loop: at least a short, growing pause.
    const wait = Math.min(Math.max(r.retryAfter ?? 0, 0.1 * 2 ** i), maxWait);
    company.agent.log(`a request carrying an approval failed; sending it again in ${wait}s`);
    await sleep(wait * 1000);
  }
}

async function httpAttempt(send: () => Promise<Response>): Promise<Attempt<Response>> {
  try {
    const res = await send();
    if (res.status >= 500) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      return { value: res, failed: true, retryAfter };
    }
    return { value: res, failed: false };
  } catch (error) {
    if (error instanceof PoppyError) throw error;
    return { failed: true, error };
  }
}

function unknownError(operation: PoppyOperation, cause: unknown): PoppyError {
  return new PoppyError(
    'operation_outcome_unknown',
    `the request approving ${operation.operation_id} failed; whether it was performed is unknown`,
    { details: { operation_id: operation.operation_id, cause: String(cause) } },
  );
}

/* ------------------------------------------------------------------------- APIs */

/**
 * Sends an API request (or a request to the website's operations `endpoint`) and handles any
 * operation it returns: approval, the same request again with `Poppy-Approval`, declines, new
 * revisions and retries (sections 4–7). `send` makes the request, with the approval header when
 * given one, and MUST send the same method, URL and content each time.
 */
export async function sendWithOperations(
  company: CompanyClient,
  via: 'api' | 'website',
  asked: AskedFor,
  send: (approvalHeader: string | undefined) => Promise<Response>,
  opts: OperationOptions = {},
): Promise<{ response: Response; outcome?: OperationOutcome | undefined }> {
  let response = await send(undefined);
  if (!usesOperations(company)) return { response };
  const named = new Set<string>();
  let outcome: OperationOutcome | undefined;
  for (;;) {
    const refusal = await operationRefusal(response, company);
    if (refusal?.kind !== 'required') return { response, outcome };
    const { operation } = refusal;
    if (named.has(`${operation.operation_id} ${operation.revision}`)) {
      // 6: a Company never answers an approval with the revision it names.
      throw new PoppyError(
        'operation_loop',
        `${operation.operation_id}: the Company answered an approval with the same revision`,
      );
    }
    const decided = await decide(company, via, operation, asked, opts);
    if ('outcome' in decided) {
      await company.save();
      return { response, outcome: decided.outcome };
    }
    const { approval } = decided;
    named.add(`${operation.operation_id} ${operation.revision}`);
    recordSent(company, approval);
    await company.save();
    const header = formatApprovalHeader(approval);
    await response.body?.cancel().catch(() => {});
    const sent = await withRetries(company, () => httpAttempt(() => send(header)));
    if (!sent.value) {
      mark(company, operation.operation_id, { status: 'unknown' });
      await company.save();
      throw unknownError(operation, sent.error);
    }
    response = sent.value;
    const next = await operationRefusal(response, company);
    if (next?.kind === 'declined') {
      mark(company, operation.operation_id, { status: 'declined', declined: true });
      await company.save();
      return {
        response,
        outcome: { status: 'declined', operation, approval, decline: next.decline },
      };
    }
    if (next?.kind === 'required') {
      if (sent.failedOnce) {
        // 7: a new operation in answer to a retry doesn't say whether the first was performed.
        mark(company, operation.operation_id, { status: 'unknown' });
        await company.save();
        return { response, outcome: { status: 'unknown', operation, approval } };
      }
      continue; // new terms: approved anew, by the User when an agent approved these (5).
    }
    if (sent.failedOnce && response.status >= 500) {
      mark(company, operation.operation_id, { status: 'unknown' });
      await company.save();
      return { response, outcome: { status: 'unknown', operation, approval } };
    }
    const done = response.ok;
    mark(company, operation.operation_id, { status: done ? 'performed' : 'pending' });
    await company.save();
    outcome = done
      ? { status: 'performed', operation, approval }
      : { status: 'refused', operation, approval };
    return { response, outcome };
  }
}

/* ------------------------------------------------------------------------- MCP */

type ToolParams = { name: string; arguments?: Record<string, unknown> | undefined };

/**
 * Calls an MCP tool and handles any operation it returns (sections 4–7): the same tool with the same
 * arguments again, the approval in `_meta` under `personalagentprotocol.org/approval`.
 */
export async function callToolWithOperations(
  company: CompanyClient,
  client: Client,
  params: ToolParams,
  opts: OperationOptions = {},
): Promise<{ result: Awaited<ReturnType<Client['callTool']>>; outcome?: OperationOutcome }> {
  const call = (approval?: OperationApproval) =>
    client.callTool({
      name: params.name,
      ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
      ...(approval ? { _meta: { [APPROVAL_META_KEY]: approvalJson(approval) } } : {}),
    });
  let result = await call();
  if (!usesOperations(company)) return { result };
  const asked: AskedFor = { tool: params.name, arguments: params.arguments ?? {} };
  const named = new Set<string>();
  for (;;) {
    const refusal = toolRefusal(result, company);
    if (refusal?.kind !== 'required') return { result };
    const { operation } = refusal;
    if (named.has(`${operation.operation_id} ${operation.revision}`)) {
      throw new PoppyError(
        'operation_loop',
        `${operation.operation_id}: the Company answered an approval with the same revision`,
      );
    }
    const decided = await decide(company, 'mcp', operation, asked, opts);
    if ('outcome' in decided) {
      await company.save();
      return { result, outcome: decided.outcome };
    }
    const { approval } = decided;
    named.add(`${operation.operation_id} ${operation.revision}`);
    recordSent(company, approval);
    await company.save();
    const sent = await withRetries(company, async () => {
      try {
        return { value: await call(approval), failed: false };
      } catch (error) {
        // An authorization challenge isn't a failure to retry: the call wasn't accepted.
        if (error instanceof ResourceAuthError || error instanceof PoppyError) throw error;
        return { failed: true, error };
      }
    });
    if (!sent.value) {
      mark(company, operation.operation_id, { status: 'unknown' });
      await company.save();
      throw unknownError(operation, sent.error);
    }
    result = sent.value;
    const next = toolRefusal(result, company);
    if (next?.kind === 'declined') {
      mark(company, operation.operation_id, { status: 'declined', declined: true });
      await company.save();
      return {
        result,
        outcome: { status: 'declined', operation, approval, decline: next.decline },
      };
    }
    if (next?.kind === 'required') {
      if (sent.failedOnce) {
        mark(company, operation.operation_id, { status: 'unknown' });
        await company.save();
        return { result, outcome: { status: 'unknown', operation, approval } };
      }
      continue;
    }
    const done = result.isError !== true;
    mark(company, operation.operation_id, { status: done ? 'performed' : 'pending' });
    await company.save();
    return {
      result,
      outcome: done
        ? { status: 'performed', operation, approval }
        : { status: 'refused', operation, approval },
    };
  }
}

/* ------------------------------------------------------------------------- conversations */

/** The operation a Company message asks approval for (`extensions.operations.operation`). */
export function operationOf(message: EventMessage | undefined): PoppyOperation | undefined {
  if (!message || message.role === 'user') return undefined;
  const ext = message.extensions?.[OPERATIONS_EXTENSION];
  return isObject(ext) ? parseOperation(ext.operation) : undefined;
}

/** A decline in a Company message (`extensions.operations.declined`). */
export function declineOf(
  message: EventMessage | undefined,
  company?: CompanyClient,
): OperationDecline | undefined {
  if (!message || message.role === 'user') return undefined;
  const ext = message.extensions?.[OPERATIONS_EXTENSION];
  return isObject(ext) ? parseDecline(ext.declined, company) : undefined;
}

/**
 * Notes what a conversation event says about operations: a Company message's operation is waiting
 * for approval, a decline means its approval must never be sent again. Returns what it found.
 */
export function noteOperationEvent(
  company: CompanyClient,
  event: ConversationEvent,
): { operation?: PoppyOperation; decline?: OperationDecline } {
  if (event.type !== 'message' || !usesOperations(company)) return {};
  const operation = operationOf(event.message);
  const decline = declineOf(event.message, company);
  if (operation) {
    const prior = company.state.operations?.[operation.operation_id];
    if (!prior || prior.operation.revision !== operation.revision || prior.status === 'pending') {
      remember(company, 'conversation', operation, prior?.asked);
    }
  }
  if (decline) mark(company, decline.operation_id, { status: 'declined', declined: true });
  return { ...(operation ? { operation } : {}), ...(decline ? { decline } : {}) };
}

/**
 * Approves an operation a Company message returned in a conversation (section 6): decides it, then
 * sends a message with the approval in `extensions.operations.approval`. Its text approves nothing;
 * the Company Agent says how it went in a later message (watch for `declineOf`).
 */
export async function approveInConversation(
  conversation: ConversationClient,
  conversationId: string,
  operation: PoppyOperation,
  opts: OperationOptions & { text?: string | undefined; asked?: AskedFor | undefined } = {},
): Promise<OperationOutcome> {
  const company = conversation.company;
  if (!usesOperations(company)) {
    throw new PoppyError(
      'extension_not_used',
      'this agent does not use operations with this Company',
    );
  }
  const rec = company.state.operations?.[operation.operation_id];
  if (rec?.status === 'performed') {
    throw new PoppyError('operation_performed', `${operation.operation_id} was performed already`);
  }
  const decided = await decide(
    company,
    'conversation',
    operation,
    opts.asked ?? { conversationId },
    opts,
  );
  if ('outcome' in decided) {
    await company.save();
    return decided.outcome;
  }
  const { approval } = decided;
  recordSent(company, approval);
  await company.save();
  await conversation.send(conversationId, {
    author: { type: 'agent' },
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    extensions: { [OPERATIONS_EXTENSION]: { approval: approvalJson(approval) } },
  });
  return { status: 'sent', operation, approval };
}

/* ------------------------------------------------------------------------- websites */

/**
 * The website's operations `endpoint` (section 2), when the Company lists one for version 3. It
 * comes with `web.browser_session_endpoint`: only a joined browser gets operations.
 */
export function operationsEndpoint(company: CompanyClient): string | undefined {
  const entries = company.document.extensions?.[OPERATIONS_EXTENSION];
  if (!Array.isArray(entries)) return undefined;
  const entry = entries.find((e) => e?.version === OPERATIONS_VERSION);
  if (typeof entry?.endpoint !== 'string') return undefined;
  if (!company.document.web?.browser_session_endpoint) return undefined;
  return requireSecureUrl(entry.endpoint, 'operations endpoint', company.security).toString();
}

/**
 * The reference in a `Poppy-Operation` header of a response THIS agent's own browser received,
 * only when its `sid` names a Session the agent joined that browser to (section 4). Anything else,
 * including references read from a page or a message, is ignored.
 */
export function webOperationReference(
  company: CompanyClient,
  headers: Headers | Record<string, string | string[] | undefined>,
): { sid: string; ref: string } | undefined {
  const raw =
    headers instanceof Headers
      ? headers.get('poppy-operation')
      : (() => {
          const v = Object.entries(headers).find(
            ([k]) => k.toLowerCase() === 'poppy-operation',
          )?.[1];
          return Array.isArray(v) ? v.join(', ') : v;
        })();
  const parsed = parseOperationHeader(raw);
  if (!parsed) return undefined;
  if (!(company.state.browserSessions ?? []).includes(parsed.sid)) return undefined;
  return parsed;
}

/** What the operations `endpoint` says about a reference (sections 4 and 6). */
export type WebOperationState =
  | { kind: 'operation'; operation: PoppyOperation }
  | {
      kind: 'status';
      operationId: string;
      status: 'approved' | 'performing' | 'performed' | string;
    }
  /** The reference can't be used: have the browser make the request again for a new one. */
  | { kind: 'invalid' };

async function postEndpoint(
  company: CompanyClient,
  ref: string,
  approvalHeader?: string,
): Promise<Response> {
  const endpoint = operationsEndpoint(company);
  if (!endpoint)
    throw new PoppyError('no_operations_endpoint', 'the Company lists no operations endpoint');
  return company.fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(approvalHeader ? { 'poppy-approval': approvalHeader } : {}),
    },
    body: JSON.stringify({ ref }),
  });
}

/** Gets the operation behind a website reference, or its state once approved (sections 4 and 6). */
export async function lookupWebOperation(
  company: CompanyClient,
  ref: string,
): Promise<WebOperationState> {
  if (!REF_RE.test(ref)) return { kind: 'invalid' };
  const res = await postEndpoint(company, ref);
  const refusal = await operationRefusal(res, company);
  if (refusal?.kind === 'required') return { kind: 'operation', operation: refusal.operation };
  if (res.status === 200) {
    const body = await readJson<Record<string, unknown>>(res);
    if (typeof body?.operation_id === 'string' && typeof body.status === 'string') {
      return { kind: 'status', operationId: body.operation_id, status: body.status };
    }
  }
  if (res.status === 400) {
    const body = await readJson<{ error?: unknown }>(res.clone());
    if (body?.error === 'invalid_request') return { kind: 'invalid' };
  }
  return throwForResponse(res);
}

/**
 * Approves the operation behind a website reference at the operations `endpoint` (section 6). On
 * `recorded`, have the browser make the action's request again (its Continue button, the same
 * form); `afterBrowserRepeat` then checks the answer.
 */
export async function approveWebOperation(
  company: CompanyClient,
  ref: string,
  asked: AskedFor,
  opts: OperationOptions = {},
): Promise<
  OperationOutcome | { status: 'invalid' } | { status: 'approved_already'; state: string }
> {
  const state = await lookupWebOperation(company, ref);
  if (state.kind === 'invalid') return { status: 'invalid' };
  if (state.kind === 'status') return { status: 'approved_already', state: state.status };
  let operation = state.operation;
  const named = new Set<string>();
  for (;;) {
    if (named.has(`${operation.operation_id} ${operation.revision}`)) {
      throw new PoppyError(
        'operation_loop',
        `${operation.operation_id}: the Company answered an approval with the same revision`,
      );
    }
    const decided = await decide(company, 'website', operation, asked, opts);
    mark(company, operation.operation_id, { webRef: ref });
    if ('outcome' in decided) {
      await company.save();
      return decided.outcome;
    }
    const { approval } = decided;
    named.add(`${operation.operation_id} ${operation.revision}`);
    recordSent(company, approval);
    await company.save();
    const header = formatApprovalHeader(approval);
    const sent = await withRetries(company, () =>
      httpAttempt(() => postEndpoint(company, ref, header)),
    );
    if (!sent.value) {
      mark(company, operation.operation_id, { status: 'unknown' });
      await company.save();
      throw unknownError(operation, sent.error);
    }
    const res = sent.value;
    if (res.status === 204) {
      await company.save();
      return { status: 'recorded', operation, approval, ref };
    }
    const refusal = await operationRefusal(res, company);
    if (refusal?.kind === 'declined') {
      mark(company, operation.operation_id, { status: 'declined', declined: true });
      await company.save();
      return { status: 'declined', operation, approval, decline: refusal.decline };
    }
    if (refusal?.kind === 'required') {
      operation = refusal.operation; // check 3 failed: new terms for this reference
      continue;
    }
    if (res.status === 400) {
      mark(company, operation.operation_id, { status: 'pending' });
      await company.save();
      return { status: 'expired', operation };
    }
    return throwForResponse(res);
  }
}

/**
 * After the browser made the action's request again (section 7): with no new `Poppy-Operation`, the
 * action went through. A new reference means the approval was used up or no longer matches: the
 * earlier one is looked up first — still `performing` is waited for, `performed` is never approved
 * again — and only then is the new one decided, by the User when an agent approved the earlier one.
 */
export async function afterBrowserRepeat(
  company: CompanyClient,
  previousRef: string,
  headers: Headers | Record<string, string | string[] | undefined>,
  asked: AskedFor,
  opts: OperationOptions & { pollMs?: number | undefined; maxPolls?: number | undefined } = {},
): Promise<
  | { status: 'done' }
  | { status: 'performed' }
  | { status: 'performing' }
  | Awaited<ReturnType<typeof approveWebOperation>>
> {
  const next = webOperationReference(company, headers);
  if (!next) return { status: 'done' };
  const prior = Object.values(company.state.operations ?? {}).find((r) => r.webRef === previousRef);
  for (let i = 0; ; i++) {
    const earlier = await lookupWebOperation(company, previousRef);
    if (earlier.kind === 'status' && earlier.status === 'performed') {
      mark(company, earlier.operationId, { status: 'performed' });
      await company.save();
      return { status: 'performed' };
    }
    if (earlier.kind === 'status' && earlier.status === 'performing') {
      if (i >= (opts.maxPolls ?? 10)) return { status: 'performing' };
      await sleep(opts.pollMs ?? 1000);
      continue;
    }
    break;
  }
  const agentBefore = prior?.approvals.some((a) => a.approver === 'agent') === true;
  return approveWebOperation(company, next.ref, asked, {
    ...opts,
    userOnly: opts.userOnly === true || agentBefore,
  });
}
