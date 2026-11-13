import type { HttpContext } from '@adonisjs/core/http';
import { type ConsoleAuthorize, consoleAuthorizeFor } from '../console-authorize.js';
import type { DevToolsCaller } from './contract.js';

/** The action tool a {@link DevToolsActionsAuthorizer} is asked about. */
export interface DevToolsActionRequest {
  /** The lib id: `'payments'`. */
  lib: string;
  /** The full tool name: `'payments_refund_payment'`. */
  tool: string;
  /** Whether the lib marked it as cancelling, refunding, revoking or deleting something. */
  destructive: boolean;
  /** Who is calling (`'user:42'`, `'token:…'`, `'dev-open'`). */
  caller: DevToolsCaller;
}

/**
 * The function form of `devTools.actions`: decides each action tool for this request. Run while the
 * request's tools are assembled, so a `false` both hides the tool from `tools/list` and refuses a call
 * to it. Anything but `true`, or a throw,
 * refuses.
 */
export type DevToolsActionsAuthorizer = (
  ctx: HttpContext,
  action: DevToolsActionRequest,
) => boolean | Promise<boolean>;

/**
 * The map form of `devTools.actions`: lib ids and full tool names, each to a console `authorize`
 * (function, authorizer class or lazy import). A tool-name key wins over its lib's key; an action in
 * neither is refused.
 */
export type DevToolsActionsMap = Record<string, ConsoleAuthorize>;

/**
 * What `devTools.actions` may say:
 * - `'refuse'` (default): no action tool is listed or callable.
 * - `'execute'`: every action tool of an allowed lib.
 * - `string[]`: those of these lib ids or tool names.
 * - {@link DevToolsActionsMap}: per lib or per tool, each with its own `authorize`.
 * - {@link DevToolsActionsAuthorizer}: a function deciding each action tool.
 */
export type DevToolsActions =
  | 'refuse'
  | 'execute'
  | string[]
  | DevToolsActionsMap
  | DevToolsActionsAuthorizer;

/** Why an action tool was left out, for the debug line. */
export interface DevToolsActionRefusal {
  reason: 'not-configured' | 'denied' | 'threw';
  error?: unknown;
}

/**
 * One request's view of `devTools.actions`: each distinct `authorize` of the map runs at most once,
 * however many tools point at it.
 */
export class DevToolsActionsGate {
  readonly #actions: DevToolsActions;
  readonly #ctx: HttpContext;
  readonly #caller: DevToolsCaller;
  readonly #decisions = new Map<ConsoleAuthorize, Promise<true | DevToolsActionRefusal>>();

  constructor(actions: DevToolsActions, ctx: HttpContext, caller: DevToolsCaller) {
    this.#actions = actions;
    this.#ctx = ctx;
    this.#caller = caller;
  }

  /** Whether `actions` decides per caller (map or function), rather than statically. */
  get dynamic(): boolean {
    return isDynamicActions(this.#actions);
  }

  /** `true` when the action tool is served to this request, else why not. */
  async decide(action: {
    lib: string;
    tool: string;
    destructive: boolean;
  }): Promise<true | DevToolsActionRefusal> {
    const actions = this.#actions;
    if (actions === 'execute') return true;
    // `null` / `undefined` from an untyped config: the default, refuse.
    if (actions === 'refuse' || actions === null || actions === undefined) {
      return { reason: 'not-configured' };
    }
    if (Array.isArray(actions)) {
      return actions.includes(action.lib) || actions.includes(action.tool)
        ? true
        : { reason: 'not-configured' };
    }
    if (typeof actions === 'function') {
      try {
        const allowed = await actions(this.#ctx, { ...action, caller: this.#caller });
        return allowed === true ? true : { reason: 'denied' };
      } catch (error) {
        return { reason: 'threw', error };
      }
    }
    const authorize = own(actions, action.tool) ?? own(actions, action.lib);
    if (authorize === undefined) return { reason: 'not-configured' };
    let decision = this.#decisions.get(authorize);
    if (decision === undefined) {
      decision = this.#run(authorize);
      this.#decisions.set(authorize, decision);
    }
    return decision;
  }

  async #run(authorize: ConsoleAuthorize): Promise<true | DevToolsActionRefusal> {
    const decision = await consoleAuthorizeFor(authorize)(this.#ctx);
    if (decision.allowed) return true;
    // `{ redirectTo }` and `401` are denials too: there is no page to send an MCP client to.
    return decision.error !== undefined
      ? { reason: 'threw', error: decision.error }
      : { reason: 'denied' };
  }
}

/** Whether `actions` is the map or function form. */
export function isDynamicActions(actions: DevToolsActions): boolean {
  return (
    typeof actions === 'function' ||
    (actions !== null && typeof actions === 'object' && !Array.isArray(actions))
  );
}

function own(map: DevToolsActionsMap, key: string): ConsoleAuthorize | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
