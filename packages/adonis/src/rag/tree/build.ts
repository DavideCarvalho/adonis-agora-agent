import { type DetectedHeading, detectHeadings, runningLines } from './headings.js';
import {
  BudgetedLlm,
  parseJsonReply,
  stableHash,
  type TreeBudget,
  TreeBudgetExceededError,
  type TreeLlm,
} from './llm.js';
import type {
  DocumentTree,
  DocumentTreeInput,
  DocumentTreeNode,
  TreeStructureSource,
  TreeUnit,
} from './types.js';
import { walkTree } from './types.js';

export interface BuildDocumentTreeOptions {
  documentId: string;
  /**
   * The model for summaries, the document description, and structuring documents with no usable
   * outline. Omit it and the build is LLM-free: outline/headings or page groups, with the start of
   * each section's text as its summary.
   */
  llm?: TreeLlm;
  /** Deepest level kept (1 = top-level sections only). Deeper headings become `keyItems`. Default 4. */
  maxDepth?: number;
  /**
   * Hard per-document limits for every LLM call of the build. Defaults: 60 calls, 400k input
   * tokens, 40k output tokens, 5 minutes overall, 60 s per call. Running out is not an error: the
   * structure step falls back to page groups, and remaining summaries use the section's own text.
   */
  budget?: TreeBudget;
  /** Summarize nodes with the LLM. Default `true` when `llm` is set. */
  summaries?: boolean;
  /** A node whose text is shorter than this is its own summary (no LLM call). Default 600 chars. */
  summaryMinChars?: number;
  /** Text of a node sent to the summarizer, at most. Default 8 000 chars. */
  summaryInputChars?: number;
  /** Concurrent summary calls. Default 4. */
  concurrency?: number;
  /** Write a one-paragraph description of the document. Default `true` when `llm` is set. */
  describe?: boolean;
  /**
   * Find headings in the text (markdown headers, `PART 52`, `Item 7.`, `3.2 Scope`…) when there is
   * no outline and sections carry no titles. `'markdown'` only trusts markdown headers. Default `true`.
   */
  detectHeadings?: boolean | 'markdown';
  /** At least this many headings for a detected structure to be used. Default 3. */
  minHeadings?: number;
  /** Ask the LLM for the structure when nothing deterministic worked. Default `true` when `llm` is set. */
  llmStructure?: boolean;
  /** Characters of text per structuring call. Default 24 000. */
  structureWindowChars?: number;
  /**
   * Structuring calls allowed. A document needing more windows than this is not sent at all —
   * it goes straight to page groups instead of spending a budget it cannot finish. Default 12.
   */
  maxStructureCalls?: number;
  /** Units per page-group node (flat trees, and splitting long leaves). Default 5. */
  groupSize?: number;
  /** A leaf spanning more units than this is split into page groups. Default 10. */
  maxLeafUnits?: number;
  /** Children per level before page groups are grouped again (flat trees). Default 12. */
  maxChildren?: number;
  /** The previous tree of this document: an unchanged input returns it as is; changed nodes are re-summarized, the rest reuse their summaries. */
  previous?: DocumentTree;
  metadata?: Record<string, unknown>;
  source?: string;
  signal?: AbortSignal;
}

export interface BuiltDocumentTree {
  tree: DocumentTree;
  /** The units the node ranges index — persist them with the tree ({@link import('./store.js').DocumentTreeStore.put}). */
  units: TreeUnit[];
  /** `true` when `previous` had the same fingerprint and was returned without building. */
  unchanged: boolean;
}

const DEFAULT_BUDGET = {
  maxCalls: 60,
  maxInputTokens: 400_000,
  maxOutputTokens: 40_000,
  timeoutMs: 300_000,
  callTimeoutMs: 60_000,
} as const;

const STRUCTURE_SYSTEM =
  'You extract the table of contents of a document. You answer with JSON only, no prose.';
const SUMMARY_SYSTEM =
  'You summarize sections of a document so a reader can decide whether a section answers their question. Be specific: name the topics, clauses, figures and defined terms it covers.';

