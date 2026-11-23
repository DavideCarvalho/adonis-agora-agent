import type { CompanyClient } from './company.js';
import { throwForResponse } from './company.js';
import { PoppyError } from './errors.js';
import { requireSecureUrl } from './util.js';

/** The scope a signed-in browser join needs (section 6). Request it only where `browserSessionEndpoint` exists. */
export const BROWSER_SIGN_IN_SCOPE = 'poppy:browser-sign-in';

/**
 * `web.disabled`: the Company asks Personal Agents not to browse its website in a browser, and to use
 * its Company Agent and APIs (section 6). Pages fetched without a browser aren't covered.
 */
export function browsingDisabled(company: CompanyClient): boolean {
  return company.document.web?.disabled === true;
}

/** Where the Personal Agent's browser joins a Session (section 6), or an error without one. */
export function browserSessionEndpoint(company: CompanyClient): string {
  const endpoint = company.document.web?.browser_session_endpoint;
  if (!endpoint) {
    throw new PoppyError(
      'no_browser_session_endpoint',
      'Company has no web.browser_session_endpoint: browse as an ordinary signed-out visitor',
    );
  }
  return requireSecureUrl(endpoint, 'web.browser_session_endpoint', company.security).toString();
}

/**
 * Step 2: reads the one-time code from the HTML of the page the agent's OWN browser loaded in step
 * 1 (section 6). Pass it nothing else: a code from anywhere else may come from someone else's
 * browser, which would then join the User's Session (10.6). Keep the code out of model context.
 */
export function browserJoinCode(html: string): string {
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']?code["']?(?:\s|\/|>)/i.test(tag)) continue;
    const value = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const code = value?.[1] ?? value?.[2] ?? value?.[3];
    if (code) return code;
  }
  throw new PoppyError('invalid_browser_page', 'the browser-session page has no code field');
}

/**
 * Step 2: authorizes the code with the Session header and, if signed in, the access token, which
 * never reaches the browser. A token without `poppy:browser-sign-in` is refused with
 * `insufficient_scope`: the same code is then authorized signed out (section 6). Answers whether the
 * join is signed in. The agent's browser then submits the form (step 3); after a failure, start
 * again at step 1.
 */
export async function authorizeBrowserJoin(
  company: CompanyClient,
  code: string,
  opts: { signedOut?: boolean | undefined } = {},
): Promise<{ signedIn: boolean }> {
  const url = `${browserSessionEndpoint(company).replace(/\/+$/, '')}/authorize`;
  const authorize = (signedOut: boolean) =>
    company.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      ...(signedOut ? { signedOut: true } : {}),
    });
  const signedOut = opts.signedOut === true || company.accountToken === undefined;
  let res = await authorize(signedOut);
  if (res.status === 204) return { signedIn: !signedOut };
  if (
    !signedOut &&
    res.status === 403 &&
    /insufficient_scope/.test(res.headers.get('www-authenticate') ?? '')
  ) {
    await res.body?.cancel().catch(() => {});
    res = await authorize(true);
    if (res.status === 204) return { signedIn: false };
  }
  return throwForResponse(res);
}
