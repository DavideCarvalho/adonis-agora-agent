import { afterEach, describe, expect, it } from 'vitest';
import { exhaustedWindow, type QuotaReport, quotaPeriodRange, quotas } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

let booted: BootedApp | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});
const headers = { 'content-type': 'application/json', 'x-actor-id': 'u1' };
const send = (url: string) =>
  fetch(`${url}/agent/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'hi' }) });

describe('quota windows', () => {
  it('computes UTC windows and names the exhausted one', () => {
    const now = new Date('2026-02-14T15:00:00.000Z');
    expect(quotaPeriodRange('day', now)).toEqual({
      fromDay: '2026-02-14',
      toDay: '2026-02-14',
      resetsAt: '2026-02-15T00:00:00.000Z',
    });
    expect(quotaPeriodRange('month', now)).toEqual({
      fromDay: '2026-02-01',
      toDay: '2026-02-28',
      resetsAt: '2026-03-01T00:00:00.000Z',
    });
    expect(
      exhaustedWindow([
        { period: 'day', usedTokens: 1, limitTokens: 10, usedUsd: 0 },
        { period: 'month', usedTokens: 1, usedUsd: 5, limitUsd: 5 },
      ]),
    ).toEqual({ period: 'month', reason: 'Monthly spend limit reached' });
  });

  it('reports usage with no budget configured, and never gates', async () => {
    booted = await bootAgentApp({ model: new FakeModelProvider(() => ({ text: 'Hello there' })) });
    await readSse(await send(booted.url));
    const report = (await (
      await fetch(`${booted.url}/agent/quota`, { headers })
    ).json()) as QuotaReport;
    expect(report.blocked).toBeUndefined();
    expect(report.windows.map((window) => window.period)).toEqual(['day', 'month']);
    expect(report.windows[0]?.usedTokens).toBeGreaterThan(0);
    expect(report.windows[0]).not.toHaveProperty('limitTokens');
    expect((await send(booted.url)).status).toBe(200);
  });

  it('refuses a send with 429 quota_exceeded once a window is used up', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: 'Hello there' })),
      quota: quotas.windows({ day: { tokens: 5 }, month: { usd: 100 } }),
    });
    await readSse(await send(booted.url));
    const report = (await (
      await fetch(`${booted.url}/agent/quota`, { headers })
    ).json()) as QuotaReport;
    expect(report.windows[0]).toMatchObject({
      period: 'day',
      limitTokens: 5,
      resetsAt: expect.any(String),
    });
    expect(report.windows[1]).toMatchObject({ period: 'month', limitUsd: 100 });
    expect(report.blocked).toEqual({ period: 'day', reason: 'Daily token limit reached' });

    const refused = await send(booted.url);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      code: 'quota_exceeded',
      period: 'day',
      message: 'Daily token limit reached',
    });
  });

  it('lends a daily QuotaStore ceiling to the report and leaves its enforcement to the loop', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: 'Hello there' })),
      quota: quotas.memory({ limitTokens: 1000 }),
    });
    const report = (await (
      await fetch(`${booted.url}/agent/quota`, { headers })
    ).json()) as QuotaReport;
    expect(report.windows[0]).toMatchObject({ period: 'day', limitTokens: 1000 });
  });
});
