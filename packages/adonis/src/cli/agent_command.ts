/**
 * The shared base of the `agent:*` operator commands: boots the app (never its workers or server —
 * the provider's `start` is a no-op under ace), reads the instances the console routes use from the
 * container, and prints a table or, with `--json`, one JSON document. A refusal prints to stderr and
 * exits `1`.
 */
import { userInfo } from 'node:os';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { AgentService } from '../agent-service.js';
import { AgentGovernanceConsole, GovernanceUnavailableError } from '../governance-console.js';
import { InvalidColumnFilterError, type ListQuery } from '../list-api.js';
import type { Actor } from '../types.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A refusal the command prints as is (no stack) before exiting `1`. */
export class CliRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliRefusal';
  }
}

/** Who a command acts as: `cli:<os user>` (or `cli` when the OS user cannot be read). */
export function cliActorRef(): string {
  try {
    const name = userInfo().username;
    return name ? `cli:${name}` : 'cli';
  } catch {
    return 'cli';
  }
}

/** `undefined` for an absent or empty flag, else the string. */
export function opt(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** A UTC day flag, checked (`YYYY-MM-DD`). */
export function dayFlag(name: string, value: string | undefined): string | undefined {
  const day = opt(value);
  if (day !== undefined && !DAY.test(day)) {
    throw new CliRefusal(`--${name} takes a UTC day (YYYY-MM-DD); got "${day}".`);
  }
  return day;
}

export const today = () => new Date().toISOString().slice(0, 10);

export abstract class AgentCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Print one JSON document to stdout' })
  declare json: boolean;

  /** Write the command's result: JSON with `--json`, else `human()`. */
  protected output<T>(value: T, human: (value: T) => void): void {
    if (this.json) {
      this.logger.log(JSON.stringify(value, null, 2));
      return;
    }
    human(value);
  }

  /** A table of `rows`; `empty` when there are none. */
  protected table(headers: string[], rows: Array<Array<string | number>>, empty = 'Nothing.') {
    if (rows.length === 0) {
      this.logger.info(empty);
      return;
    }
    const table = this.ui.table();
    table.head(headers);
    for (const row of rows) table.row(row.map(String));
    table.render();
  }

  /** `key: value` lines. */
  protected pairs(pairs: Array<[string, string | number | null | undefined]>) {
    for (const [key, value] of pairs) {
      this.logger.log(`${key}: ${value === null || value === undefined ? '—' : value}`);
    }
  }

  protected async governance(): Promise<AgentGovernanceConsole> {
    if (!this.app.container.hasBinding(AgentGovernanceConsole)) {
      throw new CliRefusal(
        'The agent is not booted: is `@adonis-agora/agent/agent_provider` in adonisrc.ts providers?',
      );
    }
    return this.app.container.make(AgentGovernanceConsole);
  }

  protected async agentService(): Promise<AgentService> {
    if (!this.app.container.hasBinding(AgentService)) {
      throw new CliRefusal(
        'The agent is not booted: is `@adonis-agora/agent/agent_provider` in adonisrc.ts providers?',
      );
    }
    return this.app.container.make(AgentService);
  }

  /** The actor a command acts as. */
  protected cliActor(): Actor {
    return { id: cliActorRef() };
  }

  /**
   * Confirm an irreversible action: `--force` skips the question; without a terminal to ask on, the
   * action is refused. `true` to go ahead.
   */
  protected async confirmed(force: boolean, question: string): Promise<boolean> {
    if (force) return true;
    if (!process.stdin.isTTY && this.prompt.traps.prompts.size === 0) {
      throw new CliRefusal(`${question} Re-run with --force to confirm without a prompt.`);
    }
    return this.prompt.confirm(question);
  }

  /** The cursor-paging part of a list query, from the paging flags. */
  protected pagingQuery(paging: {
    after?: string | undefined;
    before?: string | undefined;
    first?: number | undefined;
    last?: number | undefined;
  }): ListQuery {
    const qs: ListQuery = {};
    if (opt(paging.after) !== undefined) qs.after = paging.after;
    if (opt(paging.before) !== undefined) qs.before = paging.before;
    if (paging.first !== undefined) qs.first = String(paging.first);
    if (paging.last !== undefined) qs.last = String(paging.last);
    return qs;
  }

  /** Print the next/previous cursors of a cursor page under its table. */
  protected cursorHint(meta: { nextCursor: string | null; prevCursor: string | null }) {
    if (meta.nextCursor !== null) this.logger.log(`next page: --after ${meta.nextCursor}`);
    if (meta.prevCursor !== null) this.logger.log(`previous page: --before ${meta.prevCursor}`);
  }

  /** The command's work; a {@link CliRefusal} (or a refused filter) exits `1` with its message. */
  protected abstract execute(): Promise<void>;

  override async run(): Promise<void> {
    try {
      await this.execute();
    } catch (error) {
      if (
        error instanceof CliRefusal ||
        error instanceof GovernanceUnavailableError ||
        error instanceof InvalidColumnFilterError
      ) {
        this.logger.error(error.message);
        this.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  /** Refuse with `message` (exit `1`). */
  protected refuse(message: string): never {
    throw new CliRefusal(message);
  }
}
