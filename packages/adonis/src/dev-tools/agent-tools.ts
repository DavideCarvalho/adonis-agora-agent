import { withActorLabel, withActorLabels } from '../actor-labels.js';
import type { ActorDirectory } from '../spi/actor-directory.js';
import type {
  AgentGovernanceQueries,
  RunStatus,
  ToolStatsRange,
} from '../spi/governance-queries.js';
import type { DevTool, DevToolInputProperty } from './contract.js';
import { DEV_TOOLS_MAX_ROWS, truncateText } from './limits.js';

/** How much of each message `agent_get_run` returns with `includeMessages: true`. */
const MESSAGE_BYTES = 2 * 1024;
const DEFAULT_LIMIT = 20;

const day: DevToolInputProperty = {
  type: 'string',
  description: 'UTC day, YYYY-MM-DD (inclusive).',
};
const limit: DevToolInputProperty = {
  type: 'integer',
  description: `Rows to return (default ${DEFAULT_LIMIT}, max ${DEV_TOOLS_MAX_ROWS}).`,
  minimum: 1,
  maximum: DEV_TOOLS_MAX_ROWS,
};

const today = () => new Date().toISOString().slice(0, 10);
const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
const limitOf = (input: Record<string, unknown>) =>
  typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT;
const dayRange = (input: Record<string, unknown>) => ({
  fromDay: str(input.from) ?? today(),
  toDay: str(input.to) ?? str(input.from) ?? today(),
});
/** Drop the `undefined` values, so optional filters stay absent (`exactOptionalPropertyTypes`). */
const compact = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
const optionalRange = (input: Record<string, unknown>): ToolStatsRange =>
  compact({ from: str(input.from), to: str(input.to) });

/**
 * The agent's own developer tools (lib `agent`): the governance console's read-model, read-only.
 * No actions: approving a tool call over MCP would bypass the human approval it exists for.
 * Each tool reads exactly what the matching `/agent/governance/*` route serves.
 */
export function agentDevTools(options: {
  governance: AgentGovernanceQueries;
  actorDirectory?: ActorDirectory | null;
}): DevTool[] {
  const gov = options.governance;
  const directory = options.actorDirectory ?? null;
  return [
    {
      name: 'agent_list_runs',
      kind: 'read',
      description:
        'Agent runs (turns), newest first: agent, actor, status, tokens, cost and timing. Filters: agent, status, actor, from/to (UTC days). Returns { items, next }; pass next as cursor for the next page.',
      input: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent name.' },
          status: { type: 'string', enum: ['running', 'completed', 'failed', 'cancelled'] },
          actor: { type: 'string', description: 'Actor ref.' },
          from: day,
          to: day,
          cursor: { type: 'string', description: 'The next of a previous page.' },
          limit,
        },
      },
      async run(input) {
        const page = await gov.listRuns({
          first: limitOf(input),
          ...compact({
            agent: str(input.agent),
            status: str(input.status) as RunStatus | undefined,
            actor: str(input.actor),
            from: str(input.from),
            to: str(input.to),
            after: str(input.cursor),
          }),
        });
        return {
          items: await withActorLabels(page.items, directory),
          next: page.nextCursor,
        };
      },
    },
    {
      name: 'agent_get_run',
      kind: 'read',
      description:
        "One run's trace: the run, its tool calls, pending approvals, usage and timings. Messages only with includeMessages: true, each cut to 2 KB. null when the id is unknown.",
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Run id.' },
          includeMessages: {
            type: 'boolean',
            description: 'Include the messages (default false).',
          },
        },
        required: ['id'],
      },
      async run(input) {
        const detail = await gov.runDetail(String(input.id));
        if (detail === null) return null;
        const { messages, ...rest } = detail;
        return {
          ...rest,
          run: (await withActorLabel(detail.run, directory)) ?? detail.run,
          ...(input.includeMessages === true
            ? {
                messages: messages.map((message) => ({
                  ...message,
                  content: truncateText(String(message.content ?? ''), MESSAGE_BYTES),
                })),
              }
            : { messageCount: messages.length }),
        };
      },
    },
    {
      name: 'agent_get_spend',
      kind: 'read',
      description:
        'Token and cost rollup over a range of UTC days (default today), by model, actor or feature.',
      input: {
        type: 'object',
        properties: {
          by: {
            type: 'string',
            enum: ['model', 'actor', 'feature'],
            description: 'Default model.',
          },
          from: day,
          to: day,
        },
      },
      async run(input) {
        const range = dayRange(input);
        const by = str(input.by) ?? 'model';
        if (by === 'actor') {
          return { items: await withActorLabels(await gov.spendByActor(range), directory) };
        }
        if (by === 'feature') {
          if (gov.spendByFeature === undefined) {
            throw new Error('this governance adapter does not report spend by feature');
          }
          return { items: await gov.spendByFeature(range) };
        }
        return { items: await gov.spendByModel(range) };
      },
    },
    {
      name: 'agent_get_tool_stats',
      kind: 'read',
      description:
        'Per-tool calls, failures, rejections and latency, most called first. Optional from/to bound.',
      input: { type: 'object', properties: { from: day, to: day } },
      async run(input) {
        return { items: await gov.perToolStats(optionalRange(input)) };
      },
    },
    {
      name: 'agent_get_reliability',
      kind: 'read',
      description:
        'Run success, failure and cancel rates plus the mean settled duration. Optional from/to bound.',
      input: { type: 'object', properties: { from: day, to: day } },
      async run(input) {
        return gov.runReliability(optionalRange(input));
      },
    },
    {
      name: 'agent_list_pending_approvals',
      kind: 'read',
      description:
        'Tool calls waiting for a human approval, across every actor, oldest first. Read-only: approve them in the app.',
      input: {
        type: 'object',
        properties: { actor: { type: 'string', description: 'Actor ref.' }, limit },
      },
      async run(input) {
        const rows = await gov.pendingApprovals({
          limit: limitOf(input),
          ...compact({ actor: str(input.actor) }),
        });
        return { items: await withActorLabels(rows, directory), next: null };
      },
    },
    {
      name: 'agent_list_recent_tool_calls',
      kind: 'read',
      description: 'The most recent tool calls of every agent, newest first.',
      input: { type: 'object', properties: { limit } },
      async run(input) {
        return { items: await gov.recentToolCalls(limitOf(input)), next: null };
      },
    },
  ];
}
