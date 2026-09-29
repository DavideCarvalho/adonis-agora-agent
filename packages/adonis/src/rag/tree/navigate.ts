import type { Passage, RetrieveOptions, Retriever } from '../../spi/retriever.js';
import { mapLimit } from './build.js';
import {
  BudgetedLlm,
  parseJsonReply,
  stringList,
  type TreeBudget,
  TreeBudgetExceededError,
  type TreeLlm,
  type TreeLlmCandidate,
} from './llm.js';
import type { DocumentTreeStore } from './store.js';
import type { DocumentTree, DocumentTreeNode } from './types.js';
import { indexTree, walkTree } from './types.js';

export interface TreeNavigationRetrieverOptions {
  store: DocumentTreeStore;
  llm: TreeLlm;
  /**
   * A tree whose outline (titles, pages, summaries) fits in this many characters is navigated in
   * **one** call that sees the whole outline — PageIndex's tree search, the variant measured in the
   * benchmark. Bigger trees are walked level by level (a beam). Default 40 000 (~10k tokens).
   */
  singlePassMaxChars?: number;
  /** Nodes the navigator may expand or read per beam step. Default 4. */
  beamWidth?: number;
  /** Beam levels, at most. Nodes still marked "expand" at the last level are read whole. Default 4. */
  maxSteps?: number;
  /** Nodes returned per document, at most. Default 5. */
  maxNodes?: number;
  /**
   * Hard per-document limits for one navigation. Defaults: 6 calls, 60k input tokens, 4k output
   * tokens, 60 s. Running out mid-walk returns what was chosen so far (the nodes last marked for
   * expansion are read whole) and records `stoppedBy: 'budget'`.
   */
  budget?: TreeBudget;
  /** Characters of text per returned node. Default 12 000. */
  maxPassageChars?: number;
  /** Units (pages/sections) read per returned node, at most. Default 25. */
  maxUnitsPerNode?: number;
  /** Characters across all passages of one navigation (every document). Default 48 000 (~12k tokens). */
  maxContextChars?: number;
  /**
   * {@link TreeNavigationRetriever.retrieve} with no first stage: documents navigated per query. When
   * more trees pass the filter, the LLM picks this many from their titles and descriptions
   * (PageIndex's document selection). Default 3.
   */
  maxDocuments?: number;
  /** Trees shown to document selection, at most. Default 200. */
  maxSelectionCandidates?: number;
  /** Documents navigated in parallel. Default 3. */
  concurrency?: number;
}

/** One step of a navigation, for the audit trail. */
export interface NavigationStep {
  step: number;
  /** Node ids shown to the LLM this step. */
  shown: string[];
  /** Node ids it chose to open further. */
  expanded: string[];
  /** Node ids it chose to read. */
  read: string[];
  /** The LLM's stated reasoning, verbatim (capped). */
  reasoning?: string;
}

/** A node navigation chose, with the path that led to it. */
export interface NavigatedNode {
  nodeId: string;
  title: string;
  /** Ancestors from the top level down, then the node itself. */
  path: { id: string; title: string }[];
  pageStart?: number;
  pageEnd?: number;
  unitStart: number;
  unitEnd: number;
}

/** The auditable record of navigating one document. */
export interface DocumentNavigation {
  documentId: string;
  title?: string;
  mode: 'single-pass' | 'beam';
  steps: NavigationStep[];
  nodes: NavigatedNode[];
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Why the walk stopped early, when it did. */
  stoppedBy?: 'budget' | 'timeout' | 'maxSteps' | 'error' | 'not-found';
  error?: string;
}

export interface NavigationResult {
  passages: Passage[];
  documents: DocumentNavigation[];
  /** Set when {@link TreeNavigationRetriever.retrieve} had the LLM pick the documents. */
  selection?: { candidates: number; selected: string[]; reasoning?: string; error?: string };
}

export interface NavigateOptions {
  /** Access filter applied to every tree read (vector-store semantics). */
  filter?: Record<string, unknown>;
  /** Overrides the retriever's per-document budget. */
  budget?: TreeBudget;
  signal?: AbortSignal;
}

const NAVIGATE_SYSTEM =
  'You navigate the table of contents of a document to find where a question is answered. You answer with JSON only.';

const DEFAULT_BUDGET = {
  maxCalls: 6,
  maxInputTokens: 60_000,
  maxOutputTokens: 4_000,
  timeoutMs: 60_000,
} as const;

