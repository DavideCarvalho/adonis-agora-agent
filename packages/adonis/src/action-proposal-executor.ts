import { snapshotActionProposal } from './action-proposal-transitions.js';
import { createNegotiatedUiCollector, type ResolveToolUiCatalog } from './negotiated-tool-ui.js';
import type { ActionProposal } from './spi/action-proposal-store.js';
import type { BackgroundActorResolver } from './spi/background-actor-resolver.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { AgentUiComponent } from './stream-events.js';
import type { ToolRegistry } from './tool-registry.js';
import type { Actor, Persona } from './types.js';

export interface ActionProposalExecutionDeps {
  registry: ToolRegistry;
  rolesPolicy: RolesPolicy;
  allowedTools?: string[];
  host?: unknown;
  persona?: Persona;
  resolveUiCatalog?: ResolveToolUiCatalog;
}
export interface ActionProposalExecutorOptions {
  resolver: BackgroundActorResolver;
  /** Resolve exact recorded agent/persona against current configuration; throw if it disappeared. */
  resolveExecution(proposal: ActionProposal, actor: Actor): Promise<ActionProposalExecutionDeps>;
}
export type ActionProposalExecutionResult =
  | { status: 'succeeded'; result?: unknown; ui: AgentUiComponent[]; text?: string }
  | { status: 'failed'; error: string; ui: AgentUiComponent[]; text?: string };
export class ActionProposalExecutor {
  constructor(private readonly options: ActionProposalExecutorOptions) {}
  async execute(proposal: ActionProposal): Promise<ActionProposalExecutionResult> {
    let ui = createNegotiatedUiCollector(proposal.originToolCallId, {
      actor: { id: proposal.actorRef },
      threadId: proposal.threadId,
    });
    try {
      const actor = await this.options.resolver.resolve({
        actorRef: proposal.actorRef,
        tenantRef: proposal.tenantRef,
      });
      if (
        !actor ||
        actor.id !== proposal.actorRef ||
        (actor.tenantRef ?? null) !== proposal.tenantRef
      )
        throw new Error('Action proposal requester no longer exists or scope changed');
      const deps = await this.options.resolveExecution(proposal, actor);
      if (deps.registry.spec(proposal.toolName)?.kind !== 'action')
        throw new Error('Action proposal tool no longer exists as an action');
      const context = proposal.executionContext;
      ui = createNegotiatedUiCollector(
        proposal.originToolCallId,
        {
          actor,
          threadId: proposal.threadId,
          ...(context?.agentName !== undefined ? { agentName: context.agentName } : {}),
          ...(context?.uiCapabilities !== undefined
            ? { uiCapabilities: context.uiCapabilities }
            : {}),
        },
        deps.resolveUiCatalog,
      );
      const output = await deps.registry.invoke(
        proposal.toolName,
        snapshotActionProposal(
          Object.hasOwn(proposal, 'preparationInput') ? proposal.preparationInput : proposal.input,
        ),
        {
          actor,
          threadId: proposal.threadId,
          runId: proposal.originRunId,
          requestId: context?.requestId ?? proposal.originRunId,
          toolCallId: proposal.originToolCallId,
          idempotencyKey: proposal.idempotencyKey,
          ...(context?.agentName !== undefined ? { agentName: context.agentName } : {}),
          ...(deps.persona !== undefined ? { persona: deps.persona } : {}),
          ...(context?.pageContext !== undefined ? { pageContext: context.pageContext } : {}),
          ...(context?.uiCapabilities !== undefined
            ? { uiCapabilities: context.uiCapabilities }
            : {}),
          ...(deps.host !== undefined ? { host: deps.host } : {}),
          emitUi: ui.emit,
        },
        deps.rolesPolicy,
        {
          approvedInput: proposal.input,
          ...(deps.allowedTools !== undefined ? { allowedTools: deps.allowedTools } : {}),
        },
      );
      return snapshotActionProposal({
        status: 'succeeded',
        ...(output !== undefined ? { result: output } : {}),
        ui: ui.components(),
        ...(ui.text() ? { text: ui.text() } : {}),
      });
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        ui: ui.components(),
        ...(ui.text() ? { text: ui.text() } : {}),
      };
    }
  }
}