/** Turn the input into units (pages or sections) plus any headings it declares. */
export function toUnits(input: DocumentTreeInput): {
  units: TreeUnit[];
  declared: DetectedHeading[] | undefined;
  kind: 'pages' | 'sections';
} {
  if (input.pages !== undefined && input.sections !== undefined) {
    throw new Error('buildDocumentTree: give `pages` or `sections`, not both');
  }
  if (input.sections !== undefined) {
    const units = input.sections.map((section, index) => ({
      index,
      text: section.text,
      ...(section.page !== undefined ? { page: section.page } : {}),
    }));
    const titled = input.sections.some((section) => section.title?.trim());
    const declared = titled
      ? input.sections.flatMap((section, unit) =>
          section.title?.trim()
            ? [
                {
                  title: section.title.trim(),
                  level: Math.max(1, Math.min(6, section.level ?? 1)),
                  unit,
                  atUnitStart: true,
                },
              ]
            : [],
        )
      : undefined;
    return { units, declared, kind: 'sections' };
  }
  const pages = input.pages ?? [];
  return {
    units: pages.map((text, index) => ({ index, text, page: index + 1 })),
    declared: undefined,
    kind: 'pages',
  };
}

function outlineHeadings(input: DocumentTreeInput, units: TreeUnit[]): DetectedHeading[] {
  const headings: DetectedHeading[] = [];
  for (const entry of input.outline ?? []) {
    let unit = entry.unit;
    if (unit === undefined && entry.page !== undefined) {
      unit = units.findIndex((candidate) => candidate.page === entry.page);
      if (unit < 0) {
        unit = entry.page - 1;
      }
    }
    if (unit === undefined || unit < 0 || unit >= units.length || !entry.title.trim()) {
      continue;
    }
    headings.push({
      title: entry.title.trim(),
      level: Math.max(1, Math.min(6, Math.floor(entry.level))),
      unit,
      atUnitStart: false,
    });
  }
  // Outlines are usually ordered, but some PDFs list bookmarks out of page order.
  return headings.sort((a, b) => a.unit - b.unit);
}

interface DraftNode {
  title: string;
  unitStart: number;
  unitEnd: number;
  keyItems?: string[];
  children: DraftNode[];
}

/** Nest headings by level (a stack, like PageIndex's markdown tree) and compute each span. */
function nestHeadings(headings: DetectedHeading[], unitCount: number): DraftNode[] {
  const roots: DraftNode[] = [];
  const stack: { node: DraftNode; level: number }[] = [];
  headings.forEach((heading, index) => {
    // The node ends where the next heading of the same or a higher level starts.
    let end = unitCount - 1;
    for (let next = index + 1; next < headings.length; next++) {
      const candidate = headings[next];
      if (candidate !== undefined && candidate.level <= heading.level) {
        end = candidate.atUnitStart ? candidate.unit - 1 : candidate.unit;
        break;
      }
    }
    const node: DraftNode = {
      title: heading.title,
      unitStart: heading.unit,
      unitEnd: Math.max(heading.unit, end),
      children: [],
    };
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.node.children.push(node);
      parent.node.unitEnd = Math.max(parent.node.unitEnd, node.unitEnd);
    }
    stack.push({ node, level: heading.level });
  });
  // Front matter before the first heading stays reachable.
  const first = roots[0];
  if (first !== undefined && first.unitStart > 0) {
    roots.unshift({
      title: 'Front matter',
      unitStart: 0,
      unitEnd: first.unitStart - 1,
      children: [],
    });
  }
  return roots;
}

/** The first meaningful line of a unit: not page furniture (a running header, a page number). */
function firstLine(text: string, running: ReadonlySet<string>): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        /[A-Za-z]{3,}/.test(candidate) &&
        !running.has(candidate.replace(/\d+/g, '#').toLowerCase()),
    );
  return line === undefined ? '' : line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function rangeLabel(units: TreeUnit[], start: number, end: number): string {
  const first = units[start];
  const last = units[end];
  if (first?.page !== undefined && last?.page !== undefined) {
    return first.page === last.page ? `Page ${first.page}` : `Pages ${first.page}–${last.page}`;
  }
  return start === end ? `Section ${start + 1}` : `Sections ${start + 1}–${end + 1}`;
}

