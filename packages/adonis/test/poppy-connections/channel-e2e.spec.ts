// @vitest-environment node
import { createServer } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionProposalWorker } from '../../src/action-proposal-worker.js';
import { channels } from '../../src/channels/index.js';
import { generateEs256Key } from '../../src/poppy-client/keys.js';
import { FakeModelProvider } from '../../src/testing/fake-model-provider.js';
import { InMemoryAgentStore } from '../../src/testing/in-memory-store.js';
import { type BootedApp, bootAgentApp } from '../helpers/boot-agent-app.js';
import { fakeAdapter, inbound, makeCtx } from '../helpers/channels.js';
import { FakeCompany } from '../poppy-client/fixtures/fake_company.js';

vi.setConfig({ testTimeout: 30_000 });

let app: BootedApp | undefined;
let company: FakeCompany | undefined;
let worker: ActionProposalWorker | undefined;
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await app?.close();
  await company?.stop();
  app = undefined;
  company = undefined;
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The person signs in at the company through the link (Direct: the company's consent says yes). */
async function signIn(link: string): Promise<string> {
  const toCompany = await fetch(`${link}/direct`, { method: 'POST', redirect: 'manual' });
  expect(toCompany.status).toBe(303);
  const authorize = await fetch(toCompany.headers.get('location')!, { redirect: 'manual' });
  const callback = await fetch(authorize.headers.get('location')!);
  return callback.text();
}

/**
 * The connect flow over a text channel (a WhatsApp-like adapter), end to end against the real
 * providers: the connect card arrives as a message with the link in full and no reply buttons; the
 * sign-in on the company decides it; once its outcome is in, the turn continues on its own and the
 * continuation reaches the same conversation.
 */
it('WhatsApp-like channel: link card → sign-in → the turn continues in the chat', async () => {
  company = await new FakeCompany().start();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const store = new InMemoryAgentStore();
  const { adapter, outbox } = fakeAdapter({ buttons: 3 });
  const threads = new Map<string, string>();
  let handle!: ReturnType<typeof channels.handle>;
  const model = new FakeModelProvider((args) => {
    const users = args.messages.filter((m) => m.role === 'user' && m.content !== '');
    const last = String(users.at(-1)?.content ?? '');
    if (last.includes('I connected my account at Fake Co')) {
      return { text: 'Connected to Fake Co — ordering the boots now.' };
    }
    const lastUser = args.messages.lastIndexOf(users.at(-1)!);
    if (args.messages.slice(lastUser + 1).some((m) => m.role === 'assistant'))
      return { text: 'Open the link to sign in.' };
    return { text: '', toolCall: { name: 'poppy_connect', input: { company: 'Fake Co' } } };
  });

  app = await bootAgentApp(
    {
      model,
      store: 'test',
      stores: { test: async () => store },
      actionApprovalMode: 'independent',
      backgroundActorResolver: { resolve: async ({ actorRef }) => ({ id: actorRef, roles: [] }) },
      actionProposalWorker: { pollIntervalMs: 10, leaseMs: 3000, onSettled: channels.onSettled },
    },
    {
      port,
      providers: [() => import('../../providers/poppy_connections_provider.js')],
      config: {
        poppy_connections: {
          baseUrl: base,
          identity: {
            name: 'Acme Assistant',
            keys: [(await generateEs256Key()).privateJwk as Record<string, unknown>],
          },
          companies: [company.domain],
          store: 'memory',
          secret: 'x'.repeat(32),
          insecureDev: true,
        },
      },
      routes: (router) => {
        handle = channels.handle(adapter, {
          actor: (message) => ({ id: `wa:${message.from}`, roles: [] }),
          thread: (_actor, message) => threads.get(message.conversation),
          onThreadCreated: (threadId, _actor, message) => {
            threads.set(message.conversation, threadId);
          },
          outcomeTimeoutMs: 0,
        });
        router.post('/webhooks/test', handle);
      },
    },
  );

  // The proposal worker, as `start()` runs it in a served app (one, in this process).
  worker = await app.app.container.make(ActionProposalWorker);
  worker.start();

  // The person asks on WhatsApp; the agent needs their account at the company.
  await handle(makeCtx(inbound('order boots at Fake Co')).ctx);
  await handle.drain();
  const card = outbox.map((item) => item.message).find((m) => m.text?.includes('/connect/'));
  expect(card).toBeDefined();
  const link = /(http:\/\/\S+\/poppy-agent\/connect\/[A-Za-z0-9_-]+)/.exec(card!.text!)![1]!;
  // The link in full, what to do — and nothing to reply or press.
  expect(card!.text).toContain('Open the link to continue.');
  expect(card!.text).not.toMatch(/Reply \*/);
  expect(card).not.toHaveProperty('buttons');

  // They open it and sign in at the company.
  expect(await signIn(link)).toContain('Connected to Fake Co');

  // The connect ran, its outcome was written, and the turn went on — in the same conversation.
  const deadline = Date.now() + 15_000;
  while (
    !outbox.some((item) => item.message.text?.includes('ordering the boots now')) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const sent = outbox.map((item) => item.message.text ?? '');
  expect(sent.some((text) => text.includes('ordering the boots now'))).toBe(true);
  expect(outbox.every((item) => item.conversation === 'chat-1')).toBe(true);
  // Exactly once.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(
    outbox.filter((item) => item.message.text?.includes('ordering the boots now')),
  ).toHaveLength(1);
});
