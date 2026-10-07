import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

let app: BootedApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const failure = new Error('renderer failed');
const lookup = defineTool({
  name: 'lookup',
  kind: 'read',
  description: 'lookup',
  input: z.object({}),
  execute: () => ({ found: true }),
  present: () => {
    throw failure;
  },
});
const model = () =>
  new FakeModelProvider((_args, turn) =>
    turn === 0 ? { text: '', toolCall: { name: 'lookup', input: {} } } : { text: 'Found it.' },
  );
const chat = async (url: string) =>
  readSse(
    await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'u1' },
      body: JSON.stringify({ message: 'look it up' }),
    }),
  );

it('hands a failed presentation to the configured onPresentationError, with the call`s ids', async () => {
  const report = vi.fn();
  app = await bootAgentApp({ model: model(), tools: [lookup], onPresentationError: report });
  const frames = await chat(app.url);
  const meta = frames.find((frame) => frame.event === 'meta')!.data;
  expect(report).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(failure, {
    toolName: 'lookup',
    toolCallId: expect.any(String),
    runId: meta.runId,
    threadId: meta.threadId,
  });
});

it('logs a failed presentation on the app logger by default', async () => {
  app = await bootAgentApp({ model: model(), tools: [lookup] });
  const logger = await app.app.container.make('logger');
  const warn = vi.spyOn(logger, 'warn');
  await chat(app.url);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ err: failure, toolName: 'lookup' }),
    'Tool presentation failed after successful execution',
  );
});
