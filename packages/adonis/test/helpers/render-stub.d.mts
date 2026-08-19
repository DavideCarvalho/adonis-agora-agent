/**
 * Types for the shared real-engine stub renderer.
 *
 * A declaration file rather than a `@ts-expect-error` at each import: the suppression only covers the
 * following line, so it broke the moment the formatter wrapped an import across lines — and while it
 * held, it was hiding every other error on that import too.
 */

/** One rendered stub: the file contents and the path `configure` would write it to. */
export interface RenderedStub {
  contents: string;
  destination: string;
}

/** Absolute path to the SOURCE stubs directory. */
export const stubsRoot: string;

/** Absolute path to the BUILT stubs directory — what `copy:stubs` produces and consumers install. */
export const distStubsRoot: string;

/** The stubs `configure.ts` publishes, in the order it publishes them. */
export const PUBLISHED_STUBS: readonly string[];

/** Render one stub through the real configure engine. Throws whatever the engine throws. */
export function renderStub(
  stubPath: string,
  stubState?: Record<string, unknown>,
  source?: string,
): Promise<RenderedStub>;

/** Render every published stub in one booted app. */
export function renderAllStubs(
  stubState?: Record<string, unknown>,
  source?: string,
): Promise<Map<string, RenderedStub>>;
