import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, assert, describe, it } from 'vitest';
import {
  authServerMetadataUrl,
  discover,
  protectedResourceMetadataUrl,
  validatePoppyDocument,
  wellKnownUrlFor,
} from '../../src/poppy-client/discovery.js';
import { DpopKey, htuOf } from '../../src/poppy-client/dpop.js';
import { DiscoveryError } from '../../src/poppy-client/errors.js';
import { AgentIdentity } from '../../src/poppy-client/identity.js';
import { generateEs256Key } from '../../src/poppy-client/keys.js';
import { signSessionJwt } from '../../src/poppy-client/session_jwt.js';
import { parseSse } from '../../src/poppy-client/sse.js';
import {
  parseRetryAfter,
  parseWwwAuthenticate,
  requireSecureUrl,
  wwwAuthError,
} from '../../src/poppy-client/util.js';
import { rejects } from './fixtures/assert.js';

const doc = (over: Record<string, unknown> = {}) => ({
  protocol_version: '0.3',
  organization: { name: 'Ex', domain: 'example.com' },
  auth: { scopes: { 'orders:read': 'See your orders' } },
  agent: {
    protocols: [{ type: 'poppy', endpoint: 'https://api.example.com/poppy/conversations' }],
  },
  ...over,
});
const meta = (over: Record<string, unknown> = {}) => ({
  issuer: 'https://auth.example.com',
  token_endpoint: 'https://auth.example.com/oauth/token',
  revocation_endpoint: 'https://auth.example.com/oauth/revoke',
  authorization_endpoint: 'https://auth.example.com/oauth/authorize',
  grant_types_supported: ['refresh_token', 'authorization_code'],
  protected_resources: ['https://example.com'],
  ...over,
});
const PRM = 'https://example.com/.well-known/oauth-protected-resource';
const prm = (over: Record<string, unknown> = {}) => ({
  resource: 'https://example.com',
  authorization_servers: ['https://auth.example.com'],
  ...over,
});
const AS = 'https://auth.example.com/.well-known/oauth-authorization-server';

function mockFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response('nope', { status: 404 });
    return r();
  };
  return { fn, calls };
}
const json =
  (b: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(b), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
const redirect = (to: string) => () =>
  new Response(null, { status: 302, headers: { location: to } });

describe('discovery (section 3)', () => {
  it('valid document, issuer from protected resource metadata, unknown fields ignored', async () => {
    const { fn } = mockFetch({
      'https://example.com/.well-known/poppy.json': json(doc({ future: 1 })),
      [PRM]: json(prm()),
      [AS]: json(meta({ extra: true })),
    });
    const d = await discover('example.com', { fetch: fn });
    assert.equal(d.document.organization.name, 'Ex');
    assert.equal(d.identifier, 'https://auth.example.com');
    assert.equal(d.metadata?.token_endpoint, 'https://auth.example.com/oauth/token');
  });

  it('www. is not ignored: organization.domain is the host that served the document', async () => {
    const { fn } = mockFetch({ 'https://www.example.com/.well-known/poppy.json': json(doc()) });
    await rejects(() => discover('www.example.com', { fetch: fn }), /organization.domain/);
    assert.doesNotThrow(() => validatePoppyDocument(doc(), 'EXAMPLE.com'));
  });

  it('a redirect counts: the document speaks for the final host', async () => {
    const { fn } = mockFetch({
      'https://www.example.com/.well-known/poppy.json': redirect(
        'https://example.com/.well-known/poppy.json',
      ),
      'https://example.com/.well-known/poppy.json': json(doc()),
      [PRM]: json(prm()),
      [AS]: json(meta()),
    });
    assert.equal((await discover('www.example.com', { fetch: fn })).domain, 'example.com');
  });

  it('a redirect must end at the well-known path, with no query', async () => {
    for (const to of [
      'https://cdn.provider.net/ex/poppy.json',
      'https://example.com/.well-known/poppy.json?x=1',
    ]) {
      const { fn } = mockFetch({
        'https://example.com/.well-known/poppy.json': redirect(to),
        [to]: json(doc()),
      });
      await rejects(() => discover('example.com', { fetch: fn }), /well-known path/);
    }
  });

  it('refuses a redirect to http://', async () => {
    const { fn } = mockFetch({
      'https://example.com/.well-known/poppy.json': redirect('http://cdn.provider.net/poppy.json'),
    });
    await rejects(() => discover('example.com', { fetch: fn }), /https/);
  });

  it('refuses plain http without --insecure-dev, and internal addresses', async () => {
    assert.throws(() => wellKnownUrlFor('http://localhost:3333'), /insecure-dev/);
    assert.equal(
      wellKnownUrlFor('localhost:3333', { insecureDev: true }).toString(),
      'http://localhost:3333/.well-known/poppy.json',
    );
    for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]', 'localhost']) {
      assert.throws(() => requireSecureUrl(`https://${host}/x`, 'url', {}), /internal/, host);
    }
    assert.doesNotThrow(() => requireSecureUrl('https://example.com/x', 'url', {}));
  });

  it('domain mismatch', () => {
    assert.throws(() => validatePoppyDocument(doc(), 'evil.com'), /is not the host/);
  });

  it('before 1.0 only the exact major.minor is usable', () => {
    for (const version of ['1.0', '0.2', '0.4']) {
      assert.throws(
        () => validatePoppyDocument(doc({ protocol_version: version }), 'example.com'),
        /not supported/,
      );
    }
    assert.doesNotThrow(() => validatePoppyDocument(doc(), 'example.com'));
  });

  it('auth is optional; one of agent/apis/web required', () => {
    assert.doesNotThrow(() => validatePoppyDocument(doc({ auth: undefined }), 'example.com'));
    assert.throws(
      () =>
        validatePoppyDocument(
          { protocol_version: '0.3', organization: { name: 'x', domain: 'example.com' } },
          'example.com',
        ),
      /at least one/,
    );
  });

  it('no issuer: 404 or metadata without servers; other failures never fall back', async () => {
    const poppy = { 'https://example.com/.well-known/poppy.json': json(doc()) };
    const absent = await discover('example.com', { fetch: mockFetch(poppy).fn });
    assert.equal(absent.identifier, 'https://example.com');
    assert.equal(absent.noIssuer, 'not_found');
    const empty = await discover('example.com', {
      fetch: mockFetch({ ...poppy, [PRM]: json(prm({ authorization_servers: [] })) }).fn,
    });
    assert.equal(empty.noIssuer, 'metadata');
    assert.isUndefined(empty.metadata);

    await rejects(
      () =>
        discover('example.com', {
          fetch: mockFetch({ ...poppy, [PRM]: () => new Response('x', { status: 500 }) }).fn,
        }),
      /HTTP 500/,
    );
    await rejects(
      () =>
        discover('example.com', {
          fetch: mockFetch({ ...poppy, [PRM]: () => new Response('not json') }).fn,
        }),
      /not JSON/,
    );
    await rejects(
      () =>
        discover('example.com', {
          fetch: mockFetch({ ...poppy, [PRM]: json(prm({ resource: 'https://other.com' })) }).fn,
        }),
      /resource/,
    );
    // auth.issuer without metadata that lists it.
    await rejects(
      () =>
        discover('example.com', {
          fetch: mockFetch({
            'https://example.com/.well-known/poppy.json': json(
              doc({ auth: { issuer: 'https://auth.example.com' } }),
            ),
          }).fn,
        }),
      /auth.issuer/,
    );
  });

  it('several authorization servers: auth.issuer picks one of them', async () => {
    const servers = {
      authorization_servers: ['https://staff.example.com', 'https://auth.example.com'],
    };
    const withIssuer = doc({ auth: { issuer: 'https://auth.example.com' } });
    const d = await discover('example.com', {
      fetch: mockFetch({
        'https://example.com/.well-known/poppy.json': json(withIssuer),
        [PRM]: json(prm(servers)),
        [AS]: json(meta()),
      }).fn,
    });
    assert.equal(d.identifier, 'https://auth.example.com');
    await rejects(
      () =>
        discover('example.com', {
          fetch: mockFetch({
            'https://example.com/.well-known/poppy.json': json(doc()),
            [PRM]: json(prm(servers)),
          }).fn,
        }),
      /auth.issuer/,
    );
  });

  it('issuer must match exactly, and protected_resources must list the domain', async () => {
    for (const bad of [
      meta({ issuer: 'https://auth.example.com/' }),
      meta({ protected_resources: ['https://other.com'] }),
      meta({ protected_resources: undefined }),
    ]) {
      const { fn } = mockFetch({
        'https://example.com/.well-known/poppy.json': json(doc()),
        [PRM]: json(prm()),
        [AS]: json(bad),
      });
      await rejects(() => discover('example.com', { fetch: fn }), DiscoveryError as any);
    }
  });

  it('required fields follow grant_types_supported', async () => {
    for (const [bad, why] of [
      [meta({ authorization_endpoint: undefined }), /authorization_endpoint/],
      [meta({ grant_types_supported: ['authorization_code'] }), /refresh_token/],
      [meta({ grant_types_supported: undefined }), /grant_types_supported/],
    ] as const) {
      const { fn } = mockFetch({
        'https://example.com/.well-known/poppy.json': json(doc()),
        [PRM]: json(prm()),
        [AS]: json(bad),
      });
      await rejects(() => discover('example.com', { fetch: fn }), why);
    }
  });

  it('RFC 8414 and RFC 9728 metadata URLs with a path', () => {
    assert.equal(
      authServerMetadataUrl('https://auth.example.com/tenant1').toString(),
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
    );
    assert.equal(
      protectedResourceMetadataUrl('https://example.com/mcp').toString(),
      'https://example.com/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('cache honours max-age', async () => {
    const { HttpJsonCache } = await import('../../src/poppy-client/discovery.js');
    const cache = new HttpJsonCache();
    const { fn, calls } = mockFetch({
      'https://example.com/.well-known/poppy.json': json(doc(), { 'cache-control': 'max-age=60' }),
      [PRM]: json(prm()),
      [AS]: json(meta()),
    });
    await discover('example.com', { fetch: fn, cache });
    await discover('example.com', { fetch: fn, cache });
    assert.equal(calls.filter((c) => c.endsWith('poppy.json')).length, 1);
  });
});

