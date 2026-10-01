import { snapshotActionProposal } from './action-proposal-transitions.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { AiToolCtx } from './spi/tool.js';
import type { InvokeOptions, ToolRegistry } from './tool-registry.js';

/** Trusted producer path: retain the original JSON and the exact data shown for approval. */
export async function prepareActionProposal(
  registry: ToolRegistry,
  name: string,
  input: unknown,
  ctx: AiToolCtx,
  policy: RolesPolicy,
  options: InvokeOptions = {},
) {
  const preparationInput = snapshotActionProposal(input);
  const prepared = await registry.prepareValidated(
    name,
    snapshotActionProposal(preparationInput),
    ctx,
    policy,
    { ...options, snapshotInput: true },
  );
  return {
    preparationInput,
    input: prepared.input,
    // Completed results keep their normal handler contract; they never create a proposal.
    preflight:
      prepared.preflight.status === 'ready'
        ? snapshotActionProposal(prepared.preflight)
        : prepared.preflight,
  };
}
