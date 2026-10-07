import type {
  OpenCodeClient,
  OpenCodeEvent,
  OpenCodeForm,
  OpenCodePermissionRequest,
  OpenCodePromptFile,
  OpenCodeSessionCreate,
} from '../../src/opencode/client.js';

export interface FakeCall {
  method: string;
  args: Record<string, unknown>;
}

/** What the fake does when a session is prompted: emit events, wait for replies, emit more. */
export type FakeScript = (turn: FakeTurn) => Promise<void>;

export interface FakeTurn {
  sessionId: string;
  text: string;
  emit(type: string, data?: Record<string, unknown>): void;
  /** Resolves with the next call of `method` on this session (e.g. `permission.reply`). */
  next(method: string): Promise<FakeCall>;
  /** Ends the execution: `session.execution.succeeded`. */
  succeed(): void;
}

/**
 * An OpenCode 2 server in memory, shaped after the v2 API the engine calls: sessions, prompts that
 * run a script of events, permission and form replies, interrupts, and one event stream for every
 * session. Every call is recorded in `calls`.
 */
export class FakeOpenCode implements OpenCodeClient {
  readonly calls: FakeCall[] = [];
  private readonly listeners = new Set<(event: OpenCodeEvent) => void>();
  private readonly waiters: Array<{
    method: string;
    sessionId: string;
    resolve: (c: FakeCall) => void;
  }> = [];
  private sessions = 0;
  private readonly metadata = new Map<string, OpenCodeSessionCreate['metadata']>();
  /** Permission requests and forms asked and not answered yet (what `list` reports). */
  readonly openPermissions = new Map<string, OpenCodePermissionRequest>();
  readonly openForms = new Map<string, OpenCodeForm>();
  /** User messages per session, for `message.list` (regenerate). */
  private readonly userMessages = new Map<string, string[]>();
  private readonly idleWaiters: Array<() => void> = [];
  private idle = false;