function pages(node: Pick<DocumentTreeNode, 'pageStart' | 'pageEnd'>): string | undefined {
  if (node.pageStart === undefined) {
    return undefined;
  }
  return node.pageEnd === undefined || node.pageEnd === node.pageStart
    ? `p. ${node.pageStart}`
    : `pp. ${node.pageStart}-${node.pageEnd}`;
}

function candidate(node: DocumentTreeNode, summaryChars: number, depth?: number): TreeLlmCandidate {
  const shownPages = pages(node);
  let summary = node.summary;
  if (summary !== undefined && summary.length > summaryChars) {
    summary = `${summary.slice(0, Math.max(0, summaryChars - 1))}…`;
  }
  if (node.keyItems !== undefined && node.keyItems.length > 0 && summaryChars > 0) {
    summary = `${summary ?? ''}${summary ? ' ' : ''}Includes: ${node.keyItems.slice(0, 12).join('; ')}`;
  }
  return {
    id: node.id,
    title: node.title,
    ...(summary && summaryChars > 0 ? { summary } : {}),
    ...(shownPages !== undefined ? { pages: shownPages } : {}),
    ...(depth !== undefined ? { depth } : { hasChildren: node.children.length > 0 }),
  };
}

function render(candidates: TreeLlmCandidate[]): string {
  return candidates
    .map((entry) => {
      const indent = '  '.repeat(entry.depth ?? 0);
      const meta = [entry.pages, entry.hasChildren ? 'has subsections' : undefined]
        .filter(Boolean)
        .join(', ');
      return `${indent}[${entry.id}] ${entry.title}${meta ? ` (${meta})` : ''}${entry.summary ? ` — ${entry.summary}` : ''}`;
    })
    .join('\n');
}

/** Candidates rendered within `maxChars`: full summaries, then shorter, then titles only. */
function fitCandidates(
  nodes: { node: DocumentTreeNode; depth?: number }[],
  maxChars: number,
): { candidates: TreeLlmCandidate[]; text: string } {
  let last: { candidates: TreeLlmCandidate[]; text: string } | undefined;
  for (const summaryChars of [400, 160, 0]) {
    const candidates = nodes.map(({ node, depth }) => candidate(node, summaryChars, depth));
    const text = render(candidates);
    last = { candidates, text };
    if (text.length <= maxChars) {
      break;
    }
  }
  return last as { candidates: TreeLlmCandidate[]; text: string };
}

/**
 * Tree navigation retrieval ("vectorless", reasoning-based — PageIndex's method): an LLM reads a
 * document's table of contents (titles, page ranges, summaries — no body text) and picks the
 * sections that answer the question; their text comes back as passages, with the path taken and the
 * model's reasoning recorded so the choice is auditable.
 *
 * A small tree is navigated in one call over the whole outline. A large one is walked level by
 * level: the model sees one level of candidates, opens (`expand`) the promising ones and takes
 * (`read`) the ones that already answer, until it reaches leaves, runs out of `maxSteps`, or runs
 * out of its hard per-document {@link TreeBudget} — in which case it returns what it had.
 *
 * It pays off on **long structured documents** (regulations, contracts, filings, manuals) where
 * chunk ranking struggles among hundreds of look-alike passages; on short notes it costs seconds and
 * LLM spend for nothing. Compose it behind a first stage with {@link TwoStageRetriever}, or give it
 * to the agent as a tool with {@link createNavigateDocumentTool}.
 *
 * As a plain `Retriever`, `retrieve(query, { filter })` navigates the trees that pass `filter`:
 * all of them when there are at most `maxDocuments`, otherwise the ones the LLM picks from their
 * descriptions.
 */
export class TreeNavigationRetriever implements Retriever {
  readonly store: DocumentTreeStore;
  private readonly llm: TreeLlm;

  constructor(private readonly options: TreeNavigationRetrieverOptions) {
    this.store = options.store;
    this.llm = options.llm;
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    const result = await this.search(
      query,
      options.filter !== undefined ? { filter: options.filter } : {},
    );
    return result.passages.slice(0, options.topK ?? result.passages.length);
  }

