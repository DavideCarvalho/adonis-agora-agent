import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { getPoppyConnectionsHandler } from './runtime.js';

/**
 * Serves the agent identity, the connect pages and the sign-in callback ahead of the router — no
 * session, CSRF or bodyparser: the connect id in the URL is the capability.
 */
export default class PoppyConnectionsServerMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const handler = getPoppyConnectionsHandler();
    if (handler !== null && (await handler(ctx))) return;
    return next();
  }
}
