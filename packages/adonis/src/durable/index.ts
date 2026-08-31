import type { WorkflowEngine } from '@adonis-agora/durable';
import { registerWorkflowClass } from '@adonis-agora/durable';
import { AgentRunWorkflow } from './agent-run-workflow.js';

export {
  type DurableAgentContext,
  getDurableAgentContext,
  setDurableAgentContext,
} from './agent-run-context.js';
export {
  AgentRunWorkflow,
  type DurableAgentRunInput,
} from './agent-run-workflow.js';
/**
 * The durable agent runner surface, kept in its OWN entry point (`@adonis-agora/agent/durable`) so
 * the main package never eagerly pulls in the optional `@adonis-agora/durable` peer — the provider
 * imports this lazily only when `durable: true` is configured. Mirrors how the `ai-sdk` entry isolates
 * the optional `ai` peer.
 */
export { DurableAgentRunner } from './durable-agent-runner.js';

/**
 * Register {@link AgentRunWorkflow} on a durable engine so `engine.start(AgentRunWorkflow, …)` and a
 * delegating `ctx.child(AgentRunWorkflow, …)` resolve. Idempotent per engine (re-registering the same
 * name+version overwrites). Call once at boot after the durable context is set.
 */
export function registerAgentWorkflow(engine: WorkflowEngine): void {
  registerWorkflowClass(engine, AgentRunWorkflow);
}