/** Fixed-size groups over `[start, end]`, grouped again while a level is wider than `maxChildren`. */
function groupNodes(
  units: TreeUnit[],
  start: number,
  end: number,
  groupSize: number,
  maxChildren: number,
  levelsLeft: number,
  running: ReadonlySet<string>,
): DraftNode[] {
  let level: DraftNode[] = [];
  for (let from = start; from <= end; from += groupSize) {
    const to = Math.min(end, from + groupSize - 1);
    const lead = firstLine(units[from]?.text ?? '', running);
    level.push({
      title: `${rangeLabel(units, from, to)}${lead ? `: ${lead}` : ''}`,
      unitStart: from,
      unitEnd: to,
      children: [],
    });
  }
  let depth = 1;
  while (level.length > maxChildren && depth < levelsLeft) {
    const parents: DraftNode[] = [];
    const per = Math.max(maxChildren, Math.ceil(level.length / maxChildren));
    for (let index = 0; index < level.length; index += per) {
      const children = level.slice(index, index + per);
      const from = children[0]?.unitStart ?? start;
      const to = children[children.length - 1]?.unitEnd ?? end;
      parents.push({ title: rangeLabel(units, from, to), unitStart: from, unitEnd: to, children });
    }
    level = parents;
    depth += 1;
  }
  return level;
}

/** Titles of every descendant, at most 30 — routing information kept when the nodes go. */
function descendantTitles(nodes: DraftNode[], into: string[] = []): string[] {
  for (const { node } of walkDraft(nodes)) {
    if (into.length < 30) {
      into.push(node.title);
    }
  }
  return into;
}

/**
 * Enforce `maxDepth` (deeper titles become `keyItems`), split long leaves into page groups, and
 * collapse what retrieval could not tell apart anyway — retrieval reads whole units, so:
 *
 * - a lone child spanning exactly its parent is folded into it;
 * - a node spanning a single unit keeps its descendants only as `keyItems`;
 * - consecutive leaf siblings spanning the same units merge into the first (the others' titles
 *   become its `keyItems`), instead of each getting its own — identical — summary call.
 */
function shape(
  nodes: DraftNode[],
  units: TreeUnit[],
  depth: number,
  options: {
    maxDepth: number;
    maxLeafUnits: number;
    groupSize: number;
    maxChildren: number;
    running: ReadonlySet<string>;
  },
): DraftNode[] {
  const shaped = nodes.map((node) => {
    if (
      depth >= options.maxDepth ||
      (node.unitStart === node.unitEnd && node.children.length > 0)
    ) {
      const keyItems = descendantTitles(node.children, [...(node.keyItems ?? [])]);
      return {
        ...node,
        ...(keyItems.length > 0 ? { keyItems } : {}),
        children: [],
      };
    }
    let children = node.children;
    const only = children[0];
    if (
      children.length === 1 &&
      only !== undefined &&
      only.unitStart === node.unitStart &&
      only.unitEnd === node.unitEnd
    ) {
      children = only.children;
    }
    if (children.length === 0 && node.unitEnd - node.unitStart + 1 > options.maxLeafUnits) {
      children = groupNodes(
        units,
        node.unitStart,
        node.unitEnd,
        options.groupSize,
        options.maxChildren,
        options.maxDepth - depth,
        options.running,
      );
    }
    return { ...node, children: shape(children, units, depth + 1, options) };
  });
  const merged: DraftNode[] = [];
  for (const node of shaped) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      previous.children.length === 0 &&
      node.children.length === 0 &&
      previous.unitStart === node.unitStart &&
      previous.unitEnd === node.unitEnd
    ) {
      previous.keyItems = [
        ...(previous.keyItems ?? []),
        node.title,
        ...(node.keyItems ?? []),
      ].slice(0, 30);
      continue;
    }
    merged.push(node);
  }
  return merged;
}