describe('assertions and proofs', () => {
  it('DPoP proof shape (RFC 9449)', async () => {
    const key = await DpopKey.generate();
    const proof = await key.proof({
      htm: 'post',
      htu: 'https://a.example/x?y=1#z',
      accessToken: 'tok',
      nonce: 'n1',
    });
    const h = decodeProtectedHeader(proof);
    const p = decodeJwt(proof);
    assert.equal(h.typ, 'dpop+jwt');
    assert.equal(h.alg, 'ES256');
    assert.notProperty(h.jwk as object, 'd');
    assert.equal(p.htm, 'POST');
    assert.equal(p.htu, 'https://a.example/x');
    assert.equal(p.nonce, 'n1');
    assert.isString(p.ath);
    assert.isAtLeast(Buffer.from(String(p.jti), 'base64url').length, 16);
    assert.equal(htuOf('https://a.example/p?q#f'), 'https://a.example/p');
  });

  it('identity: client_id, metadata, client assertion, delegation', async () => {
    const id = new AgentIdentity({
      baseUrl: 'https://agent.example/',
      clientName: 'A',
      keys: [await generateEs256Key()],
    });
    const m = id.metadata();
    assert.equal(m.client_id, 'https://agent.example/agent.json');
    assert.deepEqual(m.redirect_uris, ['https://agent.example/oauth/callback']);
    assert.equal(m.token_endpoint_auth_method, 'private_key_jwt');
    for (const k of id.jwks().keys) assert.notProperty(k, 'd');
    const a = decodeJwt(await id.clientAssertion('https://auth.example.com'));
    assert.equal(a.iss, m.client_id);
    assert.equal(a.sub, m.client_id);
    assert.equal(a.aud, 'https://auth.example.com');
    assert.isAtMost(Number(a.exp) - Number(a.iat), 60);

    const key = await generateEs256Key();
    const { jwt, exp } = await id.delegate(key.publicJwk);
    assert.equal(decodeProtectedHeader(jwt).typ, 'pap-delegation+jwt');
    const dlg = decodeJwt(jwt);
    assert.equal(dlg.exp, exp);
    assert.isAtMost(Number(dlg.exp) - Number(dlg.iat), 24 * 3600);
    assert.equal(Number(dlg.iat) % 3600, 0);
    assert.notProperty(dlg, 'sub');
    assert.notProperty(dlg, 'aud');
    assert.notProperty((dlg.cnf as { jwk: object }).jwk, 'd');
    assert.throws(
      () => new AgentIdentity({ baseUrl: 'http://agent.example', clientName: 'A', keys: [] }),
      /https/,
    );
  });

  it('Session JWT: typ, kid, pap_dlg, htu without query, ath only with a token', async () => {
    const key = await generateEs256Key();
    const base = {
      key,
      delegation: 'dlg',
      clientId: 'https://agent.example/agent.json',
      audience: 'https://auth.example.com',
      sid: 'sid123',
      userId: 'usr_x',
      method: 'post',
      url: 'https://api.example.com/x?y=1',
    };
    const signedOut = await signSessionJwt(base);
    const h = decodeProtectedHeader(signedOut);
    assert.equal(h.typ, 'poppy-session+jwt');
    assert.equal(h.alg, 'ES256');
    assert.equal(h.kid, key.kid);
    assert.equal(h.pap_dlg, 'dlg');
    const c = decodeJwt(signedOut);
    assert.equal(c.htm, 'POST');
    assert.equal(c.htu, 'https://api.example.com/x');
    assert.notProperty(c, 'ath');
    assert.notProperty(c, 'agent_id');
    assert.isString(decodeJwt(await signSessionJwt({ ...base, accessToken: 't' })).ath);
    assert.equal(decodeJwt(await signSessionJwt({ ...base, agentId: 'a' })).agent_id, 'a');
  });
});

