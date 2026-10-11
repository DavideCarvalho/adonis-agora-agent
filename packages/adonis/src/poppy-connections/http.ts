import type { PoppyConnectionsTexts } from './config.js';
import type { PoppyConnections } from './service.js';

/** The slice of a request/response the routes need — Adonis or a bare `node:http` server. */
export interface PoppyConnectionsExchange {
  method: string;
  /** Path without the query string. */
  path: string;
  query: URLSearchParams;
  readBody(limit: number): Promise<string>;
  send(status: number, headers: Record<string, string>, body: string): void;
}

/** What a connect page shows, for an app that renders its own (`render`). */
export type PoppyConnectView =
  | { view: 'expired' }
  | { view: 'connected'; organization: string }
  | { view: 'failed'; organization: string | null; retryUrl: string | null }
  | {
      view: 'choose';
      organization: string;
      directUrl: string | null;
      deviceUrl: string | null;
      mediated: {
        action: string;
        fields: { name: string; label: string; secret: boolean }[];
      } | null;
    }
  | { view: 'code'; organization: string; action: string; sentTo: string }
  | {
      view: 'device';
      organization: string;
      userCode: string;
      verificationUri: string;
      checkUrl: string;
      pending: boolean;
    };

export type PoppyConnectRenderer = (view: PoppyConnectView, texts: PoppyConnectionsTexts) => string;

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function fill(template: string, values: Record<string, string>): string {
  return escapeHtml(template).replace(/\{(\w+)\}/g, (_, k: string) =>
    values[k] !== undefined ? escapeHtml(values[k]) : `{${k}}`,
  );
}

/** The built-in pages: plain, accessible HTML; an app gives its own look with `render`. */
export const defaultConnectRenderer: PoppyConnectRenderer = (view, t) => {
  const org = 'organization' in view && view.organization ? view.organization : '';
  const button = (label: string) =>
    `<button type="submit" style="width:100%;padding:.75rem;border:0;border-radius:.75rem;background:#111;color:#fff;font-weight:600;font-size:1rem">${label}</button>`;
  let body = '';
  switch (view.view) {
    case 'expired':
      body = `<h1>${fill(t.expiredTitle, {})}</h1><p>${fill(t.expiredBody, {})}</p>`;
      break;
    case 'connected':
      body = `<h1>${fill(t.connectedTitle, { company: org })}</h1><p>${fill(t.connectedBody, {})}</p>`;
      break;
    case 'failed':
      body = `<h1>${fill(t.failedTitle, {})}</h1><p>${fill(t.failedBody, {})}</p>${
        view.retryUrl
          ? `<p><a href="${escapeHtml(view.retryUrl)}">${fill(t.connectTitle, { company: org })}</a></p>`
          : ''
      }`;
      break;
    case 'choose': {
      body = `<h1>${fill(t.connectTitle, { company: org })}</h1><p>${fill(t.connectBody, { company: org })}</p>`;
      if (view.directUrl) {
        body += `<form method="POST" action="${escapeHtml(view.directUrl)}">${button(fill(t.direct, { company: org }))}</form>`;
      }
      if (view.mediated) {
        body += `<h2>${fill(t.mediatedTitle, {})}</h2><form method="POST" action="${escapeHtml(view.mediated.action)}">`;
        for (const f of view.mediated.fields) {
          body += `<label style="display:block;margin:.5rem 0">${escapeHtml(f.label)}<input name="${escapeHtml(f.name)}" type="${f.secret ? 'password' : 'text'}" autocomplete="${f.secret ? 'current-password' : 'off'}" required style="display:block;width:100%;padding:.6rem;margin-top:.25rem;border:1px solid #ccc;border-radius:.5rem"></label>`;
        }
        body += `${button(fill(t.mediatedSubmit, {}))}</form>`;
      }
      if (view.deviceUrl) {
        body += `<form method="POST" action="${escapeHtml(view.deviceUrl)}" style="margin-top:1rem"><button type="submit" style="background:none;border:0;text-decoration:underline;cursor:pointer">${fill(t.device, {})}</button></form>`;
      }
      break;
    }
    case 'code':
      body = `<h1>${fill(t.codeTitle, {})}</h1><form method="POST" action="${escapeHtml(view.action)}"><label style="display:block;margin:.5rem 0">${fill(t.codeLabel, { sentTo: view.sentTo })}<input name="code" inputmode="numeric" autocomplete="one-time-code" required style="display:block;width:100%;padding:.6rem;margin-top:.25rem;border:1px solid #ccc;border-radius:.5rem"></label>${button(fill(t.codeSubmit, {}))}</form>`;
      break;
    case 'device':
      body = `<h1>${fill(t.connectTitle, { company: org })}</h1><p>${fill(t.deviceBody, { link: view.verificationUri, code: view.userCode })}</p><p><a href="${escapeHtml(view.verificationUri)}">${escapeHtml(view.verificationUri)}</a></p>${
        view.pending ? `<p>${fill(t.pendingBody, {})}</p>` : ''
      }<form method="POST" action="${escapeHtml(view.checkUrl)}">${button(fill(t.deviceCheck, {}))}</form>`;
      break;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${fill(t.pageTitle, {})}</title></head><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5">${body}</body></html>`;
};

const SECURITY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src * data:; form-action *; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
};

