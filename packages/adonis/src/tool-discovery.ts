import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';
import {
  type AiToolMeta,
  type FunctionalTool,
  isBrandedFunctionalTool,
  readAiToolMeta,
  type ToolClass,
} from './ai-tool-ref.js';
import type { ToolHandler } from './spi/tool.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ToolSpec } from './types.js';

/** A tool registered at boot, echoed back so the provider can log what it wired. */
export interface RegisteredTool {
  name: string;
  source: 'class' | 'functional';
}

/**
 * Register one module export into the registry if it is an `@AiTool` class or a `defineTool(...)`
 * functional tool; ignore anything else. A name already present is skipped (first wins). Returns the
 * registered descriptor, or `null` when the export was not a tool / duplicated a registered name.
 */
export function registerToolExport(
  registry: ToolRegistry,
  exported: unknown,
  defaultRoles: string[],
  app?: ApplicationService,
): RegisteredTool | null {
  // A functional tool: a branded { spec, handler } from `defineTool`.
  if (isBrandedFunctionalTool(exported)) {
    return registerFunctionalTool(registry, exported, defaultRoles);
  }
  // An `@AiTool` / `static tool` class: read its stamped metadata and register `execute`.
  const meta = readAiToolMeta(exported);
  if (meta === undefined || typeof exported !== 'function') {
    return null;
  }
  const cls = exported as ToolClass;
  // Validate it is a tool WITHOUT constructing it — `execute` lives on the prototype. Keeps the
  // fail-fast reject of a non-tool export while letting the instance be resolved lazily (app path).
  const proto = cls.prototype as { execute?: unknown } | undefined;
  if (typeof proto?.execute !== 'function') {
    return null;
  }
  if (registry.has(meta.name)) {
    return null;
  }

  if (app === undefined) {
    // No container: instantiate now (no DI); skip if construction throws — pre-DI behavior.
    const instance = instantiate(cls);
    if (instance === null) {
      return null;
    }
    registry.register(specFromMeta(meta, defaultRoles), {
      execute: (input, ctx) => instance.execute(input, ctx),
    });
  } else {
    // Container DI: resolve the tool (and its `@inject`'d deps) through the IoC container — the
    // idiomatic Adonis way. LAZY on first use and then cached: discovery runs in the provider's
    // `boot()`, before the app is fully booted, so an eager `container.make()` could fail resolving
    // a peer service — the same reason the Lucid store factory resolves lazily.
    let instancePromise: Promise<ToolHandler> | undefined;
    registry.register(specFromMeta(meta, defaultRoles), {
      execute: (input, ctx) => {
        instancePromise ??= app.container.make(cls) as unknown as Promise<ToolHandler>;
        return instancePromise.then((instance) => instance.execute(input, ctx));
      },
    });
  }
  return { name: meta.name, source: 'class' };
}

/** Register a `defineTool` functional tool, applying `defaultRoles` when it declares none. */
export function registerFunctionalTool(
  registry: ToolRegistry,
  tool: FunctionalTool,
  defaultRoles: string[],
): RegisteredTool | null {
  if (registry.has(tool.spec.name)) {
    return null;
  }
  const spec: ToolSpec =
    tool.spec.roles === undefined ? { ...tool.spec, roles: defaultRoles } : tool.spec;
  registry.register(spec, tool.handler);
  return { name: tool.spec.name, source: 'functional' };
}

function specFromMeta(meta: AiToolMeta, defaultRoles: string[]): ToolSpec {
  return {
    name: meta.name,
    kind: meta.kind,
    description: meta.description,
    inputSchema: meta.input,
    roles: meta.roles ?? defaultRoles,
    ...(meta.ability !== undefined ? { ability: meta.ability } : {}),
  };
}

function instantiate(cls: ToolClass): ToolHandler | null {
  try {
    const Ctor = cls as unknown as new () => ToolHandler;
    return new Ctor();
  } catch {
    return null;
  }
}