describe('parsers', () => {
  it('WWW-Authenticate', () => {
    assert.deepEqual(
      wwwAuthError('DPoP error="insufficient_scope", scope="poppy:read poppy:write"'),
      {
        error: 'insufficient_scope',
        scope: 'poppy:read poppy:write',
        description: undefined,
      },
    );
    const c = parseWwwAuthenticate('Bearer realm="x", error=invalid_token, DPoP algs="ES256"');
    assert.equal(c.length, 2);
    assert.equal(c[0]?.params.error, 'invalid_token');
    assert.equal(parseRetryAfter('3'), 3);
  });

  it('SSE parser', async () => {
    const text =
      ': comment\r\nid: evt_1\ndata: {"a":1}\n\nevent: text-delta\ndata: {"t":\ndata: 2}\n\ndata: partial';
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const events = [];
    for await (const e of parseSse(stream)) events.push(e);
    assert.deepEqual(events, [
      { event: 'message', data: '{"a":1}', id: 'evt_1', retry: undefined },
      { event: 'text-delta', data: '{"t":\n2}', id: undefined, retry: undefined },
    ]);
  });
});

describe('state store', () => {
  it('concurrent saves do not race on the tmp file', async () => {
    const { mkdtemp, readFile, readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { StateStore } = await import('../../src/poppy-client/store.js');
    const dir = await mkdtemp(join(tmpdir(), 'poppy-store-'));
    const store = await StateStore.open(join(dir, 'state.json'));
    // A conversation stream and the prompt both save: this used to fail with ENOENT on rename.
    await Promise.all(Array.from({ length: 8 }, () => store.save()));
    assert.isObject(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')));
    assert.deepEqual(
      (await readdir(dir)).filter((f) => f.endsWith('.tmp')),
      [],
    );
  });
});
