// How often `useAgentChat` re-renders while an answer streams in: per network frame would rebuild
// the transcript once per token.

import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProvider, ModelTurnArgs, ModelTurnResult } from '../src/index.js';
import { AgentProvider, useAgentChat } from '../src/react/index.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';
import { act, renderHook, waitFor } from './helpers/dom.js';

const TOKENS = 150;

/** Streams its answer a token at a time, a couple of milliseconds apart — as a model does. */
class TrickleModel implements ModelProvider {
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    let text = '';
    for (let index = 0; index < TOKENS; index++) {
      const token = `w${index} `;
      text += token;
      await args.sink.write({ t: 'text', v: token });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: TOKENS } };
  }
}

let booted: BootedApp | undefined;
const consoleError = console.error;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('not wrapped in act')) consoleError(...args);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await booted?.close();
  booted = undefined;
});

describe('useAgentChat while an answer streams', () => {
  it('re-renders at a bounded rate, not once per streamed token', async () => {
    booted = await bootAgentApp({ model: new TrickleModel() });
    const connection = { baseUrl: booted.url, headers: { 'x-actor-id': 'u1' } };
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(AgentProvider, connection, children);
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useAgentChat();
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const before = renders;
    // Outside `act()`, so React renders each update as the stream delivers it.
    act(() => {
      void result.current.sendMessage({ text: 'go' });
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    await waitFor(() => expect(result.current.status).toBe('ready'), { timeout: 5000 });
    const last = result.current.messages.at(-1);
    const text = last?.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('');
    expect(text).toBe(Array.from({ length: TOKENS }, (_, index) => `w${index} `).join(''));
    // A ~0.4 s stream at 20 renders a second, plus the turn's own state changes.
    expect(renders - before).toBeLessThan(TOKENS / 3);
  });
});