  /** The sessions go idle: `session.wait` resolves (until the next prompt). */
  goIdle(): void {
    this.idle = true;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  constructor(
    public script: FakeScript = async (t) => {
      t.emit('session.text.delta', { delta: `echo: ${t.text}` });
      t.emit('session.step.ended', { tokens: { input: 10, output: 5 } });
      t.succeed();
    },
  ) {}

  private record(method: string, args: Record<string, unknown>): void {
    const call = { method, args };
    this.calls.push(call);
    const sessionId = String(args.sessionID ?? '');
    const index = this.waiters.findIndex((w) => w.method === method && w.sessionId === sessionId);
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter?.resolve(call);
    }
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  emit(event: OpenCodeEvent): void {
    if (event.type === 'permission.asked') {
      this.openPermissions.set(String(event.data.id), event.data as OpenCodePermissionRequest);
    }
    if (event.type === 'form.created') {
      const form = (event.data.form ?? event.data) as OpenCodeForm;
      this.openForms.set(form.id, form);
    }
    for (const listener of this.listeners) listener(event);
  }

  /** Raise an event without anyone hearing it — what OpenCode did while the API was down. */
  emitUnheard(event: OpenCodeEvent): void {
    const listeners = [...this.listeners];
    this.listeners.clear();
    this.emit(event);
    for (const listener of listeners) this.listeners.add(listener);
  }

  session = {
    create: async (args: OpenCodeSessionCreate) => {
      this.record('session.create', args as Record<string, unknown>);
      this.sessions += 1;
      const id = `ses_${this.sessions}`;
      this.metadata.set(id, args.metadata ?? {});
      return { id };
    },
    get: async (args: { sessionID: string }) => {
      this.record('session.get', args);
      return { id: args.sessionID, metadata: this.metadata.get(args.sessionID) ?? {} };
    },
    prompt: async (args: { sessionID: string; text: string; files?: OpenCodePromptFile[] }) => {
      this.record('session.prompt', args);
      this.idle = false;
      const sessionId = args.sessionID;
      const ids = this.userMessages.get(sessionId) ?? [];
      ids.push(`msg_${sessionId}_${ids.length + 1}`);
      this.userMessages.set(sessionId, ids);
      const turn: FakeTurn = {
        sessionId,
        text: args.text,
        emit: (type, data = {}) => this.emit({ type, data: { sessionID: sessionId, ...data } }),
        next: (method) =>
          new Promise((resolve) => this.waiters.push({ method, sessionId, resolve })),
        succeed: () =>
          this.emit({ type: 'session.execution.succeeded', data: { sessionID: sessionId } }),
      };
      // OpenCode answers the prompt at once and runs the execution in the background.
      void Promise.resolve().then(() => this.script(turn));
      return {};
    },
    interrupt: async (args: { sessionID: string }) => {
      this.record('session.interrupt', args);
      this.emit({ type: 'session.execution.interrupted', data: { sessionID: args.sessionID } });
      return {};
    },
    wait: async (args: { sessionID: string }) => {
      this.record('session.wait', args);
      if (!this.idle) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
      return {};
    },
    revert: {
      stage: async (args: { sessionID: string; messageID: string; files?: boolean }) => {
        this.record('session.revert.stage', args);
        return {};
      },
      commit: async (args: { sessionID: string }) => {
        this.record('session.revert.commit', args);
        return {};
      },
    },
    instructions: {
      entry: {
        put: async (args: { sessionID: string; key: string; value: string }) => {
          this.record('session.instructions.entry.put', args);
          return {};
        },
      },
    },
    form: {
      list: async (args: { sessionID: string }) =>
        [...this.openForms.values()].filter((f) => f.sessionID === args.sessionID),
      reply: async (args: {
        sessionID: string;
        formID: string;
        answer: Record<string, unknown>;
      }) => {
        this.openForms.delete(args.formID);
        this.record('session.form.reply', args);
        return {};
      },
      cancel: async (args: { sessionID: string; formID: string }) => {
        this.openForms.delete(args.formID);
        this.record('session.form.cancel', args);
        return {};
      },
    },
  };

  permission = {
    list: async (args: { sessionID: string }) =>
      [...this.openPermissions.values()].filter((p) => p.sessionID === args.sessionID),
    reply: async (args: {
      sessionID: string;
      requestID: string;
      decision: 'once' | 'reject';
      message?: string;
    }) => {
      this.openPermissions.delete(args.requestID);
      this.record('permission.reply', args);
      return {};
    },
  };

  message = {
    list: async (args: { sessionID: string; order?: 'asc' | 'desc'; limit?: number }) => {
      this.record('message.list', args);
      const ids = [...(this.userMessages.get(args.sessionID) ?? [])];
      if (args.order === 'desc') ids.reverse();
      return { data: ids.map((id) => ({ id, type: 'user' })) };
    },
  };

  mcp = {
    add: async (args: Parameters<NonNullable<OpenCodeClient['mcp']>['add']>[0]) => {
      this.record('mcp.add', args as unknown as Record<string, unknown>);
      return {};
    },
  };

  /** Files written, by path. */
  readonly files = new Map<string, string>();

  file = {
    write: async (args: {
      location?: { directory: string };
      path: string;
      payload: Uint8Array;
    }) => {
      this.record('file.write', { path: args.path, location: args.location });
      this.files.set(args.path, new TextDecoder().decode(args.payload));
      return {};
    },
  };

  event = {
    subscribe: (args: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent> => {
      const queue: OpenCodeEvent[] = [];
      let wake: (() => void) | undefined;
      const listener = (event: OpenCodeEvent) => {
        queue.push(event);
        wake?.();
      };
      this.listeners.add(listener);
      const listeners = this.listeners;
      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (!args.signal.aborted) {
              const event = queue.shift();
              if (event !== undefined) {
                yield event;
                continue;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
                args.signal.addEventListener('abort', () => resolve(), { once: true });
              });
              wake = undefined;
            }
          } finally {
            listeners.delete(listener);
          }
        },
      };
    },
  };
}
