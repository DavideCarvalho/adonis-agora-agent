import { inScope, type ResolvedAgentTenancy, type TenantScope } from '../agora/tenancy.js';
import { REQUESTER_APPROVER } from '../spi/approval-policy.js';
import type { AgentGovernanceQueries, PendingApprovalRow } from '../spi/governance-queries.js';
import type { QuotaReport, QuotaWindow } from '../spi/quota-provider.js';
import type { Actor, ThreadSummary } from '../types.js';
import type {
  AccountAction,
  AccountActionResult,
  AccountExtension,
  AccountExtensionContext,
  AccountPage,
  Block,
  ListItem,
} from './contract.js';
import { ACCOUNT_MESSAGES } from './messages.js';

/** `config/agent.ts` → `accountConsole`: the agent's pages in the authkit account console. */
export interface AgentAccountConsoleOptions {
  /**
   * The agent actor of a signed-in account. Default: the app user authkit's account mapping hook
   * resolved (`subject`), else the account id, with the account's roles. With tenancy on, the active
   * organization becomes `tenantRef`.
   */
  actor?: (
    account: AccountExtensionContext['account'],
    ctx: AccountExtensionContext,
  ) => Actor | Promise<Actor>;
  /**
   * Link each conversation (and each approval) to your chat page: an app-local path such as
   * `(threadId) => '/chat/' + threadId`. No link when omitted.
   */
  threadUrl?: (threadId: string) => string;
  /** Turn single pages off. All on by default (connections and approvals only when available). */
  pages?: {
    usage?: boolean;
    conversations?: boolean;
    connections?: boolean;
    approvals?: boolean;
  };
}

/** What the agent's account pages read and act through. */
export interface AgentAccountDeps {
  service: {
    quotaReport(actor: Actor): Promise<QuotaReport>;
    listThreads(
      actorRef: string,
      options?: { limit?: number; tenantScope?: TenantScope | null },
    ): Promise<ThreadSummary[]>;
    threadOwner(threadId: string): Promise<string | null>;
    threadTenantRef(threadId: string): Promise<{ tenantRef: string | null } | null>;
    runTenantRef(runId: string): Promise<{ tenantRef: string | null } | null>;
    deleteThread(threadId: string): Promise<void>;
    toolCallRun(toolCallId: string): Promise<string | null>;
    toolCallApproval(
      toolCallId: string,
      runId?: string,
    ): Promise<{ status: string; approver: string | null; expiresAt: string | null } | null>;
    runOwner(runId: string): Promise<string | null>;
    mayDecide(
      actor: Actor,
      decision: { toolCallId: string; approver: string; requesterRef: string },
    ): Promise<boolean>;
    approve(
      runId: string,
      toolCallId: string,
      opts: { executedByRef?: string; via?: string },
    ): Promise<void>;
    reject(
      runId: string,
      toolCallId: string,
      reason: string | undefined,
      opts: { executedByRef?: string; via?: string },
    ): Promise<void>;
  };
  governance?: AgentGovernanceQueries | undefined;
  /** The Poppy connections service, when `poppy_connections_provider` is registered. */
  connections?: () => Promise<AgentAccountConnections | undefined>;
  tenancy: ResolvedAgentTenancy;
  options?: AgentAccountConsoleOptions;
}

/** The slice of `PoppyConnections` the connections page uses. */
export interface AgentAccountConnections {
  ownerOf(actor: Actor): string;
  list(owner: string): Promise<
    Array<{
      domain: string;
      organization: string;
      status: 'pending' | 'active' | 'revoked';
      scope: string;
      connectedSince: number | null;
    }>
  >;
  disconnect(owner: string, domain: string): Promise<boolean>;
}

const PAGE_SIZE = 20;
const MAX_PREVIEW = 300;
/** Recorded as `decidedVia` on approvals settled here, next to the in-app ones. */
export const ACCOUNT_CONSOLE_VIA = 'account-console';

const notFound = (key: string): AccountActionResult => ({
  ok: false,
  status: 404,
  error: { key },
});

/**
 * The agent's contribution to the authkit account console: AI usage (`/account/ai`), conversations,
 * connected agents (Poppy) and pending approvals, each for the signed-in account only.
 */
