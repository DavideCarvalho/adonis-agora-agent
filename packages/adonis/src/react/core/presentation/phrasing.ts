import type { ToolCatalogEntry, ToolPresentation } from '../../../index.js';
import { fillPresentationTemplate, readPresentationPath } from '../../../tool-presentation.js';

/** Tool name → how the server said it is spoken about. */
export type ToolCatalog = Record<string, ToolPresentation>;

/** Index `GET <base>/tools` by tool name, keeping only the tools that declared a presentation. */
export function toolCatalogFrom(entries: readonly ToolCatalogEntry[]): ToolCatalog {
  const catalog: ToolCatalog = {};
  for (const entry of entries) {
    if (entry.presentation !== undefined) catalog[entry.name] = entry.presentation;
  }
  return catalog;
}

/** Dotted-path read. `undefined` rather than a throw, so a template can outlive a field. */
export const readPath: (value: unknown, path: string) => unknown = readPresentationPath;

/**
 * Fill `{dotted.path}` placeholders from `context`. A placeholder with nothing behind it collapses
 * along with the whitespace in front of it, so "Reading {key}" degrades to "Reading" rather than
 * printing braces at a person; a filled one keeps the whitespace the author wrote ("({n} files)").
 * The same filler the server resolves approval prompts with.
 */
export const fillTemplate: (template: string, context: unknown) => string =
  fillPresentationTemplate;

/**
 * The sentence for one call: the presentation's `running` or `done` template over the call's input.
 *
 * Nothing here reads the tool's name. A tool the catalog does not describe — added since the catalog
 * loaded, or declared without a presentation — is narrated generically (`fallback`), because the only
 * other thing available to say is its identifier.
 */
export function phraseFor(
  presentation: ToolPresentation | undefined,
  input: unknown,
  isSettled: boolean,
  fallback: { running: string; done: string } = { running: 'Working', done: 'Done' },
): string {
  if (presentation === undefined) return isSettled ? fallback.done : fallback.running;
  const filled = fillTemplate(isSettled ? presentation.done : presentation.running, input);
  // A sentence made only of slots, called before those fields have streamed, leaves nothing. The
  // label is still the server's word for this tool, and a blank line reads as nothing happening.
  return filled === '' ? presentation.label : filled;
}
