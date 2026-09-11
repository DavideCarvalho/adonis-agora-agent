import { NonDeterminismError, WorkflowNondeterminismError } from '@adonis-agora/durable';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentLoopDeps, AgentLoopHooks } from '../src/index.js';
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

function registryWithPurgeCache(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'purgeCache', kind: 'action', description: 'purge', inputSchema: z.object({}) },
    { execute: async () => ({ purged: true }) },
  );
  return registry;
}

const script: FakeScript = (_args, turnIndex) =>
  turnIndex === 0
    ? { text: 'purging', toolCall: { name: 'purgeCache', input: {} } }
    : { text: 'done' };

async function pass(journal: Journal, registry: ToolRegistry): Promise<void> {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({
    actor: { id: 'u1', roles: ['ADMIN'] },
    persona: 'default',
  });
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(script),
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
