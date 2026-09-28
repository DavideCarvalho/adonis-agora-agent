import { describe, expect, it } from 'vitest';
import { createGuardrails } from '../src/guardrails/index.js';
import { AgentDepsFactory, AgentRegistry, DefaultRolesPolicy, ToolRegistry } from '../src/index.js';
import {
  echoScript,
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

const base = () => ({
  model: new FakeModelProvider(echoScript('ok')),
  store: new InMemoryAgentStore(),
  sink: new InMemoryTokenStreamSink(),
  rolesPolicy: new DefaultRolesPolicy(),
  registry: new ToolRegistry(),
  agents: new AgentRegistry(),
});

describe('AgentDepsFactory — processors', () => {
  it("hands every agent's loop the configured processors", () => {
    const guardrails = createGuardrails({ pii: 'redact' });
    const agents = new AgentRegistry();
    agents.register({ name: 'research', systemPrompt: 'r' });
    const factory = new AgentDepsFactory({
      ...base(),
      agents,
      inputProcessors: [guardrails.input],
      outputProcessors: [guardrails.output],
    });
    for (const deps of [factory.forAgent(), factory.forAgent('research')]) {
      expect(deps.inputProcessors).toEqual([guardrails.input]);
      expect(deps.outputProcessors).toEqual([guardrails.output]);
    }
  });

  it('adds nothing when none are configured', () => {
    const deps = new AgentDepsFactory(base()).forAgent();
    expect('inputProcessors' in deps).toBe(false);
    expect('outputProcessors' in deps).toBe(false);
  });
});
