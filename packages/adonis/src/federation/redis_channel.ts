import { randomUUID } from 'node:crypto';

/**
 * The Redis channel the federated console talks to another app over: the console publishes a
 * command on `<prefix>-agent-console`, every instance of the owning app hears it, the one that wins
 * `SET <prefix>-agent-console-claim:<id> NX PX` runs it, and the answer comes back on
 * `<prefix>-agent-console-reply`. Same design as `@adonis-agora/durable`'s console commands, on
 * channels of its own (`-agent-`), so both can share an app's prefix.
 */

/** One command sent to the owning app. Arguments and answer are plain JSON. */
export interface AgentConsoleCommand {
  id: string;
  verb: string;
  args: unknown[];
  /** Who acted in the console, for the owning app's log. */
  actor?: string;
}

/** The owning app's answer to a {@link AgentConsoleCommand}. */
export type AgentConsoleReply =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { message: string; code?: string; status?: number } };

/** An `ioredis` client: pub/sub needs a dedicated connection, made with `duplicate()`. */
export interface IoredisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  duplicate(): IoredisSubscriberLike;
}

export interface IoredisSubscriberLike {
  subscribe(...channels: string[]): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  disconnect?(): void;
}

/** An `@adonisjs/redis` connection: it keeps its own subscriber and hands each payload over. */
export interface AdonisRedisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  subscribe(channel: string, handler: (message: string) => void): unknown;
  unsubscribe?(channel: string): unknown;
}

export type RedisLike = IoredisLike | AdonisRedisLike;

/** How long a command waits for its answer by default. */
export const AGENT_CONSOLE_TIMEOUT_MS = 15_000;
/** How long the claim on a command lives (longer than any answer is waited for). */
const CLAIM_TTL_MS = 120_000;

function isIoredis(client: RedisLike): client is IoredisLike {
  return typeof (client as IoredisLike).duplicate === 'function';
}

/** `SET key value PX ttl NX` on either client: `'OK'` for the one caller that wins the key. */
function claimOf(
  client: RedisLike,
): ((key: string, value: string) => Promise<unknown>) | undefined {
  const target =
    typeof client.set === 'function'
      ? client
      : (client as { ioConnection?: { set?: IoredisLike['set'] } }).ioConnection;
  const set = target?.set;
  if (typeof set !== 'function') return undefined;
  return (key, value) => set.call(target, key, value, 'PX', CLAIM_TTL_MS, 'NX');
}

/** A command the owning app refused or failed, or that nobody answered. */
export class AgentConsoleChannelError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AgentConsoleChannelError';
    this.code = code;
  }
}

/** Nobody listens on the app's channel, or nobody answered in time. */
export const APP_UNREACHABLE = 'federated-app-unreachable';

export class RedisConsoleChannel {
  readonly prefix: string;
  readonly #client: RedisLike;
  readonly #subscriptions: Array<() => void> = [];
  readonly #handlers = new Map<string, (payload: string) => void>();
  readonly #pending = new Map<string, (reply: AgentConsoleReply) => void>();
  #subscriber: IoredisSubscriberLike | undefined;
  #replies: Promise<void> | undefined;
  #answering = false;
  #closed = false;

  constructor(options: { client: RedisLike; prefix: string }) {
    if (!options.prefix)
      throw new Error('[@adonis-agora/agent] console channel: prefix is required');
    this.#client = options.client;
    this.prefix = options.prefix;
  }

  get commandChannel(): string {
    return `${this.prefix}-agent-console`;
  }

  get replyChannel(): string {
    return `${this.prefix}-agent-console-reply`;
  }

  /** Subscribe `handler` to `channel`; resolves once the subscription is in place. */
  async #subscribe(channel: string, handler: (payload: string) => void): Promise<void> {
    const client = this.#client;
    if (isIoredis(client)) {
      if (!this.#subscriber) {
        const sub = client.duplicate();
        this.#subscriber = sub;
        sub.on('message', (ch, payload) => this.#handlers.get(ch)?.(payload));
      }
      this.#handlers.set(channel, handler);
      await this.#subscriber.subscribe(channel);
      return;
    }
    await client.subscribe(channel, handler);
    this.#subscriptions.push(() => void client.unsubscribe?.(channel));
  }

