import type { ModelMessage, ToolCallStatus, ToolResult } from './types.js';

/**
 * What a store knows about a tool call, read back when its message carries no result for it — see
 * {@link import('./spi/agent-store.js').AgentStore.toolCallOutcomes}.
 */
export interface ToolCallOutcome {
  id: string;
  status: ToolCallStatus;
  output?: unknown;
  error?: string;
}

/** What the model is told about a call whose turn died before the call was settled. */
export const UNFINISHED_TOOL_CALL =
  'This tool call was never completed: the turn it belonged to ended unexpectedly before it was ' +
  'settled. Do not assume it ran, and do not assume it did not — check the current state with a ' +
  'read tool if one exists, tell the person plainly what is and is not confirmed, and do it again ' +
  'only if they still want it.';

/** What is written on the row of a call whose run ended without settling it. */
export const RUN_ENDED_BEFORE_TOOL_CALL = 'the run ended before this tool call was settled';

const DECLINED =
  'The person was asked to approve this action and declined it. Nothing ran and nothing changed.';
const EXPIRED =
  'This action needed approval, and the request expired before anyone decided. Nothing ran.';

/** The ids of every tool call in `messages` that the message asking for it holds no result for. */
export function danglingToolCallIds(messages: readonly ModelMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    const calls = message.toolCalls ?? [];
    if (message.role !== 'assistant' || calls.length === 0) {
      continue;
    }
    const settled = new Set((message.toolResults ?? []).map((result) => result.id));
    for (const call of calls) {
      if (!settled.has(call.id)) {
        ids.push(call.id);
      }
    }
  }
  return ids;
}

function resultFor(
  call: { id: string; name: string },
  outcome: ToolCallOutcome | undefined,
): ToolResult {
  const base = { id: call.id, name: call.name };
  switch (outcome?.status) {
    case 'executed':
    case 'auto_executed':
      return { ...base, output: outcome.output ?? null };
    case 'failed':
      return { ...base, output: null, error: outcome.error ?? UNFINISHED_TOOL_CALL };
    case 'rejected':
      return { ...base, output: { rejected: true }, denied: true, error: DECLINED };
    case 'expired':
      return {
        ...base,
        output: { rejected: true, expired: true },
        denied: true,
        expired: true,
        error: EXPIRED,
      };
    default:
      return { ...base, output: null, error: UNFINISHED_TOOL_CALL };
  }
}

/**
 * Give every tool call in a thread's history a result.
 *
 * A turn writes its results onto the assistant message once the step's LAST tool has settled. A turn
 * that dies before that — its run failed, its worker was killed, an approval was never answered and
 * the run was abandoned — leaves an assistant message that asks for tools and is answered by
 * nothing. A provider refuses a prompt shaped like that (a tool call must be followed by its
 * result), so every LATER turn on the thread fails too, with an error about the stream rather than
 * about the history: one dead turn makes the whole conversation unusable.
 *
 * Here each such call is settled from what is actually known: the call's own row where the store
 * can read it (`outcomes` — a tool that DID run hands the model its real output, so it is not run a
 * second time), and otherwise a result saying the call was never completed. Pure: the same messages
 * and outcomes always produce the same prompt, so a replay composes what the first attempt did.
 * Messages with nothing dangling are returned as they are.
 */
export function settleDanglingToolCalls(
  messages: ModelMessage[],
  outcomes: readonly ToolCallOutcome[] = [],
): ModelMessage[] {
  const known = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  return messages.map((message) => {
    const calls = message.toolCalls ?? [];
    if (message.role !== 'assistant' || calls.length === 0) {
      return message;
    }
    const results = message.toolResults ?? [];
    const settled = new Set(results.map((result) => result.id));
    const missing = calls.filter((call) => !settled.has(call.id));
    if (missing.length === 0) {
      return message;
    }
    return {
      ...message,
      toolResults: [...results, ...missing.map((call) => resultFor(call, known.get(call.id)))],
    };
  });
}
