import { args, flags } from '@adonisjs/core/ace';
import { AgentCommand, dayFlag, opt } from '../src/cli/agent_command.js';
import {
  governancePendingApprovalsPage,
  governanceRunDetail,
  governanceRunsPage,
  governanceThreadDetail,
  governanceThreadsPage,
  governanceToolCallsPage,
} from '../src/governance-reads.js';
import type { ListQuery } from '../src/list-api.js';

const usd = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `$${value.toFixed(4)}`;
const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${value}ms`;

/** The cursor paging flags of a list (`--after`/`--before` + `--first`/`--last`). */
abstract class PagedList extends AgentCommand {
  @flags.string({ description: 'Only this organization (with tenancy on)' })
  declare tenant?: string;

  @flags.string({ description: 'The page after this cursor' })
  declare after?: string;

  @flags.string({ description: 'The page before this cursor' })
  declare before?: string;

  @flags.number({ description: 'Page size (default 50, at most 200)' })
  declare first?: number;

  @flags.number({ description: 'Page size, counted back from --before' })
  declare last?: number;

  protected paging(): ListQuery {
    return this.pagingQuery({
      after: this.after,
      before: this.before,
      first: this.first,
      last: this.last,
    });
  }
}

/** `agent:runs:list` — the console's Runs list, newest first. */
export class AgentRunsList extends AgentCommand {
  static override commandName = 'agent:runs:list';
  static override description = 'List agent runs, newest first';

  @flags.string({ description: 'Only this organization (with tenancy on)' })
  declare tenant?: string;

  @flags.string({ description: 'Only this actor ref' })
  declare actor?: string;

  @flags.string({ description: 'Only this agent' })
  declare agent?: string;

  @flags.string({ description: 'running, completed, failed or cancelled' })
  declare status?: string;

  @flags.string({ description: 'Started on or after this UTC day (YYYY-MM-DD)' })
  declare from?: string;

  @flags.string({ description: 'Started on or before this UTC day (YYYY-MM-DD)' })
  declare to?: string;

  @flags.string({ description: 'The page after this cursor' })
  declare after?: string;

  @flags.number({ description: 'Page size (default 50, at most 200)' })
  declare first?: number;

  protected async execute() {
    const console = await this.governance();
    const filter: Record<string, unknown> = {};
    if (opt(this.actor) !== undefined) filter.actor = this.actor;
    if (opt(this.agent) !== undefined) filter.agent = this.agent;
    if (opt(this.status) !== undefined) filter.status = this.status;
    const from = dayFlag('from', this.from);
    const to = dayFlag('to', this.to);
    if (from !== undefined && to !== undefined) filter.startedAt = { between: [from, to] };
    else if (from !== undefined) filter.startedAt = { gte: from };
    else if (to !== undefined) filter.startedAt = { lte: to };
    const page = await governanceRunsPage(
      console.queries(opt(this.tenant)),
      console.actorDirectory,
      {
        filter,
        ...this.pagingQuery({ after: this.after, first: this.first }),
      },
    );
    return this.output(page, (value) => {
      this.table(
        ['Run', 'Agent', 'Actor', 'Status', 'Started', 'Duration', 'Tokens', 'Cost'],
        value.data.map((run) => [
          run.runId,
          run.agentName ?? '—',
          run.actorLabel ?? run.actorRef,
          run.status,
          run.startedAt,
          ms(run.durationMs),
          run.inputTokens + run.outputTokens,
          usd(run.costUsd),
        ]),
        'No runs.',
      );
      this.cursorHint(value.meta);
    });
  }
}

/** `agent:runs:show <id>` — one run's trace: run, tool calls, approvals, usage (and messages). */
export class AgentRunsShow extends AgentCommand {
  static override commandName = 'agent:runs:show';
  static override description = "Show one run's trace";

  @args.string({ description: 'Run id' })
  declare id: string;

  @flags.string({ description: 'Only within this organization (with tenancy on)' })
  declare tenant?: string;

  @flags.boolean({ description: 'Also print the messages' })
  declare messages: boolean;

  protected async execute() {
    const console = await this.governance();
    const detail = await governanceRunDetail(
      console.queries(opt(this.tenant)),
      console.actorDirectory,
      this.id,
    );
    if (detail === null) return this.refuse(`No run "${this.id}".`);
    return this.output(detail, (value) => {
      const { run } = value;
      this.pairs([
        ['Run', run.runId],
        ['Thread', run.threadId],
        ['Agent', run.agentName],
        ['Actor', run.actorLabel ?? run.actorRef],
        ['Status', run.status],
        ['Started', run.startedAt],
        ['Finished', run.finishedAt],
        ['Duration', ms(run.durationMs)],
        ['Tokens in/out', `${run.inputTokens}/${run.outputTokens}`],
        ['Cost', usd(run.costUsd)],
        ['Error', run.error],
      ]);
      this.table(
        ['Tool call', 'Tool', 'Status', 'Time', 'Error'],
        value.toolCalls.map((call) => [
          call.toolCallId,
          call.toolName,
          call.status,
          ms(call.executionMs),
          call.error ?? '',
        ]),
        'No tool calls.',
      );
      if (this.messages) {
        for (const message of value.messages) {
          this.logger.log(`[${message.role}] ${message.content}`);
        }
      } else {
        this.logger.log(`${value.messages.length} messages (--messages to print them)`);
      }
    });
  }
}

/** `agent:threads:list` — the recent thread activity feed (the console's Threads tab). */
export class AgentThreadsList extends PagedList {
  static override commandName = 'agent:threads:list';
  static override description = 'List threads by recent activity, newest first';

  protected async execute() {
    const console = await this.governance();
    const page = await governanceThreadsPage(
      console.queries(opt(this.tenant)),
      console.actorDirectory,
      this.paging(),
    );
    return this.output(page, (value) => {
      this.table(
        ['Thread', 'Title', 'Actor', 'Messages', 'Tokens', 'Last activity'],
        value.data.map((thread) => [
          thread.threadId,
          thread.title,
          thread.actorLabel ?? thread.actorRef,
          thread.messageCount,
          thread.totalTokens,
          thread.lastActivityAt,
        ]),
        'No threads.',
      );
      this.cursorHint(value.meta);
    });
  }
}

/** `agent:threads:show <id>` — one thread's drill-down: usage rollup, runs and messages. */
export class AgentThreadsShow extends AgentCommand {
  static override commandName = 'agent:threads:show';
  static override description = "Show one thread's usage, runs and messages";

  @args.string({ description: 'Thread id' })
  declare id: string;

  @flags.string({ description: 'Only within this organization (with tenancy on)' })
  declare tenant?: string;

  protected async execute() {
    const console = await this.governance();
    const detail = await governanceThreadDetail(
      console.queries(opt(this.tenant)),
      console.actorDirectory,
      this.id,
    );
    if (detail === undefined) {
      return this.refuse('This governance adapter does not support thread detail.');
    }
    if (detail === null) return this.refuse(`No thread "${this.id}".`);
    return this.output(detail, (value) => {
      this.pairs([
        ['Thread', value.threadId],
        ['Title', value.title],
        ['Actor', value.actorLabel ?? value.actorRef],
        ['Created', value.createdAt],
        ['Updated', value.updatedAt],
        ['Deleted', value.deleted ? 'yes' : 'no'],
        ['Runs', value.usage.runCount],
        ['Messages', value.usage.messageCount],
        ['Tokens', value.usage.totalTokens],
        ['Cost', usd(value.usage.costUsd)],
      ]);
      this.table(
        ['Run', 'Status', 'Started', 'Cost'],
        value.runs.map((run) => [run.runId, run.status, run.startedAt, usd(run.costUsd)]),
        'No runs.',
      );
    });
  }
}

/** `agent:tool-calls:list` — the recent tool-call activity feed, newest first. */
export class AgentToolCallsList extends PagedList {
  static override commandName = 'agent:tool-calls:list';
  static override description = 'List recent tool calls, newest first';

  protected async execute() {
    const page = await governanceToolCallsPage(
      (await this.governance()).queries(opt(this.tenant)),
      this.paging(),
    );
    return this.output(page, (value) => {
      this.table(
        ['Tool call', 'Tool', 'Type', 'Status', 'Thread', 'At'],
        value.data.map((call) => [
          call.toolCallId,
          call.toolName,
          call.toolType,
          call.status,
          call.threadId,
          call.createdAt,
        ]),
        'No tool calls.',
      );
      this.cursorHint(value.meta);
    });
  }
}

/** `agent:approvals:list` — the cross-actor HITL inbox, oldest first. */
export class AgentApprovalsList extends PagedList {
  static override commandName = 'agent:approvals:list';
  static override description = 'List tool calls waiting for a human approval, oldest first';

  @flags.string({ description: 'Only this actor ref' })
  declare actor?: string;

  protected async execute() {
    const console = await this.governance();
    const page = await governancePendingApprovalsPage(
      console.queries(opt(this.tenant)),
      console.actorDirectory,
      {
        ...(opt(this.actor) !== undefined ? { filter: { actor: this.actor } } : {}),
        ...this.paging(),
      },
    );
    return this.output(page, (value) => {
      this.table(
        ['Tool call', 'Tool', 'Run', 'Actor', 'Requested'],
        value.data.map((row) => [
          row.toolCallId,
          row.toolName,
          row.runId ?? '—',
          row.actorLabel ?? row.actorRef,
          row.requestedAt,
        ]),
        'No pending approvals.',
      );
      this.cursorHint(value.meta);
    });
  }
}
