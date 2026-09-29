/**
 * The data model of tree navigation retrieval: a hierarchical table of contents per long document
 * (PageIndex-style: sections with page ranges and summaries), built once at ingestion and read by an
 * LLM at query time to walk to the relevant sections instead of ranking hundreds of look-alike chunks.
 */

/**
 * One addressable piece of a document's text, in reading order — a PDF page, or a section of a
 * markdown/HTML document. Tree nodes point at ranges of units, and navigation reads the text of the
 * units a chosen node spans. `index` is the unit's zero-based position; `page` its 1-based page
 * number when the document has pages.
 */
export interface TreeUnit {
  index: number;
  text: string;
  /** 1-based page number (PDF). Defaults to `index + 1` for page input; absent for section input. */
  page?: number;
}

/**
 * A heading the document declares about itself: a PDF outline (bookmark) entry, a markdown header,
 * a section boundary your extractor already knows. `unit` is the zero-based unit it starts in;
 * `page` (1-based) is accepted instead for page input. `level` 1 is top level.
 */
export interface TreeHeading {
  title: string;
  level: number;
  unit?: number;
  page?: number;
}

/** A section as produced by an extractor that already splits on headings. */
export interface TreeSection {
  text: string;
  title?: string;
  /** Heading depth, 1 = top level. Sections without a level are treated as level 1. */
  level?: number;
  /** 1-based page the section starts on, when known. */
  page?: number;
}

/**
 * What {@link import('./build.js').buildDocumentTree} builds from. Give exactly one of `pages`
 * (one string per page, in order) or `sections` (heading-split text). `outline`, when present, is the
 * cheapest and most reliable structure there is (a PDF's bookmarks) and is used before any heuristic.
 */
export interface DocumentTreeInput {
  pages?: string[];
  sections?: TreeSection[];
  /** Headings the document declares (PDF outline/bookmarks), in reading order. */
  outline?: TreeHeading[];
  /** Document title, shown to the navigating LLM and used as the citation source. */
  title?: string;
}

/** How the structure of a tree was obtained, cheapest first. */
export type TreeStructureSource =
  /** From {@link DocumentTreeInput.outline}. */
  | 'outline'
  /** From section titles/levels or headings detected in the text — no LLM. */
  | 'headings'
  /** An LLM proposed the sections (the document had no usable outline). */
  | 'llm'
  /** Fallback: fixed-size page groups. Always succeeds; used when everything above failed or was skipped. */
  | 'flat';

/** Where a node's summary came from. */
export type TreeSummarySource = 'llm' | 'text' | 'reused';

export interface DocumentTreeNode {
  /** Stable within the tree: `0001`, `0002`… in depth-first order (PageIndex's scheme). */
  id: string;
  title: string;
  /** What the section covers — what the navigating LLM reads to decide whether to go in. */
  summary?: string;
  summarySource?: TreeSummarySource;
  /** First and last unit (inclusive, zero-based) the node spans, children included. */
  unitStart: number;
  unitEnd: number;
  /** First and last page (1-based, inclusive) when the document has pages. */
  pageStart?: number;
  pageEnd?: number;
  /**
   * Titles of descendants removed to respect `maxDepth` — kept because they are routing information:
   * the pages are still reachable by reading this node, the titles tell the navigator they are here.
   */
  keyItems?: string[];
  /** Hash of the node's title and the text it spans; an incremental rebuild reuses a summary when it matches. */
  contentHash: string;
  children: DocumentTreeNode[];
}

/** What a build cost and how it ended — persisted with the tree, so an operator can see it. */
export interface TreeBuildStats {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Set when the structure step fell back (to `flat`) or summaries were cut short, and why. */
  fallbackReason?: string;
  /** True when the per-document budget or timeout ran out at some point during the build. */
  budgetExhausted: boolean;
  /** Summaries carried over unchanged from the previous tree (incremental rebuild). */
  reusedSummaries: number;
}

export interface DocumentTree {
  documentId: string;
  /** Format version of this structure. */
  version: 1;
  title?: string;
  /** One-paragraph description of the whole document (LLM, when budget allows). */
  description?: string;
  structure: TreeStructureSource;
  /**
   * Hash of the input text and every build option that shapes the tree. Equal fingerprint ⇒ the
   * build would produce the same tree, so it is skipped (see `previous` in the build options).
   */
  fingerprint: string;
  unitCount: number;
  /** Top-level nodes. */
  nodes: DocumentTreeNode[];
  stats: TreeBuildStats;
  /**
   * Document metadata used for access filtering, exactly like chunk metadata in a vector store
   * (tenant, audience, collection…). Stores apply `filter` to it with the vector stores' semantics.
   */
  metadata?: Record<string, unknown>;
  /** Citation-facing origin (title, URL), copied onto returned passages. */
  source?: string;
  /** ISO timestamp of the build. */
  builtAt: string;
}

/** Walk a tree depth-first (pre-order). */
export function* walkTree(
  nodes: readonly DocumentTreeNode[],
  path: readonly DocumentTreeNode[] = [],
): Generator<{ node: DocumentTreeNode; path: readonly DocumentTreeNode[] }> {
  for (const node of nodes) {
    yield { node, path };
    yield* walkTree(node.children, [...path, node]);
  }
}

/** Index a tree's nodes by id, each with its ancestors. */
export function indexTree(
  tree: Pick<DocumentTree, 'nodes'>,
): Map<string, { node: DocumentTreeNode; path: readonly DocumentTreeNode[] }> {
  const index = new Map<string, { node: DocumentTreeNode; path: readonly DocumentTreeNode[] }>();
  for (const entry of walkTree(tree.nodes)) {
    index.set(entry.node.id, entry);
  }
  return index;
}
