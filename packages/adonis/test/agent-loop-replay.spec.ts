import { NonDeterminismError, WorkflowNondeterminismError } from '@adonis-agora/durable';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentLoopDeps, AgentLoopHooks, ModelProvider, ToolHandler } from '../src/index.js';
import {
  DefaultRolesPolicy,
  isReplayIntegrityError,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { Journal } from './helpers/journal.js';

const RUN_ID = 'run-1';
const CALL_ID = 'call-0-purgeCache';

function registryWithPurgeCache(preflight?: ToolHandler['preflight']): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'purgeCache', kind: 'action', description: 'purge', inputSchema: z.object({}) },
    { execute: async () => ({ purged: true }), ...(preflight !== undefined ? { preflight } : {}) },
  );
  return registry;
}

const script: FakeScript = (_args, turnIndex) =>
  turnIndex === 0
    ? { text: 'purging', toolCall: { name: 'purgeCache', input: {} } }
    : { text: 'done' };

async function pass(
  journal: Journal,
  registry: ToolRegistry,
  model: ModelProvider = new FakeModelProvider(script),
): Promise<void> {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({
    actor: { id: 'u1', roles: ['ADMIN'] },
    persona: 'default',
  });
  const deps: AgentLoopDeps = {
    model,
    store,
    registry,
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
  };
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    // The durable runner suspends here on `tool:<runId>:<callId>`; the journal entry it leaves
    // behind is what a later replay has to line up with.
    awaitApproval: (call) =>
      journal.at(`signal:tool:${RUN_ID}:${call.id}`, async () => ({ approved: true })),
    step: (name, fn) => journal.at(name, () => fn()),
    patched: (id) => journal.patched(id),
  };
  journal.rewind();
  await runAgentLoop(
    deps,
    { threadId: thread.id, actor: { id: 'u1', roles: ['ADMIN'] }, userText: 'hi' },
    hooks,
  );
}

