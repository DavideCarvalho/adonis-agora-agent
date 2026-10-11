/**
 * `@adonis-agora/agent/vite` — `genuiSandboxKit()`, the Vite plugin that puts the app's design
 * system (its styles, its components, its providers) inside the sandbox, whatever the stack:
 *
 * ```ts
 * // vite.config.ts
 * import { genuiSandboxKit } from '@adonis-agora/agent/vite'
 * export default defineConfig({
 *   plugins: [react(), adonisjs({ … }), genuiSandboxKit({ styles: 'resources/css/app.css', components: 'inertia/components/ui' })],
 * })
 * ```
 *
 * Then `genui({ sandbox: { kit: true } })` in `config/agent.ts` finds what it built through Vite
 * (the dev server in dev, the manifest in production).
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
 * The sandbox kit plugin: `styles` (the app's style entries — default, the stylesheets among its
 * Vite entrypoints), `components` (modules or globs exporting React components — default, the
 * first `components/ui` folder), `wrapper` (a module whose default export wraps the model's App).
 * See {@link GenuiSandboxKitOptions}.
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
