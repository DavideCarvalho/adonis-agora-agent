// @vitest-environment node
import type { BaseCommand } from '@adonisjs/core/ace';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentApprovalsApprove, AgentApprovalsReject } from '../commands/agent_approvals.js';
import {
  AgentPricingList,
  AgentPricingSet,
  AgentQuotaShow,
  AgentTenantsList,
  AgentToolsList,
  AgentToolsStats,
} from '../commands/agent_catalog.js';
import {
  AgentApprovalsList,
  AgentRunsList,
  AgentRunsShow,
  AgentThreadsList,
  AgentThreadsShow,
  AgentToolCallsList,
} from '../commands/agent_runs.js';
import {
  AgentGenuiShow,
  AgentReliabilityShow,
  AgentSpendShow,
  AgentUsageBreakdown,
  AgentUsageTrend,
} from '../commands/agent_usage.js';
import loader from '../commands/main.js';
import { cliActorRef } from '../src/cli/agent_command.js';
import type { AgentRunner, HumanReply } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryGovernanceQueries } from '../src/testing/in-memory-governance-queries.js';
import { InMemoryPricingStore } from '../src/testing/in-memory-pricing.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';

/**
 * The `agent:*` operator commands, run through a real ace kernel on a booted app: they read what the
 * console routes read (the container's governance read-model, pricing store and service) and decide
 * approvals through the same HITL rules.
 */

/** A runner whose signals reach other processes (like the durable one): records what it is sent. */
class CrossProcessRunner implements AgentRunner {
  readonly signalsReachOtherProcesses = true;
  readonly signals: Array<{ runId: string; toolCallId: string; reply: HumanReply }> = [];
  async start(): Promise<{ runId: string }> {
    throw new Error('not used');
  }
  async signal(runId: string, toolCallId: string, reply: HumanReply) {
    this.signals.push({ runId, toolCallId, reply });
  }
  async isRunActive() {
    return true;
  }
  async cancel() {}
}

interface Setup {
  app: ApplicationService;
  store: InMemoryAgentStore;
  runner: CrossProcessRunner;
  pricing: InMemoryPricingStore;
}

let current: ApplicationService | undefined;
afterEach(async () => {
  await current?.terminate();
  current = undefined;
});

async function setup(
  options: { engine?: boolean; agent?: Record<string, unknown> } = {},
): Promise<Setup> {
  const store = new InMemoryAgentStore();
  const runner = new CrossProcessRunner();
  const pricing = new InMemoryPricingStore();
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
      config: {
        agent: {
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          store: 'memory',
          stores: { memory: () => store },
          governanceQueries: new InMemoryGovernanceQueries(store),
          pricingStore: pricing,
          ...(options.engine === true
            ? { engine: { name: 'cross-process', createRunner: () => runner } }
            : {}),
          ...options.agent,
        },
      },
    })
    // Rooted in `test/`, not the package: ace loads `<root>/commands` as the app's own commands.
    .create(new URL('./', import.meta.url));
  const app = ignitor.createApp('console');
  await app.init();
  await app.boot();
  await app.start(() => {});
  current = app;

  // One thread of `user:1` with a run parked on an approval.
  await store.createThread({ actor: { id: 'user:1' }, id: 't1', title: 'Refunds' });
  await store.recordRunStart({ runId: 'r1', threadId: 't1', actor: { id: 'user:1' } });
  await store.recordToolCall({
    toolCallId: 'tc1',
    messageId: 'm1',
    toolName: 'refund',
    toolType: 'action',
    input: { id: 7 },
    status: 'pending_approval',
    runId: 'r1',
  });
  return { app, store, runner, pricing };
}

/** Run a command on the app's ace kernel; the logs come back raw. */
async function run(
  app: ApplicationService,
  command: typeof BaseCommand,
  argv: string[],
  prepare?: (cmd: {
    prompt: { trap(message: string): { accept(): void; reject(): void } };
  }) => void,
) {
  const ace = await app.container.make('ace');
  ace.ui.switchMode('raw');
  const cmd = await ace.create(command, argv);
  prepare?.(cmd as never);
  await cmd.exec();
  const logs = cmd.logger.getLogs().map((log) => log.message);
  return { cmd, logs, exitCode: cmd.exitCode };
}

const jsonOf = (logs: string[]) => JSON.parse(logs.join('\n'));

