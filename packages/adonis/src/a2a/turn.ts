import { createHash } from 'node:crypto';
import type { AgentService } from '../agent-service.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { Actor } from '../types.js';
import { scopeRole } from './gate.js';
import { PERMISSION_COMPONENT } from './permission-tool.js';

/**
 * What an A2A turn does with an `action` call that parks for approval:
 *  - `'approve-delegated'` (default) — approve it when the caller's delegation grants one of the
 *    tool's roles: the user approved that scope on their own account page, which IS the consent the
 *    in-app approval stands for. Anything else is rejected.
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

type TurnService = Pick<
  AgentService,
  'chat' | 'subscribe' | 'approve' | 'reject' | 'skip' | 'cancel'
>;

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
  service: TurnService,
  registry: ToolRegistry,
  input: A2aTurnInput,
): Promise<A2aTurnResult> {
  const { runId, threadId } = await service.chat({
    actor: input.actor,
    message: input.text,
    agentName: input.agentName,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : { transient: true }),
  });

  const result: A2aTurnResult = { threadId, text: '', permission: null, actions: [], error: null };
  const delegated = input.delegatedScopes ?? [];
  // The delegated scopes a tool's roles name (as `scope:<id>` roles).
  const scopesOf = (tool: string) => {
    const roles = registry.spec(tool)?.roles ?? [];
    return delegated.filter((scope) => roles.includes(scopeRole(scope)));
  };
  // Announced calls, by id, until their output says they ran.
  const calls = new Map<string, { name: string; input: unknown }>();
  const cancel = () => service.cancel(runId).catch(() => {});

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
        } else if (event.kind === 'tool-output') {
          const call = calls.get(event.id);
          const scopes = call ? scopesOf(call.name) : [];
          if (call && scopes.length > 0) {
            result.actions.push({ tool: call.name, argsHash: argsHash(call.input), scopes });
          }
        }
      } else if (frame.t === 'approval') {
        // An independent proposal waits for a person in the app's own approval flow — not ours.
        if (frame.target?.kind === 'proposal') continue;
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
  } catch (error) {
    // Nobody will read this run's stream any more: leaving it parked would hold the thread's
    // active stream, and every later message to this context would be refused as busy.
    await cancel();
    throw error;
  } finally {
    clearTimeout(timer);
    void stream.return?.();
  }
  return result;
}
