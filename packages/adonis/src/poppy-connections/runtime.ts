import type { HttpContext } from '@adonisjs/core/http';

/** Set by the provider at boot; read by the server middleware per request (`false` = not ours). */
let current: ((ctx: HttpContext) => Promise<boolean>) | null = null;

export function setPoppyConnectionsHandler(
  handler: ((ctx: HttpContext) => Promise<boolean>) | null,
) {
  current = handler;
}

export function getPoppyConnectionsHandler() {
  return current;
}
