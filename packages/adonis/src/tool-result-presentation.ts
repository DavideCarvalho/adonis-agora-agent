import { snapshotActionProposal } from './action-proposal-transitions.js';
import type { AiToolCtx, ToolHandler } from './spi/tool.js';

/** JSON-only component output, structurally shared with the optional GenUI core. */
export interface ComponentPresentation<P extends object = Record<string, unknown>> {
  component: string;
  props: P;
  version: number;
  fallbackText: string;
}

export type ToolResultPresentation =
  | ComponentPresentation<object>
  | readonly ComponentPresentation<object>[]
  | undefined;

function snapshot(value: ComponentPresentation<object>): ComponentPresentation {
  if (
    !value ||
    typeof value.component !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.component) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.fallbackText !== 'string' ||
    typeof value.props !== 'object' ||
    value.props === null ||
    Array.isArray(value.props)
  )
    throw new TypeError('Invalid tool component presentation');
  return snapshotActionProposal(value) as ComponentPresentation;
}

/** Presentation must never turn a completed domain write into a retryable tool failure. */
export async function presentToolResult(
  toolName: string,
  handler: ToolHandler,
  output: unknown,
  ctx: AiToolCtx,
): Promise<void> {
  if (handler.present === undefined) return;
  try {
    const result = await handler.present(output, ctx);
    if (result === undefined) return;
    const presentations = (Array.isArray(result) ? result : [result]).map(snapshot);
    for (const item of presentations) {
      await ctx.emitUi(item.component, item.props, {
        version: item.version,
        fallbackText: item.fallbackText,
      });
    }
  } catch (error) {
    try {
      if (ctx.onPresentationError !== undefined) {
        await ctx.onPresentationError(error, { toolName });
        return;
      }
    } catch {
      // A broken reporter must not cause the successful action to run again either.
    }
    console.warn('[agent] Tool presentation failed after successful execution', { toolName });
  }
}
