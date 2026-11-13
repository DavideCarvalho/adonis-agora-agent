import { args, flags } from '@adonisjs/core/ace';
import { AgentCommand, opt } from '../src/cli/agent_command.js';
import {
  type DecisionRefusal,
  decideToolCall,
  decisionRefusal,
  type ToolCallDecision,
} from '../src/tool-call-decision.js';

/**
 * A shell on the app is the operator: it may decide any requester-approved call, like a console
 * viewer `authorize` lets act across actors. A call routed to an approver role still needs that
 * role (the approval policy's `canDecide`), which a CLI actor does not hold.
 */
const OPERATOR = async () => true;

/**
 * Approve or reject a parked tool call through the same rules as the console's approvals inbox
 * (`decideToolCall`): ownership or the recorded approver's role, expiry, a run that already ended.
 * The decision is recorded as made by `cli:<os user>`, through `cli`.
 */
abstract class DecideCommand extends AgentCommand {
  @args.string({ description: 'Tool call id' })
  declare toolCallId: string;

  @flags.string({
    flagName: 'run',
    description: 'The run the call belongs to (default: read off the call)',
  })
  declare runId?: string;

  @flags.boolean({ description: 'Skip the confirmation' })
  declare force: boolean;

  protected abstract decision(): ToolCallDecision;
  protected abstract readonly verb: 'approve' | 'reject';

  /** Refuse (exit `1`); with `--json`, first print `{ ok: false, toolCallId, status, message }`. */
  private refuseDecision(refusal: DecisionRefusal): never {
    if (this.json) {
      this.logger.log(
        JSON.stringify({ ok: false, toolCallId: this.toolCallId, ...refusal }, null, 2),
      );
    }
    return this.refuse(refusal.message);
  }

  protected async execute() {
    const service = await this.agentService();
    const actor = this.cliActor();
    const runId = opt(this.runId) ?? (await service.toolCallRun(this.toolCallId));
    if (runId === null) {
      return this.refuseDecision({
        status: 404,
        message: `Unknown tool call "${this.toolCallId}".`,
      });
    }
    // Refuse before asking: the same checks the decision itself runs (and runs again).
    const refusal = await decisionRefusal(service, {
      actor,
      runId,
      toolCallId: this.toolCallId,
      privileged: OPERATOR,
      fromAnotherProcess: true,
    });
    if (refusal !== null) return this.refuseDecision(refusal);
    if (!(await this.confirmed(this.force, `${this.verb} tool call ${this.toolCallId}?`))) {
      return this.refuse('Cancelled.');
    }
    const outcome = await decideToolCall(service, {
      actor,
      toolCallId: this.toolCallId,
      runId,
      decision: this.decision(),
      privileged: OPERATOR,
      fromAnotherProcess: true,
    });
    if (!outcome.ok) return this.refuseDecision(outcome.refusal);
    const result = {
      ok: true as const,
      toolCallId: this.toolCallId,
      runId: outcome.runId,
      by: actor.id,
    };
    return this.output(result, () =>
      this.logger.success(
        `${this.verb === 'approve' ? 'Approved' : 'Rejected'} ${this.toolCallId}`,
      ),
    );
  }
}

/** `agent:approvals:approve <toolCallId>` — release a call waiting for a human approval. */
export class AgentApprovalsApprove extends DecideCommand {
  static override commandName = 'agent:approvals:approve';
  static override description = 'Approve a tool call waiting for a human approval';
  protected readonly verb = 'approve' as const;

  @flags.boolean({ description: 'Also approve later calls of this tool in the same thread' })
  declare remember: boolean;

  protected decision(): ToolCallDecision {
    return { kind: 'approve', remember: this.remember === true, via: 'cli' };
  }
}

/** `agent:approvals:reject <toolCallId>` — deny a call waiting for a human approval. */
export class AgentApprovalsReject extends DecideCommand {
  static override commandName = 'agent:approvals:reject';
  static override description = 'Reject a tool call waiting for a human approval';
  protected readonly verb = 'reject' as const;

  @flags.string({ description: 'Why: recorded with the rejection and shown to the model' })
  declare note?: string;

  protected decision(): ToolCallDecision {
    const note = opt(this.note);
    return { kind: 'reject', ...(note !== undefined ? { reason: note } : {}), via: 'cli' };
  }
}