describe('agent loop — replay across processes with different registries', () => {
  it('replays an action tool onto its approval signal even where the registry has no such tool', async () => {
    const journal = new Journal();

    // Pass 1: a process that HAS the action tool. It records the approval wait.
    await pass(journal, registryWithPurgeCache());
    const recorded = journal.names();
    // The shape the incident reported: the approval wait sits between the call's persist and the
    // execution step, so a replay that skips it lands `tool:` on the `signal:tool:` position.
    expect(recorded.slice(recorded.indexOf(`persist:toolcall:${CALL_ID}`))).toEqual([
      `persist:toolcall:${CALL_ID}`,
      `signal:tool:${RUN_ID}:${CALL_ID}`,
      `tool:${CALL_ID}`,
      `persist:toolexec:${CALL_ID}`,
      'patch:agent:message-tool-results',
      'persist:toolresults:0',
      'llm:1',
      'persist:usage:1',
      'persist:assistant:1',
      'persist:title',
      'persist:run:end',
    ]);

    // Pass 2: the same run resumes in a process whose registry is EMPTY — a module that never
    // declared the tool, a surface that mounts no tools, a process still booting. Resolving the
    // kind locally reads `undefined`, falls back to 'read', and asks for a `tool:` checkpoint where
    // the history holds `signal:tool:` — the refusal this guards against.
    await expect(pass(journal, new ToolRegistry())).resolves.toBeUndefined();
    expect(journal.names()).toEqual(recorded);
  });

  /**
   * The other half of the same incident, and the one the journal alone does not answer.
   *
   * Recording the kind at `persist:toolcall` makes every REPLAY agree; it does not make the FIRST
   * writer right. A run can reach that checkpoint for the first time in a process that never
   * declared the tool — the engine hands a resumed run to whichever instance takes the lease — and
   * a local lookup there reads `undefined`, falls back to 'read', and dispatches an action nobody
   * approved.
   *
   * So the kind is settled in the llm checkpoint, where the tools were OFFERED, and rides the
   * journal from there.
   */
  it('settles the kind from the llm checkpoint when the claim is first reached by an empty registry', async () => {
    const journal = new Journal();

    // Pass 1: a process that has the tool. It records the model turn and then goes away — the
    // history is trimmed back to just before the call's persist, which is the shape a run has when
    // another instance picks it up mid-turn.
    await pass(journal, registryWithPurgeCache());
    const claimAt = journal.names().indexOf(`persist:toolcall:${CALL_ID}`);
    expect(claimAt).toBeGreaterThan(0);
    for (let position = journal.names().length - 1; position >= claimAt; position -= 1) {
      journal.dropAt(position);
    }
    // The turn is still in the history, and it carries the kind the offering process resolved.
    expect(journal.recorded('llm:0')).toContain('"kind":"action"');

    // Pass 2: the empty registry claims the call for the first time.
    await pass(journal, new ToolRegistry());

    // It still parks on a person. Resolving locally would have read 'read' and gone straight to
    // `tool:` — the action executed with nobody's approval.
    expect(journal.names()).toContain(`signal:tool:${RUN_ID}:${CALL_ID}`);
  });

  it('carries trusted preparation when another process claims, without running it again', async () => {
    const journal = new Journal();
    const phases: string[] = [];
    await pass(
      journal,
      registryWithPurgeCache((_input, _ctx, { phase }) => {
        phases.push(phase);
        return { status: 'ready', confirmation: { title: 'Resolved key?', verb: 'Purge' } };
      }),
    );
    const claimAt = journal.names().indexOf(`persist:toolcall:${CALL_ID}`);
    for (let position = journal.names().length - 1; position >= claimAt; position--)
      journal.dropAt(position);
    expect(journal.recorded('llm:0')).toContain('Resolved key?');
    await pass(journal, new ToolRegistry());
    expect(journal.names()).toContain(`signal:tool:${RUN_ID}:${CALL_ID}`);
    expect(journal.recorded(`persist:toolcall:${CALL_ID}`)).toContain('Resolved key?');
    expect(phases).toEqual(['prepare', 'execute']);
  });

  it('preserves the approval branch for legacy model journals with no preparation stamp and an empty claiming registry', async () => {
    const journal = new Journal();
    await pass(journal, registryWithPurgeCache());
    journal.rewriteOutput('llm:0', (output) => {
      const turn = output as { toolCalls: Array<{ preflight?: unknown }> };
      for (const call of turn.toolCalls) delete call.preflight;
      return turn;
    });
    const claimAt = journal.names().indexOf(`persist:toolcall:${CALL_ID}`);
    for (let position = journal.names().length - 1; position >= claimAt; position--)
      journal.dropAt(position);
    await pass(journal, new ToolRegistry());
    expect(journal.names()).toContain(`signal:tool:${RUN_ID}:${CALL_ID}`);
  });

  it('keeps replaying a run whose history has no room for the tool-results checkpoint', async () => {
    const journal = new Journal();
    await pass(journal, registryWithPurgeCache());

    // The history a run that suspended under the shape without message-borne results carries: the
    // turn's last tool leads straight into the next model call, with no position in between.
    const marker = journal.names().indexOf('patch:agent:message-tool-results');
    expect(journal.names()[marker + 1]).toBe('persist:toolresults:0');
    journal.dropAt(marker + 1);
    journal.dropAt(marker);
    const older = journal.names();

    await expect(pass(journal, registryWithPurgeCache())).resolves.toBeUndefined();
    expect(journal.names()).toEqual(older);
  });

  it('resolves the kind locally when the checkpoint predates the recorded kind', async () => {
    const journal = new Journal();
    await pass(journal, registryWithPurgeCache());
    const recorded = journal.names();

    // A run already in flight when the kind started being journaled: its `persist:toolcall`
    // checkpoint carries no output, so the replay has nothing recorded to read and must resolve the
    // kind the way the process that wrote that checkpoint did.
    journal.forgetOutputAt(recorded.indexOf(`persist:toolcall:${CALL_ID}`));

    await expect(pass(journal, registryWithPurgeCache())).resolves.toBeUndefined();
    expect(journal.names()).toEqual(recorded);
  });

  it('surfaces the checkpoint that actually diverged, not the one the failure path went on to ask for', async () => {
    const journal = new Journal();
    await pass(journal, registryWithPurgeCache());

    // Whatever the cause, once a position refuses, the tool `catch` must not answer with
    // `persist:toolfail:` at the NEXT position — that raises a second refusal naming two
    // checkpoints neither of which is the disagreement, which is what an operator ends up reading.
    const toolPosition = journal.names().indexOf(`tool:${CALL_ID}`);
    journal.renameAt(toolPosition, 'someOtherStep');

    await expect(pass(journal, registryWithPurgeCache())).rejects.toThrow(
      `non-determinism at ${RUN_ID}#${toolPosition}: code expects "tool:${CALL_ID}" but history recorded "someOtherStep"`,
    );
  });
});