/** The default identity logo: the name's initial on a rounded square. */
export function defaultLogoSvg(name: string): string {
  const initial = escapeHtml(([...name.trim()][0] ?? 'A').toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#334155"/><text x="32" y="42" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#fff">${initial}</text></svg>`;
}

/**
 * The routes under `/{path}`: the agent identity (`agent.json`, `jwks.json`), the connect pages and
 * the Direct Sign-In callback. Returns `false` for anything else. Mounted ahead of the router: no
 * session, no CSRF token — the connect id in the URL is the capability (128 bits, single-purpose,
 * expiring), and the forms only ever post back to the same id.
 */
export function createPoppyConnectionsHandler(
  connections: PoppyConnections,
  options: { render?: PoppyConnectRenderer; onError?: (error: unknown) => void } = {},
): (ex: PoppyConnectionsExchange) => Promise<boolean> {
  const render = options.render ?? defaultConnectRenderer;
  const base = `/${connections.path}`;
  const page = (ex: PoppyConnectionsExchange, status: number, view: PoppyConnectView) =>
    ex.send(status, SECURITY_HEADERS, render(view, connections.texts));
  const url = (suffix: string) => `${connections.baseUrl}${base}${suffix}`;

  const choose = async (ex: PoppyConnectionsExchange, id: string) => {
    const data = await connections.page(id);
    if (data.kind === 'expired') return page(ex, 410, { view: 'expired' });
    if (data.kind === 'connected')
      return page(ex, 200, { view: 'connected', organization: data.organization });
    return page(ex, 200, {
      view: 'choose',
      organization: data.organization,
      directUrl: data.direct ? url(`/connect/${id}/direct`) : null,
      deviceUrl: data.device ? url(`/connect/${id}/device`) : null,
      mediated: data.mediated
        ? { action: url(`/connect/${id}/mediated`), fields: data.mediated }
        : null,
    });
  };

  return async (ex) => {
    if (ex.path !== base && !ex.path.startsWith(`${base}/`)) return false;
    const rest = ex.path.slice(base.length);
    try {
      if (ex.method === 'GET' && rest === '/agent.json') {
        const identity = await connections.identity();
        ex.send(
          200,
          { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
          JSON.stringify(identity.metadata()),
        );
        return true;
      }
      if (ex.method === 'GET' && rest === '/logo.svg') {
        // The default `logo_uri` (when `identity.logoUri` is not set) — a Company's consent screen
        // shows it, so it must not 404: a mark with the name's initial.
        ex.send(
          200,
          { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
          defaultLogoSvg(connections.identityName),
        );
        return true;
      }
      if (ex.method === 'GET' && rest === '/jwks.json') {
        const identity = await connections.identity();
        ex.send(
          200,
          { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
          JSON.stringify(identity.jwks()),
        );
        return true;
      }
      if (ex.method === 'GET' && rest === '/oauth/callback') {
        const result = await connections.directCallback(ex.query);
        if (result.ok)
          page(ex, 200, { view: 'connected', organization: result.organization ?? '' });
        else {
          const id = (ex.query.get('state') ?? '').split('.')[0] ?? '';
          page(ex, 400, {
            view: 'failed',
            organization: result.organization,
            retryUrl: id ? url(`/connect/${id}`) : null,
          });
        }
        return true;
      }
      const match = /^\/connect\/([A-Za-z0-9_-]{16,64})(\/[a-z/]+)?$/.exec(rest);
      if (!match) return false;
      const id = match[1]!;
      const action = match[2] ?? '';
      if (ex.method === 'GET' && action === '') {
        await choose(ex, id);
        return true;
      }
      if (ex.method !== 'POST') {
        ex.send(405, { allow: 'GET, POST' }, '');
        return true;
      }
      const form = new URLSearchParams(await ex.readBody(16 * 1024));
      if (action === '/direct') {
        const to = await connections.directUrl(id);
        if (to === null) page(ex, 410, { view: 'expired' });
        else ex.send(303, { location: to, 'cache-control': 'no-store' }, '');
        return true;
      }
      if (action === '/mediated' || action === '/code') {
        const outcome =
          action === '/mediated'
            ? await connections.mediated(id, Object.fromEntries(form))
            : await connections.mediatedCode(id, form.get('code') ?? '');
        const data = await connections.page(id);
        const organization =
          data.kind === 'open' || data.kind === 'connected' ? data.organization : '';
        if (outcome.status === 'connected') page(ex, 200, { view: 'connected', organization });
        else if (outcome.status === 'code_required') {
          page(ex, 200, {
            view: 'code',
            organization,
            action: url(`/connect/${id}/code`),
            sentTo: outcome.sentTo ?? '',
          });
        } else if (outcome.status === 'expired') page(ex, 410, { view: 'expired' });
        else page(ex, 400, { view: 'failed', organization, retryUrl: url(`/connect/${id}`) });
        return true;
      }
      if (action === '/device' || action === '/device/check') {
        const data = await connections.page(id);
        if (data.kind === 'expired') {
          page(ex, 410, { view: 'expired' });
          return true;
        }
        const organization = data.organization;
        if (action === '/device') {
          const started = await connections.deviceStart(id);
          if (started === null) page(ex, 410, { view: 'expired' });
          else
            page(ex, 200, {
              view: 'device',
              organization,
              ...started,
              checkUrl: url(`/connect/${id}/device/check`),
              pending: false,
            });
          return true;
        }
        const status = await connections.deviceCheck(id);
        if (status === 'connected') page(ex, 200, { view: 'connected', organization });
        else if (status === 'pending') {
          const again = await connections.deviceInfo(id);
          page(
            ex,
            200,
            again === null
              ? { view: 'expired' }
              : {
                  view: 'device',
                  organization,
                  ...again,
                  checkUrl: url(`/connect/${id}/device/check`),
                  pending: true,
                },
          );
        } else if (status === 'expired') page(ex, 410, { view: 'expired' });
        else page(ex, 400, { view: 'failed', organization, retryUrl: url(`/connect/${id}`) });
        return true;
      }
      return false;
    } catch (error) {
      options.onError?.(error);
      page(ex, 500, { view: 'failed', organization: null, retryUrl: null });
      return true;
    }
  };
}
