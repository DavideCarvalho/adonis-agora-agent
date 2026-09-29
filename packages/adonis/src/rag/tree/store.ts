import { matchesFilter } from '../filter.js';
import { filterDeniesAll } from '../vector-store.js';
import type { DocumentTree, TreeUnit } from './types.js';

/** A stored tree without its nodes — what listing and document selection need. */
export interface DocumentTreeHeader {
  documentId: string;
  title?: string;
  description?: string;
  structure: DocumentTree['structure'];
  fingerprint: string;
  unitCount: number;
  metadata?: Record<string, unknown>;
  source?: string;
  builtAt: string;
}

/**
 * Where navigation trees live: one tree per document plus the units (pages/sections) its node
 * ranges point at, so navigation can read a node's text without going back to the source file.
 *
 * `filter` has **exactly** the vector stores' semantics (see `VectorStore`): every key must match
 * the tree's `metadata`, an array value is match-any, and an empty array denies. It is an access
 * boundary — a navigator given a tenant filter must not read another tenant's tree — so every read
 * that takes one applies it. `readUnits` takes none: call it only for a tree a filtered `get` just
 * returned (which is what the navigator does).
 */
export interface DocumentTreeStore {
  /** Store (replace) a document's tree and units. */
  put(tree: DocumentTree, units: TreeUnit[]): Promise<void>;
  /** A document's tree, when it exists **and** passes `filter`. */
  get(documentId: string, filter?: Record<string, unknown>): Promise<DocumentTree | undefined>;
  /** The trees of those of `documentIds` that exist and pass `filter` (any order). */
  getMany(
    documentIds: readonly string[],
    filter?: Record<string, unknown>,
  ): Promise<DocumentTree[]>;
  /** Headers (no nodes) of every tree passing `filter`, or of the listed `documentIds` only. */
  list(options?: {
    filter?: Record<string, unknown>;
    documentIds?: readonly string[];
    limit?: number;
  }): Promise<DocumentTreeHeader[]>;
  /** Units `start..end` (inclusive) of a document, in order. */
  readUnits(documentId: string, start: number, end: number): Promise<TreeUnit[]>;
  /** Drop a document's tree and units. Unknown ids are a no-op. */
  remove(documentId: string): Promise<void>;
}

export function headerOf(tree: DocumentTree): DocumentTreeHeader {
  return {
    documentId: tree.documentId,
    ...(tree.title !== undefined ? { title: tree.title } : {}),
    ...(tree.description !== undefined ? { description: tree.description } : {}),
    structure: tree.structure,
    fingerprint: tree.fingerprint,
    unitCount: tree.unitCount,
    ...(tree.metadata !== undefined ? { metadata: tree.metadata } : {}),
    ...(tree.source !== undefined ? { source: tree.source } : {}),
    builtAt: tree.builtAt,
  };
}

function passes(tree: DocumentTree, filter: Record<string, unknown> | undefined): boolean {
  if (filter === undefined || Object.keys(filter).length === 0) {
    return true;
  }
  if (filterDeniesAll(filter)) {
    return false;
  }
  return matchesFilter(tree.metadata, filter);
}

/** An in-process {@link DocumentTreeStore} — tests, and single-process apps with small corpora. */
export class MemoryDocumentTreeStore implements DocumentTreeStore {
  private readonly trees = new Map<string, { tree: DocumentTree; units: TreeUnit[] }>();

  async put(tree: DocumentTree, units: TreeUnit[]): Promise<void> {
    this.trees.set(tree.documentId, {
      tree: structuredClone(tree),
      units: units.map((unit) => ({ ...unit })),
    });
  }

  async get(
    documentId: string,
    filter?: Record<string, unknown>,
  ): Promise<DocumentTree | undefined> {
    const entry = this.trees.get(documentId);
    return entry !== undefined && passes(entry.tree, filter)
      ? structuredClone(entry.tree)
      : undefined;
  }

  async getMany(
    documentIds: readonly string[],
    filter?: Record<string, unknown>,
  ): Promise<DocumentTree[]> {
    const trees: DocumentTree[] = [];
    for (const id of new Set(documentIds)) {
      const tree = await this.get(id, filter);
      if (tree !== undefined) {
        trees.push(tree);
      }
    }
    return trees;
  }

  async list(
    options: {
      filter?: Record<string, unknown>;
      documentIds?: readonly string[];
      limit?: number;
    } = {},
  ): Promise<DocumentTreeHeader[]> {
    const ids = options.documentIds !== undefined ? new Set(options.documentIds) : undefined;
    const headers = [...this.trees.values()]
      .filter(
        ({ tree }) =>
          (ids === undefined || ids.has(tree.documentId)) && passes(tree, options.filter),
      )
      .map(({ tree }) => headerOf(tree))
      .sort((a, b) => a.documentId.localeCompare(b.documentId));
    return options.limit !== undefined ? headers.slice(0, options.limit) : headers;
  }

  async readUnits(documentId: string, start: number, end: number): Promise<TreeUnit[]> {
    const units = this.trees.get(documentId)?.units ?? [];
    return units.slice(Math.max(0, start), Math.max(0, end + 1)).map((unit) => ({ ...unit }));
  }

  async remove(documentId: string): Promise<void> {
    this.trees.delete(documentId);
  }
}