function* walkDraft(nodes: DraftNode[]): Generator<{ node: DraftNode }> {
  for (const node of nodes) {
    yield { node };
    yield* walkDraft(node.children);
  }
}

/** The text a node spans (children included), joined in reading order. */
export function spanText(units: readonly TreeUnit[], start: number, end: number): string {
  const parts: string[] = [];
  for (let index = Math.max(0, start); index <= end && index < units.length; index++) {
    parts.push(units[index]?.text ?? '');
  }
  return parts.join('\n\n');
}

/**
 * The text of a node before its first child (its own introduction), or its whole span for a leaf —
 * one string per unit, the first starting at the node's heading when it can be found in the unit
 * (a heading in the middle of a page should not be summarized from the top of that page).
 */
function ownTexts(units: readonly TreeUnit[], node: DocumentTreeNode): string[] {
  const first = node.children[0];
  const end = first === undefined ? node.unitEnd : Math.max(node.unitStart, first.unitStart - 1);
  const texts: string[] = [];
  for (let index = node.unitStart; index <= end && index < units.length; index++) {
    texts.push(units[index]?.text ?? '');
  }
  const head = texts[0];
  if (head !== undefined) {
    const probe = node.title.slice(0, 30);
    const at = probe.length >= 4 ? head.indexOf(probe) : -1;
    if (at > 0) {
      texts[0] = head.slice(at);
    }
  }
  return texts;
}

/**
 * At most `max` characters of `texts`, spread evenly across them — a node spanning ten pages is
 * summarized from all ten, not from the first two.
 */
function excerptOf(texts: readonly string[], max: number): string {
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  if (total <= max) {
    return texts.join('\n\n');
  }
  const per = Math.max(400, Math.floor(max / texts.length));
  const parts: string[] = [];
  let used = 0;
  for (const text of texts) {
    if (used >= max) {
      break;
    }
    const part = text.length > per ? `${text.slice(0, per)}…` : text;
    parts.push(part);
    used += part.length;
  }
  return parts.join('\n\n');
}

function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Ask the LLM for section starts, window by window. Throws on any failure (caller falls back). */
async function llmHeadings(
  llm: BudgetedLlm,
  units: TreeUnit[],
  options: { windowChars: number; maxCalls: number },
): Promise<DetectedHeading[]> {
  const perUnit = Math.max(500, Math.floor(options.windowChars / 4));
  const windows: TreeUnit[][] = [];
  let current: TreeUnit[] = [];
  let size = 0;
  for (const unit of units) {
    const length = Math.min(unit.text.length, perUnit);
    if (current.length > 0 && size + length > options.windowChars) {
      windows.push(current);
      current = [];
      size = 0;
    }
    current.push(unit);
    size += length;
  }
  if (current.length > 0) {
    windows.push(current);
  }
  if (windows.length > options.maxCalls) {
    throw new Error(
      `document needs ${windows.length} structuring calls, more than maxStructureCalls (${options.maxCalls})`,
    );
  }
  const headings: DetectedHeading[] = [];
  for (const window of windows) {
    const shown = window.map((unit) => ({
      unit: unit.index,
      ...(unit.page !== undefined ? { page: unit.page } : {}),
      text: unit.text.length > perUnit ? `${unit.text.slice(0, perUnit)}…` : unit.text,
    }));
    const body = shown
      .map((unit) => `<unit ${unit.unit}>\n${unit.text}\n</unit ${unit.unit}>`)
      .join('\n');
    const prompt = `Below is part of a document, split into numbered units (pages or sections).
List the headings of the sections that START in these units, in reading order, with their nesting level (1 = top-level chapter/part, 2 = its subsections, ...) and the unit number they start in.
Only list real headings (titles of parts, chapters, sections, clauses, items), not running page headers, table rows or sentences. If no section starts here, return an empty list.

${body}

Reply with JSON only: {"sections": [{"title": "...", "level": 1, "unit": 0}]}`;
    const reply = parseJsonReply(
      await llm.call({ kind: 'structure', units: shown }, STRUCTURE_SYSTEM, prompt, 2_000),
    );
    const sections = reply?.sections;
    if (!Array.isArray(sections)) {
      throw new Error('structuring reply had no `sections` list');
    }
    const first = window[0]?.index ?? 0;
    const last = window[window.length - 1]?.index ?? first;
    for (const entry of sections) {
      if (entry === null || typeof entry !== 'object') {
        continue;
      }
      const { title, level, unit } = entry as Record<string, unknown>;
      const at = typeof unit === 'number' ? unit : Number(unit);
      if (
        typeof title !== 'string' ||
        !title.trim() ||
        !Number.isInteger(at) ||
        at < first ||
        at > last
      ) {
        continue;
      }
      const previous = headings[headings.length - 1];
      if (previous !== undefined && at < previous.unit) {
        continue;
      }
      headings.push({
        title: collapse(title, 160),
        level: Math.max(1, Math.min(6, Math.floor(typeof level === 'number' ? level : 1))),
        unit: at,
        atUnitStart: false,
      });
    }
  }
  return headings;
}

