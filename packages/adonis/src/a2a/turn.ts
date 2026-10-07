import { createHash } from 'node:crypto';
import type { AgentService } from '../agent-service.js';
import type { Actor } from '../types.js';
import { SCOPE_ROLE_PREFIX, scopeRole } from './gate.js';
import { PERMISSION_COMPONENT } from './permission-tool.js';

/**
 * What an A2A turn does with an `action` call that parks for approval:
 *  - `'approve-delegated'` (default) — approve it when the caller's delegation grants one of the
 *    tool's roles: the user approved that scope on their own account page, which IS the consent the
 *    in-app approval stands for. Anything else is rejected. An independent proposal
 *    (`actionApprovalMode: 'independent'`) is decided the same way once the run ends, and the turn
 *    waits for it to execute, so the reply never claims an action that did not happen.
 *  - `'reject'` — reject every action; personal agents only read.
 */
export type A2aActionPolicy = 'approve-delegated' | 'reject';

export interface A2aTurnInput {
  actor: Actor;
  text: string;
  agentName: string;
  /** Continue this thread; omitted → a new (transient) one. */
  threadId?: string;
  /** Scopes the caller's delegation grants; `null` without a delegation. */
  delegatedScopes: string[] | null;
  actions: A2aActionPolicy;
  /** Give up (and cancel the run) after this long. */
  timeoutMs: number;
  /** Called once the run started, with the thread it runs in — before its frames are read. */
  onStarted?: (threadId: string) => Promise<void>;
}

export interface A2aTurnAction {
  tool: string;
  argsHash: string;
  /** The delegated scopes that authorized it. */
  scopes: string[];
}

export interface A2aTurnResult {
  threadId: string;
  text: string;
  /** Scopes the agent asked the user for (`request_permission`); `null` when it asked for none. */
  permission: string[] | null;
  /** Tools that RAN under a delegated scope (reads and approved actions) — what a receipt lists. */
  actions: A2aTurnAction[];
  /** Why the run failed, when it did. */
  error: string | null;
}

/**
 * What runs an A2A turn: start it, read its frames, settle what it parks on. `AgentService` (the
 * agent provider's) is one; an app with its own runtime — a `runAgentLoop` built per request, say —
 * writes an adapter with the same shape (`defineA2aConfig({ service })`).
 */
export interface A2aTurnService
  extends Pick<AgentService, 'chat' | 'subscribe' | 'approve' | 'reject' | 'skip' | 'cancel'>,
    Partial<Pick<AgentService, 'decideActionProposal' | 'listActionProposals'>> {
  /**
   * The roles a tool declares — what an approval and a receipt match the delegated scopes against.
   * Omitted → the shared `ToolRegistry`. An app whose registry is built per turn answers it here.
   */
  toolRoles?(toolName: string): string[] | undefined;
}

/** How often a turn looks at an approved proposal while it waits for it to execute. */
const PROPOSAL_POLL_MS = 250;

function argsHash(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input ?? null))
    .digest('base64url');
}

/**
 * Run one A2A turn to completion and read its outcome off the stream. A2A's `message:send` is
 * synchronous (PACT §4.2), so the run's frames are consumed here until the stream ends: text is the
 * reply, an approval is decided on the spot by {@link A2aActionPolicy}, a question set is skipped
 * (there is no human on this side to answer it — the agent proceeds on its own assumptions), and a
 * `request_permission` call becomes a step-up.
 */
