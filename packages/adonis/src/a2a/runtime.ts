import type { HttpContext } from '@adonisjs/core/http';

/** The request handler the A2A server middleware delegates to; `false` = not an A2A request. */
export type A2aRequestHandler = (ctx: HttpContext) => Promise<boolean>;

/**
 * Set by the A2A provider at boot, read by the server middleware per request. A module singleton
 * because the server middleware is instantiated by the framework from a lazy import, with no way
 * to hand it constructor arguments.
 */
let current: A2aRequestHandler | null = null;

export function setA2aHandler(handler: A2aRequestHandler | null): void {
  current = handler;
}

export function getA2aHandler(): A2aRequestHandler | null {
  return current;
}