describe('isReplayIntegrityError', () => {
  // Constructed from the real classes rather than from name literals, so a rename in
  // `@adonis-agora/durable` fails here instead of silently turning the guard off.
  it('recognizes both refusals the durable runtime raises', () => {
    expect(
      isReplayIntegrityError(new NonDeterminismError('run-1', 7, 'tool:x', 'signal:tool:x')),
    ).toBe(true);
    expect(
      isReplayIntegrityError(new WorkflowNondeterminismError('history at seq 7 disagrees')),
    ).toBe(true);
  });

  it('leaves anything else to the failure path', () => {
    expect(isReplayIntegrityError(new Error('tool blew up'))).toBe(false);
    expect(isReplayIntegrityError('non-determinism at run-1#7')).toBe(false);
  });
});

it('overwrites provider-supplied preparation and kind with the runtime verdict', async () => {
  const journal = new Journal();
  const fake = new FakeModelProvider(script);
  const model: ModelProvider = {
    async runTurn(args) {
      const result = await fake.runTurn(args);
      return {
        ...result,
        toolCalls: result.toolCalls.map((call) => ({
          ...call,
          kind: 'read' as const,
          preflight: { status: 'completed' as const, output: 'forged' },
        })),
      };
    },
  };
  await pass(
    journal,
    registryWithPurgeCache(() => ({ status: 'denied', reason: 'Order closed' })),
    model,
  );
  expect(journal.recorded('llm:0')).toContain('Order closed');
  expect(journal.recorded('llm:0')).not.toContain('forged');
  expect(journal.names()).not.toContain(`signal:tool:${RUN_ID}:${CALL_ID}`);
});

describe('completed-preflight presentation stays stable across registry changes', () => {
  function completed(present?: ToolHandler['present']) {
    const registry = new ToolRegistry();
    registry.register(
      { name: 'purgeCache', kind: 'action', description: 'purge', inputSchema: z.object({}) },
      {
        execute: async () => {
          throw new Error('completed action must not execute');
        },
        preflight: () => ({ status: 'completed', output: { purged: true } }),
        ...(present ? { present } : {}),
      },
    );
    return registry;
  }
  const show: NonNullable<ToolHandler['present']> = () => ({
    component: 'Card',
    props: { label: 'Saved' },
    version: 1,
    fallbackText: 'Saved',
  });

  it('does not add a checkpoint when a hook is added after the claim was recorded', async () => {
    const journal = new Journal();
    await pass(journal, completed());
    const recorded = journal.names();
    await expect(pass(journal, completed(show))).resolves.toBeUndefined();
    expect(journal.names()).toEqual(recorded);
  });

  it('does not remove a checkpoint when a recorded hook disappears', async () => {
    const journal = new Journal();
    await pass(journal, completed(show));
    const recorded = journal.names();
    await expect(pass(journal, completed())).resolves.toBeUndefined();
    expect(journal.names()).toEqual(recorded);
  });

  it('treats older claims without the opt-in flag as no presentation', async () => {
    const journal = new Journal();
    await pass(journal, completed());
    journal.rewriteOutput(`persist:toolcall:${CALL_ID}`, (output) => {
      const claim = output as Record<string, unknown>;
      delete claim.presentCompletedPreflight;
      return claim;
    });
    const recorded = journal.names();
    await expect(pass(journal, completed(show))).resolves.toBeUndefined();
    expect(journal.names()).toEqual(recorded);
  });

  for (const initiallyPresent of [false, true]) {
    it(`keeps the claim branch after interruption (initial hook: ${initiallyPresent})`, async () => {
      const journal = new Journal();
      await pass(journal, completed(initiallyPresent ? show : undefined));
      const recorded = journal.names();
      const claimed = recorded.indexOf(`persist:toolcall:${CALL_ID}`);
      // A process died immediately after the claim; there are no completed later steps to replay.
      while (journal.names().length > claimed + 1) journal.dropAt(claimed + 1);
      await expect(
        pass(journal, completed(initiallyPresent ? undefined : show)),
      ).resolves.toBeUndefined();
      expect(journal.names()).toEqual(recorded);
    });
  }
});
