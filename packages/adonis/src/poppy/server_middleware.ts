import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { getPoppyHandler } from './runtime.js';

/**
 * Server middleware that answers Poppy requests before the router runs — before the bodyparser,
 * the session and CSRF, like the A2A surface: a Poppy request is authenticated by its Session
 * Token (DPoP), BEFORE its body is read. Everything outside the endpoint passes straight through.
 */
export default class PoppyServerMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const handler = getPoppyHandler();
    if (handler !== null && (await handler(ctx))) {
      return;
    }
    return next();
  }
}
