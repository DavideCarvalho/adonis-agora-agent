import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { getA2aHandler } from './runtime.js';

/**
 * Server middleware that answers A2A requests before the router runs — so before the bodyparser,
 * the session and CSRF. That is deliberate: A2A is stateless and authenticated by the personal
 * agent's signed JWT, PACT requires authenticating BEFORE the body is read (a malformed body without
 * a token is a 401, not a parse error), and its bodies are JSON whatever `Content-Type` they carry.
 * Everything that is not under the A2A prefix passes straight through.
 */
export default class A2aServerMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const handler = getA2aHandler();
    if (handler !== null && (await handler(ctx))) {
      return;
    }
    return next();
  }
}