describe('agent:* commands', { timeout: 60_000 }, () => {
  it('registers every command under agent:*', async () => {
    const names = (await loader.getMetaData()).map((command) => command.commandName);
    expect(names).toEqual(
      expect.arrayContaining([
        'agent:spend:show',
        'agent:usage:trend',
        'agent:usage:breakdown',
        'agent:reliability:show',
        'agent:genui:show',
        'agent:runs:list',
        'agent:runs:show',
        'agent:threads:list',
        'agent:threads:show',
        'agent:tool-calls:list',
        'agent:approvals:list',
        'agent:approvals:approve',
        'agent:approvals:reject',
        'agent:quota:show',
        'agent:tools:list',
        'agent:tools:stats',
        'agent:pricing:list',
        'agent:pricing:set',
        'agent:tenants:list',
      ]),
    );
  });

  describe('reads', () => {
    it('agent:runs:list --json answers the cursor envelope of the console route', async () => {
      const { app } = await setup();
      const { logs, exitCode } = await run(app, AgentRunsList, ['--json', '--actor', 'user:1']);
      expect(exitCode).toBe(0);
      const page = jsonOf(logs);
      expect(page.data.map((row: { runId: string }) => row.runId)).toEqual(['r1']);
      expect(page.meta).toMatchObject({ hasNext: false, hasPrev: false });
    });

    it('agent:runs:list refuses a status the console refuses (exit 1)', async () => {
      const { app } = await setup();
      const { logs, exitCode } = await run(app, AgentRunsList, ['--status', 'exploded']);
      expect(exitCode).toBe(1);
      expect(logs.join('\n')).toContain('"status" is one of');
    });

    it('agent:runs:list refuses a malformed day', async () => {
      const { app } = await setup();
      const { exitCode, logs } = await run(app, AgentRunsList, ['--from', '11/13/2026']);
      expect(exitCode).toBe(1);
      expect(logs.join('\n')).toContain('--from takes a UTC day');
    });

    it('agent:runs:show prints a table, and --json the trace', async () => {
      const { app } = await setup();
      const human = await run(app, AgentRunsShow, ['r1']);
      expect(human.exitCode).toBe(0);
      expect(human.logs.join('\n')).toContain('Run: r1');
      const json = await run(app, AgentRunsShow, ['r1', '--json']);
      expect(jsonOf(json.logs).run.runId).toBe('r1');
      const missing = await run(app, AgentRunsShow, ['nope']);
      expect(missing.exitCode).toBe(1);
    });

    it('agent:approvals:list lists the parked call, filtered by actor', async () => {
      const { app } = await setup();
      const all = await run(app, AgentApprovalsList, ['--json']);
      expect(jsonOf(all.logs).data.map((row: { toolCallId: string }) => row.toolCallId)).toEqual([
        'tc1',
      ]);
      const other = await run(app, AgentApprovalsList, ['--json', '--actor', 'user:2']);
      expect(jsonOf(other.logs).data).toEqual([]);
    });

    it('agent:approvals:list pages with --first and --after', async () => {
      const { app, store } = await setup();
      await store.recordToolCall({
        toolCallId: 'tc2',
        messageId: 'm2',
        toolName: 'refund',
        toolType: 'action',
        input: {},
        status: 'pending_approval',
        runId: 'r1',
      });
      const first = jsonOf((await run(app, AgentApprovalsList, ['--json', '--first', '1'])).logs);
      expect(first.data).toHaveLength(1);
      expect(first.meta.hasNext).toBe(true);
      const second = jsonOf(
        (
          await run(app, AgentApprovalsList, [
            '--json',
            '--first',
            '1',
            '--after',
            first.meta.nextCursor,
          ])
        ).logs,
      );
      expect(second.data).toHaveLength(1);
      expect(second.data[0].toolCallId).not.toBe(first.data[0].toolCallId);
      const bad = await run(app, AgentApprovalsList, ['--after', 'garbage']);
      expect(bad.exitCode).toBe(1);
    });

    it('threads, tool calls and rollups answer JSON', async () => {
      const { app } = await setup();
      const threads = jsonOf((await run(app, AgentThreadsList, ['--json'])).logs);
      expect(threads.data[0].threadId).toBe('t1');
      const thread = jsonOf((await run(app, AgentThreadsShow, ['t1', '--json'])).logs);
      expect(thread.threadId).toBe('t1');
      const calls = jsonOf((await run(app, AgentToolCallsList, ['--json'])).logs);
      expect(calls.data[0].toolCallId).toBe('tc1');
      for (const [command, argv] of [
        [AgentSpendShow, []],
        [AgentSpendShow, ['--by', 'actor']],
        [AgentSpendShow, ['--by', 'feature']],
        [AgentUsageTrend, ['--from', '2026-11-01', '--to', '2026-11-13']],
        [AgentUsageBreakdown, []],
        [AgentReliabilityShow, []],
        [AgentGenuiShow, []],
        [AgentToolsStats, []],
      ] as const) {
        const result = await run(app, command, ['--json', ...argv]);
        expect(result.exitCode, command.commandName).toBe(0);
        expect(() => jsonOf(result.logs)).not.toThrow();
      }
    });

    it('agent:spend:show refuses an unknown grouping', async () => {
      const { app } = await setup();
      const { exitCode } = await run(app, AgentSpendShow, ['--by', 'planet']);
      expect(exitCode).toBe(1);
    });

    it('agent:usage:breakdown wants --since and --until together', async () => {
      const { app } = await setup();
      const { exitCode, logs } = await run(app, AgentUsageBreakdown, [
        '--since',
        '2026-11-01T00:00:00Z',
      ]);
      expect(exitCode).toBe(1);
      expect(logs.join('\n')).toContain('go together');
    });

    it('--tenant is refused while tenancy is off', async () => {
      const { app } = await setup();
      const { exitCode, logs } = await run(app, AgentRunsList, ['--tenant', 'acme']);
      expect(exitCode).toBe(1);
      expect(logs.join('\n')).toContain('Tenancy is off');
      expect((await run(app, AgentTenantsList, [])).exitCode).toBe(1);
    });

    it('agent:quota:show reports an actor, and needs one', async () => {
      const { app } = await setup();
      const report = jsonOf((await run(app, AgentQuotaShow, ['--json', '--actor', 'user:1'])).logs);
      expect(report.windows[0].period).toBe('day');
      expect((await run(app, AgentQuotaShow, [])).exitCode).toBe(1);
    });

    it('agent:tools:list answers the catalog an actor reaches', async () => {
      const { app } = await setup();
      const result = await run(app, AgentToolsList, [
        '--json',
        '--actor',
        'user:1',
        '--role',
        'ADMIN',
      ]);
      expect(result.exitCode).toBe(0);
      expect(Array.isArray(jsonOf(result.logs))).toBe(true);
      const unknown = await run(app, AgentToolsList, ['--actor', 'user:1', '--agent', 'ghost']);
      expect(unknown.exitCode).not.toBe(0);
    });

    it('refuses when the governance read-model is off', async () => {
      const { app } = await setup({ agent: { governanceQueries: false } });
      const { exitCode, logs } = await run(app, AgentRunsList, []);
      expect(exitCode).toBe(1);
      expect(logs.join('\n')).toContain('no governance read-model');
    });
  });

  describe('approvals', () => {
    it('approves through the runner, as cli:<user> via cli (--force)', async () => {
      const { app, runner } = await setup({ engine: true });
      const { exitCode, logs } = await run(app, AgentApprovalsApprove, [
        'tc1',
        '--force',
        '--json',
      ]);
      expect(exitCode).toBe(0);
      expect(jsonOf(logs)).toMatchObject({ ok: true, toolCallId: 'tc1', runId: 'r1' });
      expect(runner.signals).toEqual([
        {
          runId: 'r1',
          toolCallId: 'tc1',
          reply: { approved: true, executedByRef: cliActorRef(), decidedVia: 'cli' },
        },
      ]);
    });

    it('rejects with --note as the reason', async () => {
      const { app, runner } = await setup({ engine: true });
      const { exitCode } = await run(app, AgentApprovalsReject, [
        'tc1',
        '--force',
        '--note',
        'not today',
      ]);
      expect(exitCode).toBe(0);
      expect(runner.signals[0]?.reply).toMatchObject({ approved: false, reason: 'not today' });
    });

    it('asks first without --force, and a declined prompt changes nothing', async () => {
      const { app, runner } = await setup({ engine: true });
      const declined = await run(app, AgentApprovalsApprove, ['tc1'], (cmd) =>
        cmd.prompt.trap('approve tool call tc1?').reject(),
      );
      expect(declined.exitCode).toBe(1);
      expect(runner.signals).toEqual([]);
      const accepted = await run(app, AgentApprovalsApprove, ['tc1'], (cmd) =>
        cmd.prompt.trap('approve tool call tc1?').accept(),
      );
      expect(accepted.exitCode).toBe(0);
      expect(runner.signals).toHaveLength(1);
    });

    it('refuses an unknown call', async () => {
      const { app, runner } = await setup({ engine: true });
      const { exitCode, logs } = await run(app, AgentApprovalsApprove, ['ghost', '--force']);
      expect(exitCode).toBe(1);
      expect(logs.join('\n')).toContain('Unknown tool call');
      expect(runner.signals).toEqual([]);
      // --json: the same refusal document from every refusal site.
      const json = await run(app, AgentApprovalsApprove, ['ghost', '--force', '--json']);
      expect(json.exitCode).toBe(1);
      expect(JSON.parse(json.logs[0] as string)).toMatchObject({
        ok: false,
        toolCallId: 'ghost',
        status: 404,
      });
    });

    it('keeps the approver gate: a call routed to a role the CLI does not hold is refused', async () => {
      const { app, store, runner } = await setup({ engine: true });
      await store.recordToolCall({
        toolCallId: 'tc-finance',
        messageId: 'm3',
        toolName: 'refund',
        toolType: 'action',
        input: {},
        status: 'pending_approval',
        runId: 'r1',
        approver: 'FINANCE',
      });
      const { exitCode, logs } = await run(app, AgentApprovalsApprove, ['tc-finance', '--force']);
      expect(exitCode).toBe(1);
      expect(logs.join('\n')).toContain('This approval is for FINANCE.');
      expect(runner.signals).toEqual([]);
    });

    it('refuses an expired request', async () => {
      const { app, store, runner } = await setup({ engine: true });
      await store.recordToolCall({
        toolCallId: 'tc-old',
        messageId: 'm4',
        toolName: 'refund',
        toolType: 'action',
        input: {},
        status: 'pending_approval',
        runId: 'r1',
        expiresAt: '2000-01-01T00:00:00.000Z',
      } as never);
      const { exitCode, logs } = await run(app, AgentApprovalsApprove, ['tc-old', '--force']);
      expect(exitCode).toBe(1);
      expect(logs.join('\n')).toContain('has expired');
      expect(runner.signals).toEqual([]);
    });

    it('refuses with the in-process runner: the decision could not reach the parked run', async () => {
      const { app, store } = await setup();
      const { exitCode, logs } = await run(app, AgentApprovalsApprove, ['tc1', '--force']);
      expect(exitCode).toBe(1);
      expect(logs.join('\n')).toContain('in-process');
      // Nothing settled: the run is not marked dead from outside.
      expect((await store.toolCallApproval('tc1', 'r1'))?.status).toBe('pending_approval');
    });
  });

  describe('pricing', () => {
    it('lists and sets prices; replacing one asks unless --force', async () => {
      const { app, pricing } = await setup();
      const set = await run(app, AgentPricingSet, [
        'gpt-x',
        '--input',
        '1.5',
        '--output',
        '6',
        '--json',
      ]);
      expect(set.exitCode).toBe(0);
      expect(jsonOf(set.logs)).toMatchObject({ previous: null, price: { modelId: 'gpt-x' } });
      const listed = jsonOf((await run(app, AgentPricingList, ['--json'])).logs);
      expect(listed[0]).toMatchObject({
        modelId: 'gpt-x',
        inputPricePer1m: 1.5,
        outputPricePer1m: 6,
      });

      const dry = await run(app, AgentPricingSet, [
        'gpt-x',
        '--input',
        '2',
        '--output',
        '8',
        '--dry-run',
      ]);
      expect(dry.exitCode).toBe(0);
      expect((await pricing.listCurrentPrices())[0]?.inputPricePer1m).toBe(1.5);

      const declined = await run(
        app,
        AgentPricingSet,
        ['gpt-x', '--input', '2', '--output', '8'],
        (cmd) =>
          cmd.prompt.trap('Replace the price of gpt-x (input 1.5, output 6 per 1M)?').reject(),
      );
      expect(declined.exitCode).toBe(1);
      expect((await pricing.listCurrentPrices())[0]?.inputPricePer1m).toBe(1.5);

      const forced = await run(app, AgentPricingSet, [
        'gpt-x',
        '--input',
        '2',
        '--output',
        '8',
        '--force',
      ]);
      expect(forced.exitCode).toBe(0);
      expect((await pricing.listCurrentPrices())[0]?.inputPricePer1m).toBe(2);
    });

    it('refuses a price without both rates', async () => {
      const { app } = await setup();
      const { exitCode } = await run(app, AgentPricingSet, ['gpt-x', '--input', '1']);
      expect(exitCode).toBe(1);
    });
  });
});
