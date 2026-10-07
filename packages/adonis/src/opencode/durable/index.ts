import * as durable from '@adonis-agora/durable';
import type { AgentEngineContext } from '../../engine.js';
import type { AgentRunner } from '../../spi/agent-runner.js';
import { OpenCodeEngine, type OpenCodeEngineOptions } from '../engine.js';
import { DurableOpenCodeAgentRunner } from './runner.js';
import { OpenCodeRunWorkflow } from './workflow.js';

/**
 * `@adonis-agora/agent/opencode/durable` — `openCode()` whose turns are durable workflows. Its own
 * entry point, so `@adonis-agora/durable` (an optional peer) is loaded only by an app that asks for
 * it.
 */
export interface OpenCodeDurableOptions extends OpenCodeEngineOptions {
  /**
   * The durable engine the turns run on. Omit → the app's (`WorkflowEngine` from the container,
   * bound by `@adonis-agora/durable`'s provider).
   */
  workflowEngine?: durable.WorkflowEngine;
}

/** The OpenCode engine whose turns are `agora.agent.opencode.run` workflows. */
export class OpenCodeDurableEngine extends OpenCodeEngine {
  override readonly name = 'opencode-durable';
  override readonly durable = true;

  constructor(override readonly options: OpenCodeDurableOptions) {
    super(options);
  }

  override async createRunner(context: AgentEngineContext): Promise<AgentRunner> {
    const turns = await this.buildTurns(context);
    const engine =
      this.options.workflowEngine ??
      (context.make !== undefined
        ? await context.make<durable.WorkflowEngine>(durable.WorkflowEngine)
        : undefined);
    if (engine === undefined) {
      throw new Error(
        '[@adonis-agora/agent/opencode] openCodeDurable() needs a durable engine: configure @adonis-agora/durable, or pass `workflowEngine`.',
      );
    }
    await durable.registerWorkflowClass(
      engine,
      OpenCodeRunWorkflow,
      () => new OpenCodeRunWorkflow(turns, engine),
    );
    const { host } = turns;
    return new DurableOpenCodeAgentRunner(engine, turns, host, context.store);
  }
}

/**
 * `openCode()` whose turns are durable workflows — `engine: openCodeDurable({ host })` next to a
 * configured `@adonis-agora/durable`. Every step of a turn is checkpointed; a turn waiting on a person
 * survives restarts and is resumed by whichever process receives the decision.
 */
export function openCodeDurable(options: OpenCodeDurableOptions): OpenCodeDurableEngine {
  return new OpenCodeDurableEngine(options);
}

export { DurableOpenCodeAgentRunner } from './runner.js';
export { decisionToken, OPENCODE_RUN_WORKFLOW, OpenCodeRunWorkflow } from './workflow.js';
