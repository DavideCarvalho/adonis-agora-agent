import type { ToolHandler } from './spi/tool.js';
import type { Actor, ToolSpec } from './types.js';

/**
 * Is this tool part of this deployment right now? `ToolSpec.enabled` and the handler's
 * `isEnabled()` are ANDed — either one saying no is enough — and both default to yes.
 *
 * Resolved per turn rather than at registration, so the answer can come from configuration that
 * did not exist when the tool was registered.
 */
export async function isToolEnabled(spec: ToolSpec, handler?: ToolHandler): Promise<boolean> {
  const declared =
    typeof spec.enabled === 'function' ? await spec.enabled() : (spec.enabled ?? true);
  if (!declared) {
    return false;
  }
  return handler?.isEnabled === undefined ? true : await handler.isEnabled();
}

/**
 * Drop tools this deployment has turned off, before anyone asks who may call them. A disabled tool
 * is absent, not forbidden — the difference matters, because "forbidden" tells the model (and the
 * user reading a refusal) that the capability exists.
 */
export async function filterToolsByEnabled<T extends { spec: ToolSpec; handler?: ToolHandler }>(
  entries: T[],
): Promise<T[]> {
  const checked = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      enabled: await isToolEnabled(entry.spec, entry.handler),
    })),
  );
  return checked.filter((row) => row.enabled).map((row) => row.entry);
}

/**
 * May this actor use this tool, per the tool's OWN gate? Tools without a `canUse` say yes and are
 * governed by the `RolesPolicy` alone.
 */
export async function canActorUseTool(actor: Actor, handler?: ToolHandler): Promise<boolean> {
  return handler?.canUse === undefined ? true : await handler.canUse(actor);
}

/**
 * Drop tools whose own `canUse` refuses this actor. Runs after the app-wide `RolesPolicy`, and is
 * additive to it — a tool can narrow who reaches it, never widen.
 */
export async function filterToolsByCanUse<T extends { spec: ToolSpec; handler?: ToolHandler }>(
  entries: T[],
  actor: Actor,
): Promise<T[]> {
  const checked = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      allowed: await canActorUseTool(actor, entry.handler),
    })),
  );
  return checked.filter((row) => row.allowed).map((row) => row.entry);
}