export function agentAccountExtension(deps: AgentAccountDeps): AccountExtension {
  const options = deps.options ?? {};
  const enabled = (page: keyof NonNullable<AgentAccountConsoleOptions['pages']>) =>
    options.pages?.[page] !== false;

  const actorOf = async (ctx: AccountExtensionContext): Promise<Actor> => {
    const base = options.actor
      ? await options.actor(ctx.account, ctx)
      : { id: ctx.subject?.id ?? ctx.account.id, roles: [...ctx.account.roles] };
    if (!deps.tenancy.enabled || base.tenantRef !== undefined || ctx.activeOrg === null)
      return base;
    return { ...base, tenantRef: ctx.activeOrg.id };
  };

  /** What this account may see under tenancy: the active organization's rows, else none's. */
  const scopeOf = (ctx: AccountExtensionContext): TenantScope | undefined => {
    if (!deps.tenancy.enabled) return undefined;
    return ctx.activeOrg === null
      ? { tenants: [], includeNull: true }
      : { tenants: [ctx.activeOrg.id], includeNull: deps.tenancy.nullRows === 'shared' };
  };

  const ownThread = async (ctx: AccountExtensionContext, actor: Actor, threadId: string) => {
    if ((await deps.service.threadOwner(threadId)) !== actor.id) return false;
    const scope = scopeOf(ctx);
    if (scope === undefined) return true;
    const row = await deps.service.threadTenantRef(threadId);
    return row !== null && inScope(scope, row.tenantRef);
  };

  const pages: AccountPage[] = [];

  if (enabled('usage')) {
    pages.push({
      id: 'agent.usage',
      segment: 'ai',
      title: { key: 'agent.usage.title' },
      nav: { label: { key: 'agent.usage.nav' }, group: 'ai', order: 100 },
      async load(ctx) {
        const report = await deps.service.quotaReport(await actorOf(ctx));
        const blocks: Block[] = [];
        if (report.blocked !== undefined) {
          blocks.push({
            kind: 'notice',
            tone: 'danger',
            text: { key: `agent.usage.blocked.${report.blocked.period}` },
          });
        } else if (report.warning !== undefined) {
          blocks.push({
            kind: 'notice',
            tone: 'warning',
            text: {
              key: 'agent.usage.warning',
              params: { percent: Math.round(report.warning.ratio * 100) },
            },
          });
        }
        for (const window of report.windows) blocks.push(...meters(window));
        if (blocks.length === 0) {
          blocks.push({ kind: 'notice', tone: 'info', text: { key: 'agent.usage.none' } });
        }
        return { blocks };
      },
    });
  }

  if (enabled('conversations')) {
    pages.push({
      id: 'agent.conversations',
      segment: 'conversations',
      title: { key: 'agent.conversations.title' },
      nav: { label: { key: 'agent.conversations.nav' }, group: 'ai', order: 101 },
      async load(ctx) {
        const actor = await actorOf(ctx);
        const offset = cursorOffset(ctx.query.cursor);
        const threads = await deps.service.listThreads(actor.id, {
          limit: offset + PAGE_SIZE + 1,
          tenantScope: scopeOf(ctx) ?? null,
        });
        const page = threads.slice(offset, offset + PAGE_SIZE);
        const items: ListItem[] = page.map((thread) => {
          const href = options.threadUrl?.(thread.id);
          return {
            title: thread.title,
            ...(thread.lastMessagePreview !== undefined
              ? { subtitle: truncate(thread.lastMessagePreview, 140) }
              : {}),
            meta: [{ type: 'date', at: thread.updatedAt, style: 'relative' }],
            ...(href !== undefined ? { href } : {}),
            actions: [{ action: 'delete', target: thread.id }],
          };
        });
        return {
          blocks: [
            {
              kind: 'list',
              empty: { key: 'agent.conversations.empty' },
              items,
              nextCursor: threads.length > offset + PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
            },
          ],
        };
      },
      actions: {
        delete: {
          label: { key: 'agent.conversations.delete' },
          tone: 'danger',
          confirm: { key: 'agent.conversations.deleteConfirm' },
          async handle(ctx, input) {
            const threadId = input.target;
            if (threadId === null) return notFound('agent.notFound');
            const actor = await actorOf(ctx);
            if (!(await ownThread(ctx, actor, threadId))) return notFound('agent.notFound');
            await deps.service.deleteThread(threadId);
            return { ok: true, flash: { key: 'agent.conversations.deleted' } };
          },
        },
      },
    });
  }

  if (enabled('connections') && deps.connections !== undefined) {
    const connections = deps.connections;
    pages.push({
      id: 'agent.connections',
      segment: 'connected-agents',
      title: { key: 'agent.connections.title' },
      nav: { label: { key: 'agent.connections.nav' }, group: 'ai', order: 102 },
      async visible() {
        return (await connections()) !== undefined;
      },
      async load(ctx) {
        const service = await connections();
        if (service === undefined) return { blocks: [] };
        const rows = await service.list(service.ownerOf(await actorOf(ctx)));
        const items: ListItem[] = rows.map((row) => ({
          title: row.organization || row.domain,
          subtitle: row.domain,
          badge: {
            type: 'badge',
            text: { key: `agent.connections.status.${row.status}` },
            tone:
              row.status === 'active'
                ? 'success'
                : row.status === 'pending'
                  ? 'warning'
                  : 'neutral',
          },
          ...(row.connectedSince !== null
            ? { meta: [{ type: 'date', at: new Date(row.connectedSince), style: 'date' }] }
            : {}),
          ...(row.status === 'revoked'
            ? {}
            : { actions: [{ action: 'disconnect', target: row.domain }] }),
        }));
        return {
          blocks: [{ kind: 'list', empty: { key: 'agent.connections.empty' }, items }],
        };
      },
      actions: {
        disconnect: {
          label: { key: 'agent.connections.disconnect' },
          tone: 'danger',
          sudo: true,
          confirm: { key: 'agent.connections.disconnectConfirm' },
          async handle(ctx, input) {
            const service = await connections();
            const domain = input.target;
            if (service === undefined || domain === null) return notFound('agent.notFound');
            const owner = service.ownerOf(await actorOf(ctx));
            const known = (await service.list(owner)).some(
              (row) => row.domain === domain && row.status !== 'revoked',
            );
            if (!known) return notFound('agent.notFound');
            await service.disconnect(owner, domain);
            return { ok: true, flash: { key: 'agent.connections.disconnected' } };
          },
        },
      },
    });
  }

  if (enabled('approvals') && deps.governance !== undefined) {
    const governance = deps.governance;
    const decide = (kind: 'approve' | 'reject'): AccountAction => ({
      label: { key: `agent.approvals.${kind}` },
      tone: kind === 'reject' ? 'danger' : 'default',
      confirm: { key: `agent.approvals.${kind}Confirm` },
      ...(kind === 'reject'
        ? {
            fields: [
              {
                name: 'reason',
                label: { key: 'agent.approvals.reason' },
                kind: 'textarea' as const,
                maxLength: 500,
              },
            ],
          }
        : {}),
      async handle(ctx, input) {
        const toolCallId = input.target;
        if (toolCallId === null) return notFound('agent.notFound');
        const actor = await actorOf(ctx);
        const verdict = await mayDecideHere(deps, actor, toolCallId, scopeOf(ctx));
        if (!verdict.ok) return verdict.result;
        const opts = { executedByRef: actor.id, via: ACCOUNT_CONSOLE_VIA };
        try {
          if (kind === 'approve') await deps.service.approve(verdict.runId, toolCallId, opts);
          else {
            const reason = input.fields.reason?.trim();
            await deps.service.reject(
              verdict.runId,
              toolCallId,
              reason === undefined || reason === '' ? undefined : reason,
              opts,
            );
          }
        } catch {
          return { ok: false, status: 409, error: { key: 'agent.approvals.notWaiting' } };
        }
        return {
          ok: true,
          flash: {
            key: kind === 'approve' ? 'agent.approvals.approved' : 'agent.approvals.rejected',
          },
        };
      },
    });
    pages.push({
      id: 'agent.approvals',
      segment: 'approvals',
      title: { key: 'agent.approvals.title' },
      nav: { label: { key: 'agent.approvals.nav' }, group: 'ai', order: 103 },
      async load(ctx) {
        const actor = await actorOf(ctx);
        const scope = scopeOf(ctx);
        const view = scope === undefined ? governance : governance.forTenants?.(scope);
        const rows: PendingApprovalRow[] = [];
        if (view !== undefined) {
          // Calls of the account's own runs, then calls put to a role the account may decide for.
          rows.push(...(await view.pendingApprovals({ actor: actor.id, limit: 50 })));
          const roles = (actor.roles ?? []).filter((role) => role !== REQUESTER_APPROVER);
          if (roles.length > 0) {
            for (const row of await view.pendingApprovals({ approvers: roles, limit: 50 })) {
              if (rows.some((own) => own.toolCallId === row.toolCallId)) continue;
              const approval = await deps.service.toolCallApproval(
                row.toolCallId,
                row.runId ?? undefined,
              );
              const approver = approval?.approver;
              if (approver == null || approver === REQUESTER_APPROVER) continue;
              if (
                await deps.service.mayDecide(actor, {
                  toolCallId: row.toolCallId,
                  approver,
                  requesterRef: row.actorRef,
                })
              ) {
                rows.push(row);
              }
            }
          }
        }
        // One inbox, oldest first, capped like the in-app one.
        rows.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
        rows.splice(50);
        const items: ListItem[] = rows.map((row) => {
          const href = options.threadUrl?.(row.threadId);
          return {
            title: row.toolName,
            subtitle: truncate(previewInput(row.input), MAX_PREVIEW),
            meta: [{ type: 'date', at: row.requestedAt, style: 'relative' }],
            ...(href !== undefined && row.threadId !== '' ? { href } : {}),
            actions: [
              { action: 'approve', target: row.toolCallId },
              { action: 'reject', target: row.toolCallId },
            ],
          };
        });
        return {
          blocks: [{ kind: 'list', empty: { key: 'agent.approvals.empty' }, items }],
        };
      },
      actions: { approve: decide('approve'), reject: decide('reject') },
    });
  }

  return { id: 'agent', contract: 1, messages: ACCOUNT_MESSAGES, pages };
}