/** Run `work` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Build a document's navigation tree: a hierarchical table of contents whose nodes carry a title,
 * the page (or section) range they span, and a summary.
 *
 * Structure, cheapest first, never looping:
 *
 * 1. the `outline` the input declares (PDF bookmarks);
 * 2. section titles/levels (`sections` input), or headings detected in the text;
 * 3. the LLM, window by window (only when a document has no usable outline, and only if every
 *    window fits `maxStructureCalls` and the budget up front);
 * 4. page groups — always works; the fallback for any failure above.
 *
 * Then summaries: top levels first (they matter most for navigation), each node's text sent once,
 * within the budget; what the budget leaves unsummarized gets the start of its own text. With a
 * `previous` tree, an unchanged input is returned as is (zero calls), and nodes whose title and text
 * are unchanged keep their summary.
 *
 * The result is deterministic for a deterministic model: node ids are depth-first positions, and
 * nothing depends on timing except which summaries a timed-out build got to.
 */
export async function buildDocumentTree(
  input: DocumentTreeInput,
  options: BuildDocumentTreeOptions,
): Promise<BuiltDocumentTree> {
  const started = Date.now();
  const { units, declared, kind } = toUnits(input);
  const maxDepth = Math.max(1, options.maxDepth ?? 4);
  const groupSize = Math.max(1, options.groupSize ?? 5);
  const maxLeafUnits = Math.max(groupSize, options.maxLeafUnits ?? 10);
  const maxChildren = Math.max(2, options.maxChildren ?? 12);
  const minHeadings = Math.max(1, options.minHeadings ?? 3);
  const llmEnabled = options.llm !== undefined;
  const summaries = options.summaries ?? llmEnabled;
  const describe = options.describe ?? llmEnabled;
  const llmStructure = options.llmStructure ?? llmEnabled;
  const detect = options.detectHeadings ?? true;
  const summaryMinChars = options.summaryMinChars ?? 600;
  const summaryInputChars = options.summaryInputChars ?? 8_000;

  const unitHashes = units.map((unit) => stableHash(unit.text));
  const fingerprint = stableHash(
    JSON.stringify({
      v: 1,
      kind,
      title: input.title ?? null,
      outline: input.outline ?? null,
      sections:
        input.sections?.map((section) => [
          section.title ?? null,
          section.level ?? null,
          section.page ?? null,
        ]) ?? null,
      units: unitHashes,
      maxDepth,
      groupSize,
      maxLeafUnits,
      maxChildren,
      minHeadings,
      detect,
      summaries,
      describe,
      llmStructure: llmStructure && llmEnabled,
      summaryMinChars,
      summaryInputChars,
    }),
  );
  if (options.previous?.fingerprint === fingerprint) {
    // Same text, same shape: only the access metadata / citation may have moved.
    const { metadata: _metadata, source: _source, ...previous } = options.previous;
    const metadata = options.metadata ?? options.previous.metadata;
    const source = options.source ?? options.previous.source;
    return {
      tree: {
        ...previous,
        ...(metadata !== undefined ? { metadata } : {}),
        ...(source !== undefined ? { source } : {}),
      },
      units,
      unchanged: true,
    };
  }

  const budget = new BudgetedLlm(
    options.llm ?? (() => Promise.reject(new Error('no llm'))),
    { ...DEFAULT_BUDGET, ...options.budget },
    options.signal,
  );
  let fallbackReason: string | undefined;

  // 1–4: structure.
  let structure: TreeStructureSource = 'flat';
  let headings: DetectedHeading[] = [];
  const running = runningLines(units.map((unit) => unit.text));
  const outline = outlineHeadings(input, units);
  if (outline.length >= Math.min(minHeadings, 2)) {
    structure = 'outline';
    headings = outline;
  } else if (declared !== undefined && declared.length >= 1) {
    structure = 'headings';
    headings = declared;
  } else if (detect !== false && units.length > 0) {
    const found = detectHeadings(
      units.map((unit) => unit.text),
      detect === 'markdown',
    );
    if (found.length >= minHeadings) {
      structure = 'headings';
      headings = found;
    }
  }
  if (structure === 'flat' && llmStructure && llmEnabled && units.length > 1) {
    try {
      const found = await llmHeadings(budget, units, {
        windowChars: options.structureWindowChars ?? 24_000,
        maxCalls: Math.max(1, options.maxStructureCalls ?? 12),
      });
      if (found.length >= Math.min(minHeadings, 2)) {
        structure = 'llm';
        headings = found;
      } else {
        fallbackReason = 'LLM found no usable structure';
      }
    } catch (error) {
      fallbackReason =
        error instanceof TreeBudgetExceededError
          ? `LLM structuring stopped: ${error.message}`
          : `LLM structuring failed: ${(error as Error).message}`;
    }
  }

  const draft =
    structure === 'flat'
      ? units.length === 0
        ? []
        : groupNodes(units, 0, units.length - 1, groupSize, maxChildren, maxDepth, running)
      : nestHeadings(headings, units.length);
  const shaped = shape(draft, units, 1, {
    maxDepth,
    maxLeafUnits,
    groupSize,
    maxChildren,
    running,
  });

  // Ids, pages and content hashes.
  let counter = 0;
  const finalize = (nodes: DraftNode[]): DocumentTreeNode[] =>
    nodes.map((node) => {
      counter += 1;
      const id = String(counter).padStart(4, '0');
      const pageStart = units[node.unitStart]?.page;
      const pageEnd = units[node.unitEnd]?.page;
      return {
        id,
        title: node.title,
        unitStart: node.unitStart,
        unitEnd: node.unitEnd,
        ...(pageStart !== undefined ? { pageStart } : {}),
        ...(pageEnd !== undefined ? { pageEnd } : {}),
        ...(node.keyItems !== undefined ? { keyItems: node.keyItems } : {}),
        contentHash: stableHash(
          `${node.title}\u0000${unitHashes.slice(node.unitStart, node.unitEnd + 1).join(',')}`,
        ),
        children: finalize(node.children),
      };
    });
  const nodes = finalize(shaped);

  // Summaries: reuse, then top-down (breadth-first) within the budget, then the text itself.
  const previousSummaries = new Map<string, string>();
  if (options.previous !== undefined) {
    for (const { node } of walkTree(options.previous.nodes)) {
      if (
        node.summary !== undefined &&
        (node.summarySource === 'llm' || node.summarySource === 'reused')
      ) {
        previousSummaries.set(node.contentHash, node.summary);
      }
    }
  }
  const breadthFirst: DocumentTreeNode[] = [];
  for (let queue = [...nodes]; queue.length > 0; ) {
    const node = queue.shift() as DocumentTreeNode;
    breadthFirst.push(node);
    queue = queue.concat(node.children);
  }
  let reusedSummaries = 0;
  const pending: DocumentTreeNode[] = [];
  for (const node of breadthFirst) {
    const reused = previousSummaries.get(node.contentHash);
    const own = ownTexts(units, node).join('\n\n');
    if (reused !== undefined) {
      node.summary = reused;
      node.summarySource = 'reused';
      reusedSummaries += 1;
    } else if (own.trim().length < summaryMinChars && node.children.length === 0) {
      const text = collapse(own, summaryMinChars);
      if (text) {
        node.summary = text;
        node.summarySource = 'text';
      }
    } else if (summaries && llmEnabled) {
      pending.push(node);
    } else {
      const text = collapse(own, 300);
      if (text) {
        node.summary = text;
        node.summarySource = 'text';
      }
    }
  }
  let summariesCut = false;
  await mapLimit(pending, Math.max(1, options.concurrency ?? 4), async (node) => {
    const own = ownTexts(units, node);
    const childTitles = [...node.children.map((child) => child.title), ...(node.keyItems ?? [])]
      .map((title) => `- ${title}`)
      .join('\n');
    const excerpt = excerptOf(own, summaryInputChars);
    const prompt = `Summarize this section of ${input.title ? `"${input.title}"` : 'a document'} in 2-4 sentences (at most 80 words). Name the specific topics, requirements, clauses, figures and defined terms it covers, so a reader can tell whether it answers their question.

Section title: ${node.title}
${childTitles ? `Subsections:\n${childTitles}\n` : ''}
Section text:
${excerpt}

Reply with the summary only.`;
    if (!summariesCut && budget.fits(SUMMARY_SYSTEM + prompt, 300)) {
      try {
        const reply = await budget.call(
          { kind: 'summarize', title: node.title, text: excerpt },
          SUMMARY_SYSTEM,
          prompt,
          300,
        );
        const json = parseJsonReply(reply);
        const summary = typeof json?.summary === 'string' ? json.summary : reply;
        if (summary.trim()) {
          node.summary = collapse(summary, 800);
          node.summarySource = 'llm';
          return;
        }
      } catch (error) {
        if (error instanceof TreeBudgetExceededError) {
          summariesCut = true;
        }
        fallbackReason ??= `summary failed: ${(error as Error).message}`;
      }
    } else {
      summariesCut = true;
    }
    const text = collapse(own.join('\n\n'), 300);
    if (text) {
      node.summary = text;
      node.summarySource = 'text';
    }
  });
  if (summariesCut) {
    fallbackReason ??= 'LLM budget exhausted before every node was summarized';
  }

  let description: string | undefined;
  const outlineForDescription = nodes.slice(0, 40).map((node) => ({
    title: node.title,
    ...(node.summary !== undefined ? { summary: node.summary } : {}),
  }));
  if (describe && llmEnabled && nodes.length > 0) {
    const prompt = `Write a one-paragraph description (at most 80 words) of the document ${input.title ? `"${input.title}"` : ''} from its table of contents below, so a reader can tell which questions it can answer.

${outlineForDescription.map((entry) => `- ${entry.title}${entry.summary ? `: ${entry.summary}` : ''}`).join('\n')}

Reply with the description only.`;
    if (budget.fits(SUMMARY_SYSTEM + prompt, 300)) {
      try {
        description = collapse(
          await budget.call(
            {
              kind: 'describe',
              ...(input.title !== undefined ? { title: input.title } : {}),
              outline: outlineForDescription,
            },
            SUMMARY_SYSTEM,
            prompt,
            300,
          ),
          1_000,
        );
      } catch (error) {
        fallbackReason ??= `description failed: ${(error as Error).message}`;
      }
    }
  }
  if (
    description === undefined &&
    options.previous?.description !== undefined &&
    reusedSummaries > 0
  ) {
    description = options.previous.description;
  }

  const tree: DocumentTree = {
    documentId: options.documentId,
    version: 1,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(description ? { description } : {}),
    structure,
    fingerprint,
    unitCount: units.length,
    nodes,
    stats: {
      llmCalls: budget.calls,
      inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens,
      durationMs: Date.now() - started,
      ...(fallbackReason !== undefined ? { fallbackReason } : {}),
      budgetExhausted: budget.exhausted,
      reusedSummaries,
    },
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    ...(options.source !== undefined ? { source: options.source } : {}),
    builtAt: new Date().toISOString(),
  };
  return { tree, units, unchanged: false };
}