export async function runA2aTurn(
  service: A2aTurnService,
  /** The roles a tool declares (see {@link A2aTurnService.toolRoles}). */
  toolRoles: (toolName: string) => string[] | undefined,
  input: A2aTurnInput,
): Promise<A2aTurnResult> {
  const { runId, threadId } = await service.chat({
    actor: input.actor,
    message: input.text,
    agentName: input.agentName,
    // A prompt can tell it is answering a personal agent, not the person in the app.
    pageContext: { channel: 'a2a' },
    ...(input.threadId !== undefined ? { threadId: input.threadId } : { transient: true }),
  });

  const result: A2aTurnResult = { threadId, text: '', permission: null, actions: [], error: null };
  const delegated = input.delegatedScopes ?? [];
  // The delegated scopes a tool's roles name (as `scope:<id>` roles).
  const scopesOf = (tool: string) => {
    const roles = toolRoles(tool) ?? [];
    return delegated.filter((scope) => roles.includes(scopeRole(scope)));
  };
  // Announced calls, by id, until their output says they ran.
  const calls = new Map<string, { name: string; input: unknown }>();
  // Independent proposals the run left behind, decided once it ends.
  const proposals: { id: string; toolName: string; toolCallId: string }[] = [];
  // Set once the turn answered (or gave up): a wait still polling stops there.
  let finished = false;
  const cancel = () => service.cancel(runId).catch(() => {});

  /**
   * Decide the proposals by {@link A2aActionPolicy} and wait for the approved ones to execute. One
   * the caller may not decide (another approver) stays with the app, and is not reported as done.
   */
  const settleProposals = async (): Promise<void> => {
    const { decideActionProposal, listActionProposals } = service;
    if (!decideActionProposal || !listActionProposals) return;
    for (const proposal of proposals) {
      const scopes = scopesOf(proposal.toolName);
      const approve = input.actions === 'approve-delegated' && scopes.length > 0;
      try {
        await decideActionProposal.call(
          service,
          input.actor,
          threadId,
          proposal.id,
          approve ? 'approved' : 'rejected',
          approve
            ? {}
            : {
                reason:
                  'A personal agent may not run this action without a delegated permission for it.',
              },
          'a2a',
        );
      } catch {
        continue;
      }
      if (!approve) continue;
      while (!finished) {
        const listed = await listActionProposals.call(service, input.actor, threadId);
        const current = listed.find((p) => p.id === proposal.id);
        const status = current?.execution?.status;
        if (current?.decision !== 'approved' || status === 'failed') {
          result.error = current?.execution?.error ?? `${proposal.toolName} did not run`;
          return;
        }
        if (status === 'succeeded') {
          result.actions.push({
            tool: proposal.toolName,
            argsHash: argsHash(calls.get(proposal.toolCallId)?.input ?? current.input),
            scopes,
          });
          const said = current.outcome?.text?.trim();
          if (said) result.text = result.text ? `${result.text}\n\n${said}` : said;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, PROPOSAL_POLL_MS));
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  // A HARD deadline: if cancelling does not end the stream, the request still answers.
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), input.timeoutMs);
  });
  const stream = service.subscribe(runId)[Symbol.asyncIterator]();

  try {
    await input.onStarted?.(threadId);
    for (;;) {
      const next = await Promise.race([stream.next(), deadline]);
      if (next === 'timeout') {
        result.error = 'timeout';
        await cancel();
        break;
      }
      if (next.done) break;
      const frame = next.value;
      if (frame.t === 'text') {
        result.text += frame.v;
      } else if (frame.t === 'component' && frame.name === PERMISSION_COMPONENT) {
        const scopes = (frame.data as { scopes?: unknown } | null)?.scopes;
        if (Array.isArray(scopes)) {
          result.permission = [...new Set([...(result.permission ?? []), ...scopes.map(String)])];
        }
      } else if (frame.t === 'event') {
        const event = frame.event;
        if (event.kind === 'tool-input-available') {
          calls.set(event.id, { name: event.name, input: event.input });
        } else if (event.kind === 'tool-output-error') {
          // A tool behind a scope the caller did not delegate is offered but not run
          // (`personalAgentGate`): its denied call IS the request for that scope.
          const call = calls.get(event.id);
          const missing = (call ? (toolRoles(call.name) ?? []) : [])
            .filter((role) => role.startsWith(SCOPE_ROLE_PREFIX))
            .map((role) => role.slice(SCOPE_ROLE_PREFIX.length))
            .filter((scope) => !delegated.includes(scope));
          if (missing.length > 0) {
            result.permission = [...new Set([...(result.permission ?? []), ...missing])];
          }
        } else if (event.kind === 'tool-output') {
          const call = calls.get(event.id);
          const scopes = call ? scopesOf(call.name) : [];
          if (call && scopes.length > 0) {
            result.actions.push({ tool: call.name, argsHash: argsHash(call.input), scopes });
          }
        }
      } else if (frame.t === 'approval') {
        if (frame.target?.kind === 'proposal') {
          proposals.push({
            id: frame.target.proposalId,
            toolName: frame.toolName,
            toolCallId: frame.id,
          });
          continue;
        }
        if (input.actions === 'approve-delegated' && scopesOf(frame.toolName).length > 0) {
          await service.approve(frame.runId, frame.id, {
            executedByRef: input.actor.id,
            via: 'a2a',
          });
        } else {
          await service.reject(
            frame.runId,
            frame.id,
            'A personal agent may not run this action without a delegated permission for it.',
            { executedByRef: input.actor.id, via: 'a2a' },
          );
        }
      } else if (frame.t === 'elicitation') {
        await service.skip({
          runId: frame.runId,
          toolCallId: frame.id,
          answeredByRef: input.actor.id,
          answeredVia: 'a2a',
        });
      } else if (frame.t === 'error') {
        result.error = frame.message;
      }
    }
    if (result.error === null && proposals.length > 0) {
      const settled = await Promise.race([settleProposals(), deadline]);
      if (settled === 'timeout') result.error = 'timeout';
    }
  } catch (error) {
    // Nobody will read this run's stream any more: leaving it parked would hold the thread's
    // active stream, and every later message to this context would be refused as busy.
    await cancel();
    throw error;
  } finally {
    finished = true;
    clearTimeout(timer);
    void stream.return?.();
  }
  return result;
}
