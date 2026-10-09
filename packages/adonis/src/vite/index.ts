/**
 * `@adonis-agora/agent/vite` — `genuiSandboxKit()`, the Vite plugin that puts the app's design
 * system (its components, its theme, Tailwind) inside the sandbox:
 *
 * ```ts
 * // vite.config.ts
 * import { genuiSandboxKit } from '@adonis-agora/agent/vite'
 * export default defineConfig({ plugins: [react(), adonisjs({ … }), genuiSandboxKit({ include: 'inertia/components/ui/*.tsx' })] })
 * ```
 *
 * Then `genui({ sandbox: { kit: true, tailwind: true } })` in `config/agent.ts` finds the bundle and
 * the docs through Vite (the dev server in dev, the manifest in production).
 */
import {
  createGenuiSandboxKitPlugin,
  type GenuiSandboxKitApi,
  type GenuiSandboxKitOptions,
  type GenuiSandboxKitPlugin,
  SANDBOX_KIT_DEV_PREFIX,
  SANDBOX_KIT_MANIFEST_KEYS,
  SANDBOX_KIT_UPDATE_EVENT,
} from '../genui/kit/plugin.js';

/** Where the dev descriptor is written in an Adonis app (`.adonisjs` is ignored by git already). */
export const ADONIS_SANDBOX_KIT_DESCRIPTOR = '.adonisjs/agent/genui_sandbox_kit.json';

/**
 * The sandbox kit plugin. `entry` (a module exporting the kit) or `include` (a glob of component
 * files); neither → the first `components/ui` folder (`inertia/components/ui`…). See
 * {@link GenuiSandboxKitOptions}.
 */
export function genuiSandboxKit(options: GenuiSandboxKitOptions = {}): GenuiSandboxKitPlugin {
  return createGenuiSandboxKitPlugin(options, {
    descriptor: ADONIS_SANDBOX_KIT_DESCRIPTOR,
    rendererImport: /@adonis-agora\/agent\/react/,
  });
}

export {
  type GenuiSandboxKitApi,
  type GenuiSandboxKitOptions,
  type GenuiSandboxKitPlugin,
  SANDBOX_KIT_DEV_PREFIX,
  SANDBOX_KIT_MANIFEST_KEYS,
  SANDBOX_KIT_UPDATE_EVENT,
};
