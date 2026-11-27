import type { CommonHooks } from '@adonisjs/assembler/types';
import Hooks from '@poppinss/hooks';
import { describe, expect, it } from 'vitest';
import defaultHook, { GENERATED_TOOLS_OUTPUT, toolsHook } from '../src/hooks/tools.js';

type InitHook = CommonHooks['init'][number];

// Compile-time regression (type-checked by `pnpm typecheck`): both forms `adonisrc.ts` uses match
// the assembler's own hook type. The previous `{ run }` default export failed `LazyImport`.
const registered: InitHook[] = [
  () => import('../src/hooks/tools.js'),
  async () => ({ default: toolsHook({ source: 'app/ai/tools', importAlias: '#ai_tools' }) }),
];

/** A minimal stand-in for the Assembler IndexGenerator: records the `add(name, config)` calls. */
function fakeIndexGenerator() {
  const calls: Array<{ name: string; config: Record<string, unknown> }> = [];
  return {
    calls,
    generator: {
      add(name: string, config: Record<string, unknown>) {
        calls.push({ name, config });
        return this;
      },
    },
  };
}

describe('tools assembler init hook', () => {
  it('the default export is a FUNCTION, which is what the hook runner calls', () => {
    expect(typeof defaultHook).toBe('function');
    expect(typeof toolsHook()).toBe('function');
    expect(registered).toHaveLength(2);
  });

  it('runs through @poppinss/hooks — the runner the assembler drives it with', async () => {
    // The assembler adds a lazily imported hook's default export to @poppinss/hooks, which calls a
    // non-function handler as `handler.handle(action, ...data)`: the previous `{ run }` export
    // failed `node ace build` with `handler.handle is not a function`.
    const fake = fakeIndexGenerator();
    const hooks = new Hooks();
    hooks.add('init', defaultHook as never);

    await hooks.runner('init').run(undefined, undefined, fake.generator as never);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.name).toBe('agent_tools');
    expect(fake.calls[0]?.config).toMatchObject({
      source: 'app/agent_tools',
      importAlias: '#agent_tools',
      output: GENERATED_TOOLS_OUTPUT,
      exportName: 'tools',
    });
  });

  it('passes the factory options to the generator', async () => {
    const fake = fakeIndexGenerator();
    const hooks = new Hooks();
    hooks.add('init', toolsHook({ source: 'app/ai/tools', importAlias: '#ai_tools' }) as never);

    await hooks.runner('init').run(undefined, undefined, fake.generator as never);

    expect(fake.calls[0]?.config).toMatchObject({
      source: 'app/ai/tools',
      importAlias: '#ai_tools',
    });
  });
});