  /** {@link retrieve} with the audit trail: which documents, which nodes, why. */
  async search(query: string, options: NavigateOptions = {}): Promise<NavigationResult> {
    const maxDocuments = Math.max(1, this.options.maxDocuments ?? 3);
    const maxCandidates = Math.max(maxDocuments, this.options.maxSelectionCandidates ?? 200);
    const headers = await this.store.list({
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
      limit: maxCandidates,
    });
    if (headers.length <= maxDocuments) {
      return this.navigate(
        query,
        headers.map((header) => header.documentId),
        options,
      );
    }
    const budget = new BudgetedLlm(
      this.llm,
      { ...DEFAULT_BUDGET, ...this.options.budget, ...options.budget },
      options.signal,
    );
    const documents = headers.map((header) => ({
      id: header.documentId,
      ...(header.title !== undefined ? { title: header.title } : {}),
      ...(header.description !== undefined
        ? { description: header.description.slice(0, 600) }
        : {}),
    }));
    const prompt = `Select the documents that may contain the answer to the question, most relevant first, at most ${maxDocuments}.

Question: ${query}

Documents:
${documents.map((document) => `[${document.id}] ${document.title ?? ''}${document.description ? ` — ${document.description}` : ''}`).join('\n')}

Reply with JSON only: {"thinking": "<why>", "documents": ["<document id>", ...]} — an empty list if none is relevant.`;
    const known = new Set(documents.map((document) => document.id));
    try {
      const reply = parseJsonReply(
        await budget.call(
          { kind: 'select', query, documents, maxDocuments },
          NAVIGATE_SYSTEM,
          prompt,
          800,
        ),
      );
      const selected = [
        ...new Set(stringList(reply?.documents ?? reply?.answer).filter((id) => known.has(id))),
      ].slice(0, maxDocuments);
      const result = await this.navigate(query, selected, options);
      const reasoning =
        typeof reply?.thinking === 'string' ? reply.thinking.slice(0, 2_000) : undefined;
      return {
        ...result,
        selection: {
          candidates: documents.length,
          selected,
          ...(reasoning !== undefined ? { reasoning } : {}),
        },
      };
    } catch (error) {
      return {
        passages: [],
        documents: [],
        selection: { candidates: documents.length, selected: [], error: (error as Error).message },
      };
    }
  }

  /**
   * Navigate the given documents (in parallel, up to `concurrency`) and return their passages in
   * the order given, within `maxContextChars`. Documents without a tree, or whose tree fails
   * `filter`, yield no passages and `stoppedBy: 'not-found'`.
   */
  async navigate(
    query: string,
    documentIds: readonly string[],
    options: NavigateOptions = {},
  ): Promise<NavigationResult> {
    const ids = [...new Set(documentIds)];
    const trees = new Map(
      (await this.store.getMany(ids, options.filter)).map((tree) => [tree.documentId, tree]),
    );
    const navigations = await mapLimit(
      ids,
      Math.max(1, this.options.concurrency ?? 3),
      async (id) => {
        const tree = trees.get(id);
        if (tree === undefined) {
          return {
            navigation: {
              documentId: id,
              mode: 'single-pass',
              steps: [],
              nodes: [],
              llmCalls: 0,
              inputTokens: 0,
              outputTokens: 0,
              stoppedBy: 'not-found',
            } satisfies DocumentNavigation,
            passages: [] as Passage[],
          };
        }
        const navigation = await this.walk(query, tree, options);
        return { navigation, passages: await this.passagesOf(tree, navigation) };
      },
    );
    // Share the context budget across documents in the order given.
    const maxContextChars = this.options.maxContextChars ?? 48_000;
    let used = 0;
    const passages: Passage[] = [];
    for (const entry of navigations) {
      for (const passage of entry.passages) {
        if (used >= maxContextChars) {
          break;
        }
        const text = passage.text.slice(0, maxContextChars - used);
        used += text.length;
        passages.push({ ...passage, text });
      }
    }
    return { passages, documents: navigations.map((entry) => entry.navigation) };
  }

