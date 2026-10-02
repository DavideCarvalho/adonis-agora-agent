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
  let replacementKey: string | undefined;
  const replacement = registry.spec(name)?.replacementKey;
  if (prepared.preflight.status === 'ready' && replacement !== undefined) {
    replacementKey =
      typeof replacement === 'string'
        ? replacement
        : await replacement(snapshotActionProposal(prepared.input), ctx);
    if (
      replacementKey !== undefined &&
      (typeof replacementKey !== 'string' || !replacementKey || replacementKey.length > 255)
    )
      throw new TypeError(
        'replacementKey must be a nonempty string of at most 255 UTF-16 code units',
      );
  }
  return {
    ...(replacementKey !== undefined ? { replacementKey } : {}),
    preparationInput,
    input: prepared.input,
    // Completed results keep their normal handler contract; they never create a proposal.
    preflight:
      prepared.preflight.status === 'ready'
        ? snapshotActionProposal(prepared.preflight)
        : prepared.preflight,
  };
}
