import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { type AdonisRedisLike, RedisConsoleChannel } from '../src/federation/redis_channel.js';

/**
 * The console channel against a real Redis: every instance of the owning app hears each command,
 * and the `SET NX` claim makes exactly one of them run it. Runs when `AGENT_TEST_REDIS_URL` is set.
 */
const url = process.env.AGENT_TEST_REDIS_URL;

describe.skipIf(!url)('RedisConsoleChannel (real Redis)', () => {
  const clients: Redis[] = [];
  const channels: RedisConsoleChannel[] = [];
  const prefix = `agent-fed-${randomBytes(4).toString('hex')}`;

  /** A connection of the owning app (`et:` keyPrefix) or of the console's app (`hub:`). */
  const client = (keyPrefix: string) => {
    const redis = new Redis(url as string, { keyPrefix, lazyConnect: false });
    clients.push(redis);
    return redis;
  };
  const channel = (redis: Redis | AdonisRedisLike, name = prefix) => {
    const ch = new RedisConsoleChannel({ client: redis as never, prefix: name });
    channels.push(ch);
    return ch;
  };

  afterAll(async () => {
    await Promise.all(channels.map((ch) => ch.close()));
    for (const redis of clients) redis.disconnect();
  });

  it('runs each command exactly once across three instances', async () => {
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      await channel(client('et:')).answer(async (command) => {
        runs.push(command.id);
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        return { by: i, echo: command.args[0] };
      });
    }
    const sender = channel(client('hub:'));
    const ids = Array.from({ length: 20 }, () => randomUUID());
    const replies = await Promise.all(
      ids.map((id, n) => sender.send({ id, verb: 'disks', args: [n] }, { timeoutMs: 5_000 })),
    );
    expect(replies.every((r) => r.ok)).toBe(true);
    expect(replies.map((r) => (r.ok ? (r.data as { echo: number }).echo : -1))).toEqual(
      ids.map((_, n) => n),
    );
    expect(runs.sort()).toEqual([...ids].sort());
  });

  it("carries the app's error, with its status, back to the console", async () => {
    const name = `${prefix}-err`;
    await channel(client('et:'), name).answer(async () => {
      throw Object.assign(new Error('Unknown tool call.'), { status: 404 });
    });
    const reply = await channel(client('hub:'), name).send({
      id: randomUUID(),
      verb: 'x',
      args: [],
    });
    expect(reply).toMatchObject({
      ok: false,
      error: { message: 'Unknown tool call.', status: 404 },
    });
  });

  it('fails at once when nobody listens, and after the timeout when nobody answers', async () => {
    const lonely = channel(client('hub:'), `${prefix}-nobody`);
    const started = Date.now();
    await expect(lonely.send({ id: randomUUID(), verb: 'disks', args: [] })).rejects.toThrow(
      /listens for agent console commands/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);

    const deaf = client('et:').duplicate();
    clients.push(deaf);
    await deaf.subscribe(`${prefix}-deaf-agent-console`);
    await expect(
      channel(client('hub:'), `${prefix}-deaf`).send(
        { id: randomUUID(), verb: 'disks', args: [] },
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow(/answered .* within 100ms/);
  });

  it('works over an @adonisjs/redis-shaped connection too', async () => {
    const name = `${prefix}-adonis`;
    // `@adonisjs/redis` keeps its own subscriber and hands each payload to the handler.
    const adonis = (keyPrefix: string): AdonisRedisLike => {
      const commands = client(keyPrefix);
      const subscriber = commands.duplicate();
      clients.push(subscriber);
      const handlers = new Map<string, (m: string) => void>();
      subscriber.on('message', (ch, message) => handlers.get(ch)?.(message));
      return {
        publish: (ch, message) => commands.publish(ch, message),
        set: (key, value, px, ms, nx) => commands.set(key, value, px, ms, nx),
        subscribe: async (ch, handler) => {
          handlers.set(ch, handler);
          await subscriber.subscribe(ch);
        },
      };
    };
    let runs = 0;
    for (let i = 0; i < 2; i++) {
      await channel(adonis('et:'), name).answer(async () => {
        runs++;
        return 'ok';
      });
    }
    const reply = await channel(adonis('hub:'), name).send({
      id: randomUUID(),
      verb: 'disks',
      args: [],
    });
    expect(reply).toMatchObject({ ok: true, data: 'ok' });
    expect(runs).toBe(1);
  });
});
