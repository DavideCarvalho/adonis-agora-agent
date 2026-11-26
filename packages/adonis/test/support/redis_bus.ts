import type { AdonisRedisLike } from '../../src/federation/redis_channel.js';

/**
 * An in-memory stand-in for one Redis server, handing out `@adonisjs/redis`-shaped connections:
 * `PUBLISH` answers how many subscribers got the message, and `SET … PX … NX` is atomic, so the
 * federated console's claim works across the "instances" a test makes.
 */
export class RedisBus {
  readonly #subscribers = new Map<string, Set<(message: string) => void>>();
  readonly #keys = new Map<string, string>();
  readonly published: Array<{ channel: string; message: string }> = [];

  connection(): AdonisRedisLike & { subscriptions: Array<[string, (m: string) => void]> } {
    const subscriptions: Array<[string, (m: string) => void]> = [];
    return {
      subscriptions,
      publish: async (channel, message) => {
        this.published.push({ channel, message });
        const handlers = [...(this.#subscribers.get(channel) ?? [])];
        // Delivered asynchronously, like a real server round trip.
        queueMicrotask(() => {
          for (const handler of handlers) handler(message);
        });
        return handlers.length;
      },
      set: async (key, value, _px, _ms, _nx) => {
        if (this.#keys.has(key)) return null;
        this.#keys.set(key, value);
        return 'OK';
      },
      subscribe: async (channel, handler) => {
        let set = this.#subscribers.get(channel);
        if (!set) {
          set = new Set();
          this.#subscribers.set(channel, set);
        }
        set.add(handler);
        subscriptions.push([channel, handler]);
      },
      unsubscribe: (channel) => {
        for (const [ch, handler] of subscriptions) {
          if (ch === channel) this.#subscribers.get(ch)?.delete(handler);
        }
      },
    };
  }

  /** Everything that crossed the bus, as one string (to assert a secret never did). */
  get wire(): string {
    return this.published.map((p) => p.message).join('\n');
  }
}
