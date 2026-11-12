import type { DevTool, DevToolsFeature, DevToolsHub, DevToolsLib } from './contract.js';
import { schemaProblem } from './schema.js';

const LIB_ID = /^[a-z][a-z0-9]*$/;
const TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** A registered lib, with its tools already filtered by `exclude`. */
export interface RegisteredDevToolsLib extends DevToolsLib {
  /** How many tools it registered before `exclude` (for the boot log). */
  registered: number;
  /** `'endpoint'`: registered without `authorize` (no console), gated by `devTools.authorize`. */
  gate: 'own' | 'endpoint';
}

/** The optional features this hub supports (see {@link DevToolsHub.supports}). */
const FEATURES: ReadonlySet<string> = new Set(['endpoint-authorize']);

/**
 * The hub `mcp_provider` binds at `'agora.devTools'`. It only stores descriptors: tools resolve their
 * services when called. `exclude` (lib ids or full tool names) is applied here, so an excluded tool
 * never reaches any registry.
 */
export class DevToolsHubImpl implements DevToolsHub {
  readonly version = 1 as const;
  readonly #libs = new Map<string, RegisteredDevToolsLib>();
  readonly #owners = new Map<string, string>();
  readonly #exclude: Set<string>;

  constructor(options: { exclude?: readonly string[] } = {}) {
    this.#exclude = new Set(options.exclude ?? []);
  }

  register(lib: DevToolsLib): void {
    const where = `[@adonis-agora/agent] dev tools`;
    if (typeof lib !== 'object' || lib === null)
      throw new Error(`${where}: register() needs a lib`);
    if (typeof lib.lib !== 'string' || !LIB_ID.test(lib.lib)) {
      throw new Error(`${where}: lib id ${JSON.stringify(lib.lib)} must match /^[a-z][a-z0-9]*$/`);
    }
    if (this.#libs.has(lib.lib)) {
      throw new Error(`${where}: the lib "${lib.lib}" is already registered`);
    }
    if (lib.authorize !== undefined && typeof lib.authorize !== 'function') {
      throw new Error(`${where}: the lib "${lib.lib}" has an authorize that is not a function`);
    }
    if (!Array.isArray(lib.tools)) throw new Error(`${where}: "${lib.lib}".tools must be an array`);
    const names = new Set<string>();
    for (const tool of lib.tools) {
      const problem = toolProblem(lib.lib, tool);
      if (problem !== null) throw new Error(`${where}: ${problem}`);
      if (names.has(tool.name)) {
        throw new Error(`${where}: the tool "${tool.name}" is registered twice`);
      }
      names.add(tool.name);
    }
    const excluded = this.#exclude.has(lib.lib);
    const tools = excluded ? [] : lib.tools.filter((tool) => !this.#exclude.has(tool.name));
    this.#libs.set(lib.lib, {
      lib: lib.lib,
      title: typeof lib.title === 'string' && lib.title !== '' ? lib.title : lib.lib,
      ...(lib.authorize !== undefined ? { authorize: lib.authorize } : {}),
      tools,
      registered: lib.tools.length,
      gate: lib.authorize !== undefined ? 'own' : 'endpoint',
    });
    for (const tool of tools) this.#owners.set(tool.name, lib.lib);
  }

  supports(feature: DevToolsFeature): boolean {
    return FEATURES.has(feature);
  }

  /** Every registered lib, in registration order. A lib excluded whole is kept, with no tools. */
  libs(): RegisteredDevToolsLib[] {
    return [...this.#libs.values()];
  }

  /** The libs that still have tools after `exclude`. */
  servedLibs(): RegisteredDevToolsLib[] {
    return this.libs().filter((lib) => lib.tools.length > 0);
  }

  /** Served libs registered without `authorize` (no console): gated by `devTools.authorize`. */
  endpointGatedLibs(): RegisteredDevToolsLib[] {
    return this.servedLibs().filter((lib) => lib.gate === 'endpoint');
  }

  /** The lib that owns `toolName`, or `undefined` for a name nobody registered (or one excluded). */
  libOf(toolName: string): RegisteredDevToolsLib | undefined {
    const owner = this.#owners.get(toolName);
    return owner === undefined ? undefined : this.#libs.get(owner);
  }
}

function toolProblem(lib: string, tool: DevTool): string | null {
  if (typeof tool !== 'object' || tool === null)
    return `"${lib}" registered a tool that is not an object`;
  const name = tool.name;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    return `tool name ${JSON.stringify(name)} must be snake_case <lib>_<verb>_<noun>`;
  }
  if (!name.startsWith(`${lib}_`)) {
    return `tool "${name}" must be prefixed by its lib ("${lib}_")`;
  }
  if (tool.kind !== 'read' && tool.kind !== 'action') {
    return `tool "${name}" has kind ${JSON.stringify(tool.kind)}: use "read" or "action"`;
  }
  if (typeof tool.description !== 'string' || tool.description === '') {
    return `tool "${name}" needs a description`;
  }
  if (typeof tool.run !== 'function') return `tool "${name}" has no run()`;
  const problem = schemaProblem(tool.input);
  if (problem !== null) return `tool "${name}": ${problem}`;
  return null;
}

/**
 * The one boot warning when libs without a console registered tools and `devTools.authorize` is not
 * set. `undefined` when there is nothing to say.
 */
export function endpointAuthorizeWarning(
  libs: readonly string[],
  authorize: unknown,
): string | undefined {
  if (libs.length === 0 || authorize !== undefined) return undefined;
  return `[@adonis-agora/agent] dev tools for ${libs.join(', ')} have no authorize: open outside production, denied in production. Set devTools.authorize in config/mcp.ts.`;
}