/**
 * The same rules as the in-app `POST /agent/tool-call/approve|reject`: the call must be waiting, its
 * run must be this account's (or its recorded approver a role this account may decide for), it must
 * not have lapsed, and with tenancy on it must belong to the active organization. Anything the
 * account may not address is "not found".
 */
async function mayDecideHere(
  deps: AgentAccountDeps,
  actor: Actor,
  toolCallId: string,
  scope: TenantScope | undefined,
): Promise<{ ok: true; runId: string } | { ok: false; result: AccountActionResult }> {
  const fail = (result: AccountActionResult) => ({ ok: false as const, result });
  const runId = await deps.service.toolCallRun(toolCallId);
  if (runId === null) return fail(notFound('agent.notFound'));
  if (scope !== undefined) {
    const row = await deps.service.runTenantRef(runId);
    if (row === null || !inScope(scope, row.tenantRef)) return fail(notFound('agent.notFound'));
  }
  const approval = await deps.service.toolCallApproval(toolCallId, runId);
  const owner = await deps.service.runOwner(runId);
  if (owner === null) return fail(notFound('agent.notFound'));
  const approver = approval?.approver ?? REQUESTER_APPROVER;
  if (approver === REQUESTER_APPROVER) {
    if (owner !== actor.id) return fail(notFound('agent.notFound'));
  } else if (
    !(await deps.service.mayDecide(actor, { toolCallId, approver, requesterRef: owner }))
  ) {
    return fail(notFound('agent.notFound'));
  }
  if (approval !== null && approval.status === 'expired') {
    return fail({ ok: false, status: 409, error: { key: 'agent.approvals.expired' } });
  }
  if (approval !== null && approval.status !== 'pending_approval') {
    return fail({ ok: false, status: 409, error: { key: 'agent.approvals.notWaiting' } });
  }
  if (approval?.expiresAt != null && Date.parse(approval.expiresAt) <= Date.now()) {
    return fail({ ok: false, status: 409, error: { key: 'agent.approvals.expired' } });
  }
  return { ok: true, runId };
}

/** A token meter and a spend meter for one quota window (the ones it has a ceiling or usage for). */
function meters(window: QuotaWindow): Block[] {
  const label = { key: `agent.usage.window.${window.period}` };
  const out: Block[] = [];
  if (window.usedTokens !== undefined) {
    out.push({
      kind: 'meter',
      label,
      used: window.usedTokens,
      limit: window.limitTokens ?? null,
      unit: { key: 'agent.usage.tokens' },
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    });
  }
  if (window.limitUsd !== undefined || window.usedTokens === undefined) {
    out.push({
      kind: 'meter',
      label,
      used: Math.round(window.usedUsd * 100) / 100,
      limit: window.limitUsd ?? null,
      unit: { key: 'agent.usage.usd' },
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    });
  }
  return out;
}

function cursorOffset(cursor: string | undefined): number {
  const parsed = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 0;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A one-line, readable preview of what the tool would run with. */
function previewInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
