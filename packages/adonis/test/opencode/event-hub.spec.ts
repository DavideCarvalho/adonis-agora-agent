import { describe, expect, it } from 'vitest';
import type { OpenCodeEvent } from '../../src/opencode/client.js';
import { OpenCodeEventHub } from '../../src/opencode/event-hub.js';
import { FakeOpenCode } from '../helpers/fake-opencode.js';

describe('OpenCodeEventHub', () => {
  it('follows a server onto a new client for the same key', async () => {
    const hub = new OpenCodeEventHub();
    const first = new FakeOpenCode();
    const second = new FakeOpenCode();
    const heard: OpenCodeEvent[] = [];
    const stopA = await hub.listen('tenant-1', first, 'ses_1', (e) => heard.push(e));
    // The host replaced the connection (a new sandbox under the same key).
    const stopB = await hub.listen('tenant-1', second, 'ses_2', (e) => heard.push(e));

    first.emit({ type: 'session.text.delta', data: { sessionID: 'ses_1', delta: 'old' } });
    second.emit({ type: 'session.text.delta', data: { sessionID: 'ses_1', delta: 'a' } });
    second.emit({ type: 'session.text.delta', data: { sessionID: 'ses_2', delta: 'b' } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(heard.map((e) => e.data.delta)).toEqual(['a', 'b']);
    stopA();
    stopB();
    hub.close();
  });
});
