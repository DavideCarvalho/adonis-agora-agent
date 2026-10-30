import { createServer } from 'node:net';
import { assert, describe, it } from 'vitest';
import { discover } from '../../src/poppy-client/discovery.js';
import { PoppyError } from '../../src/poppy-client/errors.js';
import { PoppyHttp } from '../../src/poppy-client/http.js';
import {
  createSafeFetch,
  isBlockedAddress,
  type LookupFn,
  safeFetch,
} from '../../src/poppy-client/safe_fetch.js';
import { rejects } from './fixtures/assert.js';

const resolvesTo =
  (...addresses: string[]): LookupFn =>
  (_host, _opts, cb) =>
    cb(
      null,
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );

describe('safe fetch (section 3)', () => {
  it('classifies internal addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:0:127.0.0.1',
      '64:ff9b::10.0.0.1',
      '2002:7f00:1::1',
      'not-an-ip',
    ]) {
      assert.isTrue(isBlockedAddress(ip), ip);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
      assert.isFalse(isBlockedAddress(ip), ip);
    }
  });

  it('refuses a name that resolves to an internal address, even one among public ones', async () => {
    for (const lookup of [
      resolvesTo('127.0.0.1'),
      resolvesTo('10.0.0.5'),
      resolvesTo('169.254.169.254'),
      resolvesTo('fe80::1'),
      resolvesTo('93.184.216.34', '192.168.0.1'),
    ]) {
      const f = createSafeFetch({ lookup });
      await rejects(() => f('https://rebind.example/x'), /blocked address/);
    }
  });

  it('refuses address literals, plain http and credentials without connecting', async () => {
    await rejects(() => safeFetch('https://127.0.0.1/x'), /blocked address/);
    await rejects(() => safeFetch('https://[::1]/x'), /blocked address/);
    await rejects(() => safeFetch('https://[::ffff:7f00:1]/x'), /blocked address/);
    await rejects(() => safeFetch('http://example.com/x'), /not HTTPS/);
    await rejects(() => safeFetch('https://u:p@example.com/x'), /credentials/);
  });

  it('connects to the very address it checked: one lookup, no second chance to rebind', async () => {
    const seen: string[] = [];
    const server = createServer((socket) => {
      seen.push(socket.remoteAddress ?? '');
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    let lookups = 0;
    const answers = ['127.0.0.1', '10.9.9.9'];
    const checked: string[] = [];
    const f = createSafeFetch({
      lookup: (_h, _o, cb) => {
        const address = answers[lookups++] ?? '10.9.9.9';
        cb(null, [{ address, family: 4 }]);
      },
      isBlocked: (ip) => {
        checked.push(ip);
        return ip !== '127.0.0.1';
      },
    });
    await f(`https://rebind.example:${port}/x`).catch(() => {});
    server.close();
    assert.equal(lookups, 1);
    assert.deepEqual(checked, ['127.0.0.1']);
    assert.lengthOf(seen, 1);
  });

  it('discovery: a redirect hop to a name resolving internally is refused', async () => {
    const hops: string[] = [];
    const guarded = createSafeFetch({ lookup: resolvesTo('10.0.0.5') });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      hops.push(String(input));
      if (String(input).startsWith('https://example.com/')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://inside.example/.well-known/poppy.json' },
        });
      }
      return guarded(input, init);
    };
    await rejects(() => discover('example.com', { fetch }), /blocked address/);
    assert.deepEqual(hops, [
      'https://example.com/.well-known/poppy.json',
      'https://inside.example/.well-known/poppy.json',
    ]);
  });

  it('the defaults are guarded; --insecure-dev is the opt-in', async () => {
    await rejects(() => new PoppyHttp().request('https://127.0.0.1/x'), /blocked address/);
    const err = await discover('https://127.0.0.2', {}).catch((e: unknown) => e);
    assert.instanceOf(err, Error);
    assert.notInstanceOf(err, PoppyError);
    assert.match((err as Error).message, /internal address/);
    // The opt-in reaches a local address: the connection itself is what fails here.
    const dev = await discover('http://127.0.0.1:9', { insecureDev: true }).catch(
      (e: unknown) => e,
    );
    assert.notMatch((dev as Error).message, /blocked|internal/);
  });
});