  /**
   * Send `command` to the owning app and wait for its answer. Rejects at once when no instance
   * listens (`PUBLISH` reached nobody) and after `timeoutMs` when nobody answers.
   */
  async send(
    command: AgentConsoleCommand,
    options: { timeoutMs?: number | undefined } = {},
  ): Promise<AgentConsoleReply> {
    if (this.#closed) throw new AgentConsoleChannelError('console channel closed', APP_UNREACHABLE);
    if (!this.#replies) {
      const replies = this.#subscribe(this.replyChannel, (payload) => {
        let reply: AgentConsoleReply;
        try {
          reply = JSON.parse(payload) as AgentConsoleReply;
        } catch {
          return;
        }
        this.#pending.get(reply?.id)?.(reply);
      });
      this.#replies = replies;
      // A failed subscribe (a Redis blip) is retried by the next send, not kept for good.
      replies.catch(() => {
        if (this.#replies === replies) this.#replies = undefined;
      });
    }
    try {
      await this.#replies;
    } catch (error) {
      throw new AgentConsoleChannelError(
        `could not subscribe to the "${this.prefix}" app's console replies: ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    const timeoutMs = options.timeoutMs ?? AGENT_CONSOLE_TIMEOUT_MS;
    return new Promise<AgentConsoleReply>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        this.#pending.delete(command.id);
        reject(new AgentConsoleChannelError(message, APP_UNREACHABLE));
      };
      const timer = setTimeout(
        () =>
          fail(
            `no instance of the "${this.prefix}" app answered the agent console command ${command.verb} within ${timeoutMs}ms`,
          ),
        timeoutMs,
      );
      timer.unref?.();
      this.#pending.set(command.id, (reply) => {
        clearTimeout(timer);
        this.#pending.delete(command.id);
        resolve(reply);
      });
      this.#client.publish(this.commandChannel, JSON.stringify(command)).then(
        (receivers) => {
          // Redis says how many subscribers got it: none means no instance answers commands.
          if (receivers === 0) {
            fail(
              `no instance of the "${this.prefix}" app listens for agent console commands (is it up, with \`consoleCommands\` in config/agent.ts?)`,
            );
          }
        },
        (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /**
   * Answer the commands other apps' consoles send this app. Every instance subscribes; the one that
   * wins `SET <prefix>-agent-console-claim:<id> NX` runs the command and publishes the answer, so a
   * command runs once however many processes the app has. Throws when the client cannot run that
   * `SET`: a command never runs without the claim.
   */
  async answer(
    handler: (command: AgentConsoleCommand) => Promise<unknown>,
    options: { onError?: (error: unknown) => void } = {},
  ): Promise<void> {
    if (this.#answering) return;
    const claim = claimOf(this.#client);
    if (!claim) {
      throw new Error(
        `the "${this.prefix}" Redis connection cannot run \`SET key value PX ms NX\`, so agent console commands cannot be claimed by one instance; refusing to answer them`,
      );
    }
    this.#answering = true;
    const instance = randomUUID();
    await this.#subscribe(this.commandChannel, (payload) => {
      void this.#run(payload, instance, claim, handler).catch((error) => options.onError?.(error));
    });
  }

  async #run(
    payload: string,
    instance: string,
    claim: (key: string, value: string) => Promise<unknown>,
    handler: (command: AgentConsoleCommand) => Promise<unknown>,
  ): Promise<void> {
    let command: AgentConsoleCommand;
    try {
      command = JSON.parse(payload) as AgentConsoleCommand;
    } catch {
      return;
    }
    if (typeof command?.id !== 'string' || typeof command.verb !== 'string') return;
    if ((await claim(`${this.prefix}-agent-console-claim:${command.id}`, instance)) !== 'OK')
      return;
    let reply: AgentConsoleReply;
    try {
      const data = await handler({
        ...command,
        args: Array.isArray(command.args) ? command.args : [],
      });
      // `undefined` (an action with no answer) travels as `null`.
      reply = { id: command.id, ok: true, data: data === undefined ? null : data };
    } catch (err) {
      const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
      reply = {
        id: command.id,
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof status === 'number' ? { status } : {}),
        },
      };
    }
    await this.#client.publish(this.replyChannel, JSON.stringify(reply));
  }

  /** Stop listening and fail the commands still waiting for an answer. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const [id, settle] of this.#pending) {
      settle({
        id,
        ok: false,
        error: { message: 'console channel closed', code: APP_UNREACHABLE },
      });
    }
    this.#pending.clear();
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    this.#subscriber?.disconnect?.();
    this.#subscriber = undefined;
  }
}

/**
 * The Redis client for `connection` (an `@adonisjs/redis` connection name; omit for its default),
 * resolved through the container's `redis` binding.
 */
export async function resolveRedisConnection(
  container: { make(binding: string): Promise<unknown> },
  connection: string | undefined,
): Promise<RedisLike> {
  let redis: { connection(name?: string): unknown };
  try {
    redis = (await container.make('redis')) as typeof redis;
  } catch (error) {
    throw new Error(
      `[@adonis-agora/agent] the federated console needs @adonisjs/redis (no "redis" binding: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return redis.connection(connection) as RedisLike;
}
