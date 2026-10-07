import type { OpenCodeClient } from '../../../src/opencode/client.js';
import type { OpenCodeHost, OpenCodeServer } from '../../../src/opencode/index.js';
import { realClient } from './client-shape.js';

/** A host on the OpenCode 2 server the live specs are pointed at (`OPENCODE_LIVE_*`). */
export class LiveHost implements OpenCodeHost {
  readonly client: OpenCodeClient = realClient(
    process.env.OPENCODE_LIVE_URL ?? '',
    process.env.OPENCODE_LIVE_PASSWORD ?? '',
  );
  bootId = 'live';

  constructor(
    private readonly key = 'live',
    private readonly rules: Array<{ action: string; effect: 'allow' | 'deny' | 'ask' }> = [
      { action: '*', effect: 'deny' },
      { action: 'question', effect: 'allow' },
      { action: 'webfetch', effect: 'ask' },
    ],
  ) {}

  async server(): Promise<OpenCodeServer> {
    return { client: this.client, key: this.key, bootId: this.bootId };
  }

  async session() {
    const [providerID, ...rest] = (process.env.OPENCODE_LIVE_MODEL ?? '').split('/');
    return {
      model: { providerID: providerID ?? '', id: rest.join('/') },
      location: { directory: process.env.OPENCODE_LIVE_DIR ?? process.cwd() },
      permissions: this.rules.map((rule) => ({ ...rule, resource: '*' })),
    };
  }
}