/**
 * Pick the module extension to import from what the scanned directory ACTUALLY holds: `.ts` when it
 * has any non-declaration `.ts` file, else `.js`. At runtime an app runs from EITHER its source
 * (`app/agent_tools/*.ts`, dev under a TS loader) OR its build (`build/app/agent_tools/*.js`, TS
 * compiled away) — never both in the same directory — so choosing one gate still guarantees a built
 * `.js` and a dev `.ts` of the same module never double-register.
 *
 * This must be derived from the app's own files, NOT from `extname(import.meta.url)`: this module
 * ships COMPILED (always `.js`), so keying off its own extension would make a `.ts` dev app scan for
 * `.js` tools it doesn't have and register nothing.
 */
function moduleExtensionFor(entries: string[]): '.ts' | '.js' {
  const hasTsSource = entries.some((entry) => extname(entry) === '.ts' && !entry.endsWith('.d.ts'));
  return hasTsSource ? '.ts' : '.js';
}

/**
 * Scan `dir` RECURSIVELY for modules and register every exported `@AiTool` class / `defineTool`
 * tool into `registry` — the `app/agent_tools` convention. Only the environment-appropriate extension
 * is imported and each export is visited once (deduped), so a built `.js` and a dev `.ts` of the same
 * module never both register. Missing directory → no-op (the convention is opt-in). `defaultRoles`
 * fills a tool that declares no `roles` (ADMIN-only by default).
 */
export async function discoverTools(
  registry: ToolRegistry,
  dir: string,
  defaultRoles: string[],
  app?: ApplicationService,
): Promise<RegisteredTool[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const moduleExt = moduleExtensionFor(entries);
  const registered: RegisteredTool[] = [];
  const seen = new Set<unknown>();
  for (const entry of entries.sort()) {
    if (extname(entry) !== moduleExt || entry.endsWith(`.d${moduleExt}`)) {
      continue;
    }
    // Import each tool file in its own try/catch: a single file that throws at import time (e.g. a
    // top-level `@adonisjs/*/services/*` singleton whose `app` is undefined during boot) must NOT abort
    // the whole scan and silently leave the agent with ZERO tools. Log it loudly and skip — the other
    // tools still register, and the failure is visible instead of surfacing as the model "narrating"
    // tool calls it was never given.
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
    } catch (err) {
      const logger = (app as { logger?: { error?: (...args: unknown[]) => void } } | undefined)
        ?.logger;
      const message = `@adonis-agora/agent: failed to import tool file "${entry}" during discovery — skipping it (the agent will run WITHOUT this tool until the import is fixed).`;
      if (logger?.error) {
        logger.error({ err }, message);
      } else {
        console.error(message, err);
      }
      continue;
    }
    for (const exported of Object.values(mod)) {
      if (seen.has(exported)) {
        continue;
      }
      seen.add(exported);
      const result = registerToolExport(registry, exported, defaultRoles, app);
      if (result !== null) {
        registered.push(result);
      }
    }
  }
  return registered;
}

/**
 * The build-time barrel shape the Assembler `init` hook generates for `app/agent_tools`
 * (key → lazy module import), mirroring durable's steps/workflows barrels.
 */
export type ToolsBarrel = Record<string, () => Promise<Record<string, unknown>>>;

/**
 * Register every `@AiTool` / `defineTool` reachable from a generated {@link ToolsBarrel} — the
 * build-time equivalent of {@link discoverTools} with no runtime `readdir`. Each module is imported
 * once and each export registered once (deduped).
 */
export async function registerToolsFromBarrel(
  registry: ToolRegistry,
  barrel: ToolsBarrel,
  defaultRoles: string[],
  app?: ApplicationService,
): Promise<RegisteredTool[]> {
  const registered: RegisteredTool[] = [];
  const seen = new Set<unknown>();
  for (const load of Object.values(barrel)) {
    const mod = await load();
    for (const exported of Object.values(mod)) {
      if (seen.has(exported)) {
        continue;
      }
      seen.add(exported);
      const result = registerToolExport(registry, exported, defaultRoles, app);
      if (result !== null) {
        registered.push(result);
      }
    }
  }
  return registered;
}
