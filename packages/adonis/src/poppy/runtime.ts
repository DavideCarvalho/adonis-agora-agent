import type { HttpContext } from '@adonisjs/core/http';

/** The request handler the Poppy server middleware delegates to; `false` = not a Poppy request. */
export type PoppyRequestHandler = (ctx: HttpContext) => Promise<boolean>;

/**
 * Set by the Poppy provider at boot, read by the server middleware per request — a module
 * singleton for the reason the A2A one is (the framework builds the middleware from a lazy import).
 */
let current: PoppyRequestHandler | null = null;

export function setPoppyHandler(handler: PoppyRequestHandler | null): void {
  current = handler;
}

export function getPoppyHandler(): PoppyRequestHandler | null {
  return current;
}
