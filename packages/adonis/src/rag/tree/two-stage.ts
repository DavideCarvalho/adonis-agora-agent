import type { Passage, RetrieveOptions, Retriever } from '../../spi/retriever.js';
import { documentIdOf } from '../vector-store.js';
import type { TreeBudget } from './llm.js';
import type { DocumentNavigation, TreeNavigationRetriever } from './navigate.js';

export interface TwoStageRetrieverOptions {
  /** Passages pulled from the first stage. Default 20. */
  fetchTopK?: number;
  /**
   * Only the first this-many distinct documents of the first stage are considered for navigation.
   * Default 3 — past the top few, a document is more likely a large irrelevant tree (the costliest
   * failure measured: navigating FAR Part 52 because it ranked fourth) than the answer.
   */
  considerDocuments?: number;
  /** Of those, navigate at most this many (the ones that have a tree). Default 2. */
  navigateDocuments?: number;
  /** Per-document navigation budget (overrides the navigator's). */
  budget?: TreeBudget;
  /** Keep the first stage's chunks of a navigated document after its tree passages. Default `false`. */
  keepFirstStageChunks?: boolean;
  /**
   * The document a first-stage passage belongs to. Default: `metadata.documentId` when it is a
   * string, else the chunk id without its `#<n>` suffix (the id scheme `chunkDocuments` produces).
   */
  documentIdOf?: (passage: Passage) => string;
  /** Called with each navigation's audit trail (log it, trace it, show it). */
  onNavigation?: (navigation: DocumentNavigation) => void;
}

function defaultDocumentIdOf(passage: Passage): string {
  const fromMetadata = passage.metadata?.documentId;
  return typeof fromMetadata === 'string' ? fromMetadata : documentIdOf(passage.id);
}

/**
 * Hybrid first stage, tree navigation second — the design the benchmark recommends: keep fast
 * chunk search (hybrid/lexical/dense, 0.3 s, no LLM) for picking **documents**, and navigate the
 * table of contents only inside the top **long** documents, where chunk ranking is what fails.
 *
 * 1. The first stage retrieves `fetchTopK` passages.
 * 2. Among its first `considerDocuments` distinct documents, those with a tree in the navigator's
 *    store (build trees only for long documents, see `indexDocumentTree`'s `minUnits`) are long;
 *    the first `navigateDocuments` of them are navigated, in parallel, each on its own budget.
 * 3. The output keeps the first stage's order: a navigated document's section passages take the
 *    place of its chunks (at its best chunk's rank); short documents keep their chunks. A navigation
 *    that fails or finds nothing leaves that document's chunks in place — never worse than stage one.
 *
 * `filter` is passed to both stages, so the access boundary holds on either path.
 */
export class TwoStageRetriever implements Retriever {
  constructor(
    private readonly firstStage: Retriever,
    private readonly navigator: TreeNavigationRetriever,
    private readonly options: TwoStageRetrieverOptions = {},
  ) {}

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    return (await this.search(query, options)).passages;
  }

  /** {@link retrieve} with the navigations that were run. */
  async search(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<{ passages: Passage[]; navigations: DocumentNavigation[] }> {
    const topK = options.topK ?? 5;
    const docOf = this.options.documentIdOf ?? defaultDocumentIdOf;
    const first = await this.firstStage.retrieve(query, {
      topK: Math.max(topK, this.options.fetchTopK ?? 20),
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
    });
    const ranked: string[] = [];
    for (const passage of first) {
      const id = docOf(passage);
      if (!ranked.includes(id)) {
        ranked.push(id);
      }
    }
    const considered = ranked.slice(0, Math.max(1, this.options.considerDocuments ?? 3));
    const withTrees = new Set(
      (
        await this.navigator.store.list({
          documentIds: considered,
          ...(options.filter !== undefined ? { filter: options.filter } : {}),
        })
      ).map((header) => header.documentId),
    );
    const toNavigate = considered
      .filter((id) => withTrees.has(id))
      .slice(0, Math.max(0, this.options.navigateDocuments ?? 2));

    const navigated = new Map<string, Passage[]>();
    let navigations: DocumentNavigation[] = [];
    if (toNavigate.length > 0) {
      const result = await this.navigator.navigate(query, toNavigate, {
        ...(options.filter !== undefined ? { filter: options.filter } : {}),
        ...(this.options.budget !== undefined ? { budget: this.options.budget } : {}),
      });
      navigations = result.documents;
      for (const passage of result.passages) {
        const id = String(passage.metadata?.documentId ?? '');
        navigated.set(id, [...(navigated.get(id) ?? []), passage]);
      }
      for (const navigation of navigations) {
        this.options.onNavigation?.(navigation);
      }
    }

    const merged: Passage[] = [];
    const emitted = new Set<string>();
    for (const passage of first) {
      const id = docOf(passage);
      const replacement = navigated.get(id);
      if (replacement === undefined || replacement.length === 0) {
        merged.push(passage);
        continue;
      }
      if (!emitted.has(id)) {
        emitted.add(id);
        merged.push(...replacement);
      }
      if (this.options.keepFirstStageChunks) {
        merged.push(passage);
      }
    }
    return { passages: merged.slice(0, topK), navigations };
  }
}
