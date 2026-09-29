import { type BuildDocumentTreeOptions, buildDocumentTree, toUnits } from './build.js';
import type { DocumentTreeStore } from './store.js';
import type { DocumentTree, DocumentTreeInput } from './types.js';

export interface IndexDocumentTreeOptions extends Omit<BuildDocumentTreeOptions, 'previous'> {
  store: DocumentTreeStore;
  /**
   * Only documents with at least this many units (pages, or sections) get a tree; a shorter one is
   * skipped and any tree it had is removed. Default 20 — tree navigation pays off on long
   * structured documents and costs latency and LLM spend for nothing on short notes.
   */
  minUnits?: number;
  /** …or at least this many characters, whichever is met first. Default 60 000 (~15k tokens). */
  minChars?: number;
}

export type IndexDocumentTreeResult =
  | { status: 'skipped'; reason: string }
  | { status: 'unchanged'; tree: DocumentTree }
  | { status: 'built'; tree: DocumentTree };

/**
 * Build (or rebuild) a document's tree and store it — the call to make at upload/ingestion time,
 * next to chunking and embedding. Short documents are skipped (see `minUnits`/`minChars`); an
 * unchanged document costs one store read and no LLM call; a changed one reuses the summaries of
 * its unchanged sections. Never throws for a document the LLM cannot structure: the tree falls back
 * to page groups and `tree.stats.fallbackReason` says why. Store errors do propagate.
 */
export async function indexDocumentTree(
  input: DocumentTreeInput,
  options: IndexDocumentTreeOptions,
): Promise<IndexDocumentTreeResult> {
  const { store, minUnits = 20, minChars = 60_000, ...build } = options;
  const { units } = toUnits(input);
  const chars = units.reduce((total, unit) => total + unit.text.length, 0);
  if (units.length < minUnits && chars < minChars) {
    await store.remove(options.documentId);
    return {
      status: 'skipped',
      reason: `${units.length} units / ${chars} chars is below the threshold (${minUnits} units or ${minChars} chars)`,
    };
  }
  const previous = await store.get(options.documentId);
  const built = await buildDocumentTree(input, {
    ...build,
    ...(previous !== undefined ? { previous } : {}),
  });
  if (built.unchanged) {
    const metadataMoved =
      JSON.stringify(previous?.metadata ?? null) !== JSON.stringify(built.tree.metadata ?? null) ||
      previous?.source !== built.tree.source;
    if (metadataMoved) {
      await store.put(built.tree, built.units);
    }
    return { status: 'unchanged', tree: built.tree };
  }
  await store.put(built.tree, built.units);
  return { status: 'built', tree: built.tree };
}