  private async walk(
    query: string,
    tree: DocumentTree,
    options: NavigateOptions,
  ): Promise<DocumentNavigation> {
    const budget = new BudgetedLlm(
      this.llm,
      { ...DEFAULT_BUDGET, ...this.options.budget, ...options.budget },
      options.signal,
    );
    const maxNodes = Math.max(1, this.options.maxNodes ?? 5);
    const singlePassMaxChars = this.options.singlePassMaxChars ?? 40_000;
    const index = indexTree(tree);
    const whole = [...walkTree(tree.nodes)].map(({ node, path }) => ({ node, depth: path.length }));
    const outline = fitCandidates(whole, Number.POSITIVE_INFINITY);
    const title = tree.title ?? tree.source ?? tree.documentId;
    const steps: NavigationStep[] = [];
    const chosen: string[] = [];
    let stoppedBy: DocumentNavigation['stoppedBy'];
    let error: string | undefined;
    const mode: DocumentNavigation['mode'] =
      outline.text.length <= singlePassMaxChars ? 'single-pass' : 'beam';

    const stop = (caught: unknown) => {
      if (caught instanceof TreeBudgetExceededError) {
        stoppedBy = caught.limit === 'timeout' ? 'timeout' : 'budget';
      } else {
        stoppedBy = 'error';
      }
      error = (caught as Error).message;
    };

    if (mode === 'single-pass') {
      const prompt = `Find the sections of the document that are likely to contain the answer to the question. Prefer the most specific (deepest) sections; list at most ${maxNodes}, most relevant first.

Question: ${query}

Document: ${title}${tree.description ? `\nAbout: ${tree.description}` : ''}
Table of contents ([id] title (pages) — summary):
${outline.text}

Reply with JSON only: {"thinking": "<which sections answer and why>", "read": ["<id>", ...]} — an empty list if none does.`;
      try {
        const reply = requireJson(
          await budget.call(
            { kind: 'navigate', query, mode, candidates: outline.candidates, maxNodes },
            NAVIGATE_SYSTEM,
            prompt,
            1_500,
          ),
        );
        const read = [...new Set(stringList(reply?.read ?? reply?.node_list ?? reply?.nodes))]
          .map((id) => resolveId(index, id))
          .filter((id): id is string => id !== undefined)
          .slice(0, maxNodes);
        chosen.push(...read);
        steps.push({
          step: 1,
          shown: outline.candidates.map((entry) => entry.id),
          expanded: [],
          read,
          ...reasoningOf(reply),
        });
      } catch (caught) {
        stop(caught);
      }
    } else {
      const beamWidth = Math.max(1, this.options.beamWidth ?? 4);
      const maxSteps = Math.max(1, this.options.maxSteps ?? 4);
      let frontier = tree.nodes;
      let pendingExpand: string[] = [];
      for (let step = 1; frontier.length > 0 && chosen.length < maxNodes; step++) {
        if (step > maxSteps) {
          stoppedBy = 'maxSteps';
          break;
        }
        const shown = fitCandidates(
          frontier.map((node) => ({ node })),
          singlePassMaxChars,
        );
        const path = index.get(frontier[0]?.id ?? '')?.path ?? [];
        const where =
          path.length > 0 ? `\nYou are inside: ${path.map((node) => node.title).join(' > ')}` : '';
        const prompt = `Find where the question is answered in the document by walking its table of contents.
For each relevant section below, either "expand" it (open its subsections, only for sections that have subsections) or "read" it (its text answers the question). Choose at most ${beamWidth} in total, most relevant first; choose none if nothing here is relevant.

Question: ${query}

Document: ${title}${tree.description ? `\nAbout: ${tree.description}` : ''}${where}
Sections ([id] title (pages) — summary):
${shown.text}

Reply with JSON only: {"thinking": "<why>", "expand": ["<id>", ...], "read": ["<id>", ...]}`;
        let reply: Record<string, unknown> | undefined;
        try {
          reply = requireJson(
            await budget.call(
              { kind: 'navigate', query, mode, candidates: shown.candidates, maxNodes: beamWidth },
              NAVIGATE_SYSTEM,
              prompt,
              1_200,
            ),
          );
        } catch (caught) {
          stop(caught);
          break;
        }
        const onFrontier = new Set(frontier.map((node) => node.id));
        const pick = (value: unknown) =>
          [...new Set(stringList(value))]
            .map((id) => resolveId(index, id))
            .filter((id): id is string => id !== undefined && onFrontier.has(id));
        let expand = pick(reply?.expand);
        let read = pick(reply?.read);
        // A leaf cannot be expanded: reading it is what was meant.
        read = [
          ...read,
          ...expand.filter((id) => (index.get(id)?.node.children.length ?? 0) === 0),
        ];
        expand = expand.filter((id) => (index.get(id)?.node.children.length ?? 0) > 0);
        const limited = [...expand, ...read].slice(0, beamWidth);
        expand = expand.filter((id) => limited.includes(id));
        read = [...new Set(read.filter((id) => limited.includes(id)))];
        steps.push({
          step,
          shown: shown.candidates.map((entry) => entry.id),
          expanded: expand,
          read,
          ...reasoningOf(reply),
        });
        chosen.push(...read);
        pendingExpand = expand;
        frontier = expand.flatMap((id) => index.get(id)?.node.children ?? []);
        if (frontier.length === 0) {
          pendingExpand = [];
        }
      }
      // Anything still marked for expansion when the walk stopped is read whole.
      if (stoppedBy !== undefined) {
        chosen.push(...pendingExpand);
      }
    }

    // A section chosen together with one of its own subsections adds nothing but length: the
    // more specific choice wins.
    const unique = [...new Set(chosen)];
    const specific = unique.filter(
      (id) =>
        !unique.some(
          (other) => other !== id && index.get(other)?.path.some((node) => node.id === id),
        ),
    );
    const nodes = specific.slice(0, maxNodes).flatMap((id) => {
      const entry = index.get(id);
      if (entry === undefined) {
        return [];
      }
      const { node, path } = entry;
      return [
        {
          nodeId: node.id,
          title: node.title,
          path: [...path, node].map((step) => ({ id: step.id, title: step.title })),
          ...(node.pageStart !== undefined ? { pageStart: node.pageStart } : {}),
          ...(node.pageEnd !== undefined ? { pageEnd: node.pageEnd } : {}),
          unitStart: node.unitStart,
          unitEnd: node.unitEnd,
        } satisfies NavigatedNode,
      ];
    });
    return {
      documentId: tree.documentId,
      ...(tree.title !== undefined ? { title: tree.title } : {}),
      mode,
      steps,
      nodes,
      llmCalls: budget.calls,
      inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens,
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  private async passagesOf(tree: DocumentTree, navigation: DocumentNavigation): Promise<Passage[]> {
    const maxPassageChars = this.options.maxPassageChars ?? 12_000;
    const maxUnits = Math.max(1, this.options.maxUnitsPerNode ?? 25);
    const reasoning = navigation.steps
      .map((step) => step.reasoning)
      .filter((text): text is string => text !== undefined)
      .join('\n');
    const passages: Passage[] = [];
    for (const [rank, node] of navigation.nodes.entries()) {
      const units = await this.store.readUnits(
        tree.documentId,
        node.unitStart,
        Math.min(node.unitEnd, node.unitStart + maxUnits - 1),
      );
      let text = units.map((unit) => unit.text).join('\n\n');
      if (text.length > maxPassageChars) {
        text = `${text.slice(0, maxPassageChars - 1)}…`;
      }
      passages.push({
        id: `${tree.documentId}#node:${node.nodeId}`,
        text,
        // Rank within the document's choice; not a similarity.
        score: 1 / (rank + 1),
        source: tree.source ?? tree.title ?? tree.documentId,
        metadata: {
          ...tree.metadata,
          documentId: tree.documentId,
          nodeId: node.nodeId,
          title: node.title,
          ...(node.pageStart !== undefined ? { pageStart: node.pageStart } : {}),
          ...(node.pageEnd !== undefined ? { pageEnd: node.pageEnd } : {}),
          path: node.path,
          retrieval: 'tree-navigation',
          ...(reasoning ? { reasoning: reasoning.slice(0, 2_000) } : {}),
        },
      });
    }
    return passages;
  }
}

/** Accept `0003`, `3`, `"[0003]"` for node `0003`. */
function resolveId(index: Map<string, unknown>, raw: string): string | undefined {
  const id = raw.trim().replace(/^\[|\]$/g, '');
  if (index.has(id)) {
    return id;
  }
  if (/^\d+$/.test(id)) {
    const padded = id.padStart(4, '0');
    if (index.has(padded)) {
      return padded;
    }
  }
  return undefined;
}

/** The reply's JSON object, or an error naming what came back (a truncated or chatty reply). */
function requireJson(reply: string): Record<string, unknown> {
  const json = parseJsonReply(reply);
  if (json === undefined) {
    throw new Error(`navigation reply was not JSON: ${JSON.stringify(reply.slice(0, 120))}`);
  }
  return json;
}

function reasoningOf(reply: Record<string, unknown> | undefined): { reasoning?: string } {
  const thinking = reply?.thinking ?? reply?.reasoning;
  return typeof thinking === 'string' && thinking.trim()
    ? { reasoning: thinking.slice(0, 2_000) }
    : {};
}
