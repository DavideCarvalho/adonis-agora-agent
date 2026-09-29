// Unit: tree building, navigation, two-stage retrieval and the navigate_document tool, with a
// deterministic fake LLM (keywordTreeLlm) and wrappers that count, fail or stall calls.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Passage, Retriever, TreeLlm, TreeLlmRequest } from '../src/index.js';
import {
  buildDocumentTree,
  cachedTreeLlm,
  createNavigateDocumentTool,
  type DocumentTree,
  detectHeadings,
  indexDocumentTree,
  keywordTreeLlm,
  MemoryDocumentTreeStore,
  openAiChatTreeLlm,
  parseJsonReply,
  TreeNavigationRetriever,
  TwoStageRetriever,
  treeLlmFromModelProvider,
  walkTree,
} from '../src/index.js';
import type { AiToolCtx } from '../src/spi/tool.js';
import { FakeModelProvider } from '../src/testing/index.js';

/** A 33-page regulation with markdown headings: 3 parts × 2 subparts × clauses, 1-2 pages each. */
function regulation(): string[] {
  const topics: Record<string, string[]> = {
    'Part 1 — Contracting': ['Definitions of terms', 'Small business set-asides'],
    'Part 2 — Construction': ['Material and workmanship', 'Warranty of construction'],
    'Part 3 — Payments': ['Progress payments', 'Prompt payment interest'],
  };
  const pages: string[] = [];
  let clause = 0;
  for (const [part, subparts] of Object.entries(topics)) {
    pages.push(`# ${part}\nThis part covers ${part.split('— ')[1]?.toLowerCase()} matters.`);
    for (const subpart of subparts) {
      pages.push(`## ${subpart}\nGeneral rules on ${subpart.toLowerCase()}.`);
      for (let n = 1; n <= 2; n++) {
        clause += 1;
        const topic = subpart.toLowerCase();
        pages.push(
          `### Clause ${clause}: ${subpart} (${n === 1 ? 'scope' : 'remedies'})\nThe contractor shall comply with ${topic} requirement ${n}. ${'Filler text about the obligations. '.repeat(30)}`,
        );
        pages.push(`Continuation of clause ${clause} on ${topic}. ${'More detail. '.repeat(40)}`);
      }
    }
  }
  return pages;
}

/** Wrap an LLM to record every request. */
function counting(llm: TreeLlm): TreeLlm & { requests: TreeLlmRequest[] } {
  const requests: TreeLlmRequest[] = [];
  const wrapped = (async (request: TreeLlmRequest) => {
    requests.push(request);
    return llm(request);
  }) as TreeLlm & { requests: TreeLlmRequest[] };
  wrapped.requests = requests;
  return wrapped;
}

function strip(tree: DocumentTree) {
  const { builtAt: _builtAt, stats, ...rest } = tree;
  const { durationMs: _durationMs, ...kept } = stats;
  return { ...rest, stats: kept };
}

const ctx = (tenantRef: string): AiToolCtx => ({
  actor: { id: 'u1', tenantRef } as AiToolCtx['actor'],
  threadId: 't',
  runId: 'r',
  requestId: 'q',
});

describe('detectHeadings', () => {
  it('finds markdown, keyword and dotted-number headings and drops running page headers', () => {
    const pages = [
      'PART 52—SOLICITATION PROVISIONS\nSubpart 52.2 Text of Provisions\n52.236-5 Material and Workmanship.\nAll equipment shall be new.',
      'PART 52—SOLICITATION PROVISIONS\n52.236-6 Superintendence by the Contractor.\nbody',
      'PART 52—SOLICITATION PROVISIONS\nItem 7. Management Discussion\nRevenue grew 12%',
      'PART 52—SOLICITATION PROVISIONS\n# Appendix\n1.5 million shares were issued in 2023 for 12',
    ];
    const titles = detectHeadings(pages).map((heading) => `${heading.level}:${heading.title}`);
    expect(titles).toEqual([
      '1:PART 52—SOLICITATION PROVISIONS',
      '2:Subpart 52.2 Text of Provisions',
      '4:52.236-5 Material and Workmanship',
      '4:52.236-6 Superintendence by the Contractor',
      '2:Item 7. Management Discussion',
      '1:Appendix',
    ]);
    expect(detectHeadings(pages, true).map((heading) => heading.title)).toEqual(['Appendix']);
  });
});

describe('structure heuristics', () => {
  it('drops a table-of-contents listing but keeps the part heading that opens it', () => {
    const page = [
      'PART 3—IMPROPER BUSINESS PRACTICES',
      'Sec.',
      '3.000 Scope of part.',
      'Subpart 3.1—Safeguards',
      '3.101 Standards of conduct.',
      '3.101-1 General.',
      '3.102 Reserved.',
      '3.000 Scope of part.',
      'This part prescribes policies for avoiding improper business practices.',
      '127.300. It automatically qualifies as a',
      'small business under the size standard.',
      '52.236–3 Site Investigation and Condi-',
      'tions Affecting the Work.',
      'As prescribed in 36.503, insert the fol-',
      'lowing clause:',
    ].join('\n');
    expect(detectHeadings([page]).map((heading) => heading.title)).toEqual([
      'PART 3—IMPROPER BUSINESS PRACTICES',
      '3.000 Scope of part',
      '52.236–3 Site Investigation and Conditions Affecting the Work',
    ]);
  });

  it('merges same-page siblings and keeps single-page subtrees as key items', async () => {
    const pages = [
      '# Intro\nintro text',
      '# Part A\n## A.1\nx\n## A.2\ny\n## A.3\nz',
      '# Part B\nbody of b',
      'more of b\n## B.1\nfirst\n## B.2\nsecond',
    ];
    const { tree } = await buildDocumentTree({ pages }, { documentId: 'm' });
    const [, partA, partB] = tree.nodes;
    expect(partA?.children).toEqual([]);
    expect(partA?.keyItems).toEqual(['A.1', 'A.2', 'A.3']);
    expect(partB?.children.map((child) => [child.title, child.keyItems])).toEqual([
      ['B.1', ['B.2']],
    ]);
  });
});

describe('buildDocumentTree', () => {
  it('derives the structure from headings without an LLM, with page ranges and text summaries', async () => {
    const { tree, units } = await buildDocumentTree(
      { pages: regulation(), title: 'Reg' },
      { documentId: 'reg' },
    );
    expect(tree.structure).toBe('headings');
    expect(tree.stats.llmCalls).toBe(0);
    expect(units).toHaveLength(33);
    expect(tree.nodes.map((node) => node.title)).toEqual([
      'Part 1 — Contracting',
      'Part 2 — Construction',
      'Part 3 — Payments',
    ]);
    const construction = tree.nodes[1];
    expect(construction?.pageStart).toBe(12);
    expect(construction?.pageEnd).toBe(22);
    const workmanship = construction?.children[0];
    expect(workmanship?.title).toBe('Material and workmanship');
    expect(
      workmanship?.children.map((child) => [child.title, child.pageStart, child.pageEnd]),
    ).toEqual([
      ['Clause 5: Material and workmanship (scope)', 14, 15],
      ['Clause 6: Material and workmanship (remedies)', 16, 17],
    ]);
    const ids = [...walkTree(tree.nodes)].map(({ node }) => node.id);
    expect(ids[0]).toBe('0001');
    expect(new Set(ids).size).toBe(ids.length);
    for (const { node } of walkTree(tree.nodes)) {
      expect(node.summarySource).toBe('text');
    }
  });

  it('uses the declared outline first, and section titles/levels for section input', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => `page ${i + 1} text`);
    const fromOutline = await buildDocumentTree(
      {
        pages,
        outline: [
          { title: 'Intro', level: 1, page: 1 },
          { title: 'Body', level: 1, page: 4 },
          { title: 'Detail', level: 2, page: 6 },
        ],
      },
      { documentId: 'o' },
    );
    expect(fromOutline.tree.structure).toBe('outline');
    expect(
      fromOutline.tree.nodes.map((node) => [node.title, node.pageStart, node.pageEnd]),
    ).toEqual([
      ['Intro', 1, 4],
      ['Body', 4, 12],
    ]);

    const fromSections = await buildDocumentTree(
      {
        sections: [
          { title: 'A', level: 1, text: 'alpha' },
          { title: 'A.1', level: 2, text: 'alpha one' },
          { text: 'untitled continuation' },
          { title: 'B', level: 1, text: 'beta' },
        ],
      },
      { documentId: 's' },
    );
    expect(fromSections.tree.structure).toBe('headings');
    const [a, b] = fromSections.tree.nodes;
    expect([a?.unitStart, a?.unitEnd, a?.children[0]?.unitEnd, b?.unitStart]).toEqual([0, 2, 2, 3]);
  });

  it('asks the LLM for the structure only when nothing deterministic worked, then summarizes', async () => {
    const pages = Array.from({ length: 8 }, (_, i) =>
      i % 3 === 0
        ? `CHAPTER ON TOPIC ${i}\nThe topic ${i} is described here. ${'x '.repeat(400)}`
        : `plain page ${i} ${'y '.repeat(400)}`,
    );
    const llm = counting(keywordTreeLlm());
    const { tree } = await buildDocumentTree({ pages }, { documentId: 'l', llm });
    expect(tree.structure).toBe('llm');
    expect(tree.nodes.map((node) => node.title)).toEqual([
      'CHAPTER ON TOPIC 0',
      'CHAPTER ON TOPIC 3',
      'CHAPTER ON TOPIC 6',
    ]);
    expect(llm.requests.filter((r) => r.task.kind === 'structure')).toHaveLength(1);
    expect(tree.nodes[0]?.summarySource).toBe('llm');
    expect(tree.description).toContain('CHAPTER ON TOPIC 0');
    expect(tree.stats.llmCalls).toBe(llm.requests.length);
  });

  it('falls back to page groups when the LLM fails, without retrying', async () => {
    const pages = Array.from(
      { length: 23 },
      (_, i) =>
        `Page ${i + 1}\nTopic ${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)} begins\n${'z '.repeat(300)}`,
    );
    const failing = counting(async () => {
      throw new Error('provider down');
    });
    const { tree } = await buildDocumentTree(
      { pages },
      { documentId: 'f', llm: failing, summaries: false, describe: false },
    );
    expect(tree.structure).toBe('flat');
    expect(tree.stats.fallbackReason).toContain('provider down');
    expect(failing.requests).toHaveLength(1);
    expect(tree.nodes[0]?.title).toBe('Pages 1–5: Topic AAA begins');
    expect(tree.nodes.at(-1)?.pageEnd).toBe(23);
  });

  it('never starts LLM structuring that cannot finish within maxStructureCalls', async () => {
    const pages = Array.from({ length: 200 }, (_, i) => `page ${i} ${'w '.repeat(2_000)}`);
    const llm = counting(keywordTreeLlm());
    const { tree } = await buildDocumentTree(
      { pages },
      { documentId: 'big', llm, maxStructureCalls: 3, summaries: false, describe: false },
    );
    expect(tree.structure).toBe('flat');
    expect(llm.requests).toHaveLength(0);
    expect(tree.stats.fallbackReason).toMatch(/structuring calls/);
    // 200 pages / 5 = 40 groups, grouped again under ≤ 12 top-level nodes.
    expect(tree.nodes.length).toBeLessThanOrEqual(12);
    expect(tree.nodes[0]?.children[0]?.pageEnd).toBe(5);
  });

  it('stops at the hard call budget and summarizes the rest from the text', async () => {
    const llm = counting(keywordTreeLlm());
    const { tree } = await buildDocumentTree(
      { pages: regulation() },
      { documentId: 'b', llm, budget: { maxCalls: 3 }, summaryMinChars: 10 },
    );
    expect(llm.requests.length).toBe(3);
    expect(tree.stats.llmCalls).toBe(3);
    expect(tree.stats.budgetExhausted).toBe(true);
    expect(tree.stats.fallbackReason).toMatch(/budget/);
    const sources = [...walkTree(tree.nodes)].map(({ node }) => node.summarySource);
    expect(sources.filter((source) => source === 'llm')).toHaveLength(3);
    expect(sources.every((source) => source !== undefined)).toBe(true);
    // Top levels are summarized first.
    expect(tree.nodes.every((node) => node.summarySource === 'llm')).toBe(true);
  });

  it('enforces the token budget and the timeout', async () => {
    const llm = counting(keywordTreeLlm());
    const tokens = await buildDocumentTree(
      { pages: regulation() },
      { documentId: 't', llm, budget: { maxInputTokens: 1_500 }, summaryMinChars: 10 },
    );
    expect(tokens.tree.stats.inputTokens).toBeLessThanOrEqual(1_500);
    expect(tokens.tree.stats.budgetExhausted).toBe(true);

    const hanging: TreeLlm = (request) =>
      new Promise((_, reject) =>
        request.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const started = Date.now();
    const timed = await buildDocumentTree(
      { pages: Array.from({ length: 6 }, (_, i) => `p${i} ${'q '.repeat(500)}`) },
      { documentId: 'h', llm: hanging, budget: { timeoutMs: 100 } },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(timed.tree.structure).toBe('flat');
    expect(timed.tree.stats.budgetExhausted).toBe(true);
  });

  it('is deterministic, skips unchanged input, and re-summarizes only changed sections', async () => {
    const llm = counting(keywordTreeLlm());
    const options = { documentId: 'd', llm, summaryMinChars: 10 };
    const first = await buildDocumentTree({ pages: regulation() }, options);
    const again = await buildDocumentTree({ pages: regulation() }, options);
    expect(strip(again.tree)).toEqual(strip(first.tree));

    const calls = llm.requests.length;
    const unchanged = await buildDocumentTree(
      { pages: regulation() },
      { ...options, previous: first.tree },
    );
    expect(unchanged.unchanged).toBe(true);
    expect(llm.requests.length).toBe(calls);

    const edited = regulation();
    edited[31] = `${edited[31]} An amended sentence.`;
    const rebuilt = await buildDocumentTree(
      { pages: edited },
      { ...options, previous: first.tree },
    );
    expect(rebuilt.unchanged).toBe(false);
    const summarized = llm.requests.slice(calls).filter((r) => r.task.kind === 'summarize');
    // Only the edited clause, its subpart, its part — plus the document description.
    expect(summarized.map((r) => (r.task as { title: string }).title)).toEqual([
      'Part 3 — Payments',
      'Prompt payment interest',
      'Clause 12: Prompt payment interest (remedies)',
    ]);
    expect(rebuilt.tree.stats.reusedSummaries).toBeGreaterThan(10);
  });

  it('caps the depth, keeping the dropped titles as key items', async () => {
    const { tree } = await buildDocumentTree(
      { pages: regulation() },
      { documentId: 'k', maxDepth: 2 },
    );
    const subpart = tree.nodes[1]?.children[0];
    expect(subpart?.children).toEqual([]);
    expect(subpart?.keyItems).toEqual([
      'Clause 5: Material and workmanship (scope)',
      'Clause 6: Material and workmanship (remedies)',
    ]);
  });
});

describe('indexDocumentTree', () => {
  it('skips short documents (removing a stale tree) and reports unchanged ones', async () => {
    const store = new MemoryDocumentTreeStore();
    const built = await indexDocumentTree(
      { pages: regulation() },
      { store, documentId: 'r', minUnits: 20 },
    );
    expect(built.status).toBe('built');
    const unchanged = await indexDocumentTree(
      { pages: regulation() },
      { store, documentId: 'r', minUnits: 20 },
    );
    expect(unchanged.status).toBe('unchanged');
    const moved = await indexDocumentTree(
      { pages: regulation() },
      { store, documentId: 'r', minUnits: 20, metadata: { tenant: 't2' } },
    );
    expect(moved.status).toBe('unchanged');
    expect((await store.get('r'))?.metadata).toEqual({ tenant: 't2' });

    const skipped = await indexDocumentTree(
      { pages: ['short'] },
      { store, documentId: 'r', minUnits: 20 },
    );
    expect(skipped.status).toBe('skipped');
    expect(await store.get('r')).toBeUndefined();
  });
});

async function seededStore() {
  const store = new MemoryDocumentTreeStore();
  await indexDocumentTree(
    { pages: regulation(), title: 'Construction Regulation' },
    { store, documentId: 'reg', minUnits: 1, metadata: { tenant: 't1' }, source: 'reg.pdf' },
  );
  await indexDocumentTree(
    {
      pages: [
        '# Travel policy\nEmployees book travel through the portal.',
        '# Expenses\nMeals are reimbursed up to a daily limit.',
        '# Laptops\nLaptops are refreshed every three years.',
      ],
      title: 'Handbook',
    },
    { store, documentId: 'handbook', minUnits: 1, metadata: { tenant: 't1' } },
  );
  await indexDocumentTree(
    { pages: regulation(), title: 'Other tenant regulation' },
    { store, documentId: 'other', minUnits: 1, metadata: { tenant: 't2' } },
  );
  return store;
}

describe('TreeNavigationRetriever', () => {
  it('navigates in one pass and returns section text with the path and reasoning', async () => {
    const store = await seededStore();
    const llm = counting(keywordTreeLlm());
    const navigator = new TreeNavigationRetriever({ store, llm, maxNodes: 1 });
    const result = await navigator.navigate('warranty of construction remedies', ['reg']);
    const [navigation] = result.documents;
    expect(navigation?.mode).toBe('single-pass');
    expect(navigation?.llmCalls).toBe(1);
    expect(navigation?.nodes[0]?.path.map((step) => step.title)).toEqual([
      'Part 2 — Construction',
      'Warranty of construction',
      'Clause 8: Warranty of construction (remedies)',
    ]);
    expect(navigation?.steps[0]?.reasoning).toBe('keyword overlap');
    const [passage] = result.passages;
    expect(passage?.id).toBe(`reg#node:${navigation?.nodes[0]?.nodeId}`);
    expect(passage?.text).toContain('warranty of construction requirement 2');
    expect(passage?.text).toContain('Continuation of clause 8');
    expect(passage?.source).toBe('reg.pdf');
    expect(passage?.metadata).toMatchObject({
      tenant: 't1',
      documentId: 'reg',
      pageStart: 21,
      pageEnd: 22,
      retrieval: 'tree-navigation',
    });
  });

  it('walks a large tree level by level (beam), expanding then reading', async () => {
    const store = await seededStore();
    const llm = counting(keywordTreeLlm());
    const navigator = new TreeNavigationRetriever({
      store,
      llm,
      singlePassMaxChars: 200,
      beamWidth: 1,
    });
    const result = await navigator.navigate('payments: prompt interest', ['reg']);
    const [navigation] = result.documents;
    expect(navigation?.mode).toBe('beam');
    expect(navigation?.steps.map((step) => [step.expanded.length, step.read.length])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(navigation?.nodes[0]?.path[0]?.title).toBe('Part 3 — Payments');
    expect(llm.requests.every((request) => request.task.kind === 'navigate')).toBe(true);
    expect(result.passages[0]?.text).toContain('prompt payment interest requirement');
  });

  it('returns what it has when the budget runs out mid-walk', async () => {
    const store = await seededStore();
    const navigator = new TreeNavigationRetriever({
      store,
      llm: keywordTreeLlm(),
      singlePassMaxChars: 200,
      beamWidth: 1,
      budget: { maxCalls: 1 },
    });
    const [navigation] = (await navigator.navigate('payments: prompt interest', ['reg'])).documents;
    expect(navigation?.stoppedBy).toBe('budget');
    expect(navigation?.llmCalls).toBe(1);
    // The part it chose to expand is read whole.
    expect(navigation?.nodes.map((node) => node.title)).toEqual(['Part 3 — Payments']);
  });

  it('records an LLM failure and returns no passages', async () => {
    const store = await seededStore();
    const navigator = new TreeNavigationRetriever({
      store,
      llm: async () => ({ text: 'not json at all' }),
    });
    const result = await navigator.navigate('warranty', ['reg']);
    expect(result.passages).toEqual([]);
    expect(result.documents[0]?.nodes).toEqual([]);
    expect(result.documents[0]?.stoppedBy).toBe('error');
    expect(result.documents[0]?.error).toMatch(/not JSON/);

    const throwing = new TreeNavigationRetriever({
      store,
      llm: async () => {
        throw new Error('boom');
      },
    });
    const failed = await throwing.navigate('warranty', ['reg']);
    expect(failed.documents[0]).toMatchObject({ stoppedBy: 'error', error: 'boom' });
  });

  it('applies the access filter to every tree read (tenant, match-any, empty-array deny)', async () => {
    const store = await seededStore();
    const navigator = new TreeNavigationRetriever({ store, llm: keywordTreeLlm() });
    const denied = await navigator.navigate('warranty', ['other'], { filter: { tenant: 't1' } });
    expect(denied.passages).toEqual([]);
    expect(denied.documents[0]?.stoppedBy).toBe('not-found');
    const anyOf = await navigator.navigate('warranty', ['other'], {
      filter: { tenant: ['t1', 't2'] },
    });
    expect(anyOf.passages.length).toBeGreaterThan(0);
    const deny = await navigator.navigate('warranty', ['reg'], { filter: { tenant: [] } });
    expect(deny.passages).toEqual([]);
    expect(await store.list({ filter: { tenant: [] } })).toEqual([]);
  });

  it('as a plain Retriever, picks documents with the LLM when more trees match than maxDocuments', async () => {
    const store = await seededStore();
    const llm = counting(keywordTreeLlm());
    const navigator = new TreeNavigationRetriever({ store, llm, maxDocuments: 1 });
    const result = await navigator.search('Handbook laptops refresh', { filter: { tenant: 't1' } });
    expect(result.selection?.selected).toEqual(['handbook']);
    expect(result.selection?.candidates).toBe(2);
    expect(result.passages[0]?.text).toContain('Laptops are refreshed');
    const passages = await navigator.retrieve('Handbook laptops refresh', {
      filter: { tenant: 't1' },
      topK: 1,
    });
    expect(passages).toHaveLength(1);
  });

  it('caps the text handed back', async () => {
    const store = await seededStore();
    const navigator = new TreeNavigationRetriever({
      store,
      llm: keywordTreeLlm(),
      maxPassageChars: 100,
      maxContextChars: 150,
    });
    const result = await navigator.navigate('construction material workmanship warranty', ['reg']);
    const total = result.passages.reduce((sum, passage) => sum + passage.text.length, 0);
    expect(total).toBeLessThanOrEqual(150);
    expect(result.passages[0]?.text.length).toBeLessThanOrEqual(100);
  });
});

describe('TwoStageRetriever', () => {
  function firstStage(passages: Passage[]): Retriever & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      async retrieve(_query, options) {
        calls.push(options);
        return passages;
      },
    };
  }
  const chunk = (id: string, text = id): Passage => ({ id, text, score: 1 });

  it('navigates the long documents among the top hits and keeps short ones as chunks', async () => {
    const store = await seededStore();
    await store.remove('handbook'); // short documents have no tree
    const stage = firstStage([
      chunk('memo#0', 'memo chunk'),
      chunk('reg#4', 'a look-alike clause chunk'),
      chunk('memo#1'),
      chunk('reg#9'),
    ]);
    const seen: string[] = [];
    const retriever = new TwoStageRetriever(
      stage,
      new TreeNavigationRetriever({ store, llm: keywordTreeLlm(), maxNodes: 1 }),
      { onNavigation: (navigation) => seen.push(navigation.documentId) },
    );
    const passages = await retriever.retrieve('warranty of construction remedies', {
      topK: 5,
      filter: { tenant: 't1' },
    });
    expect(passages.map((passage) => passage.id)).toEqual(['memo#0', 'reg#node:0014', 'memo#1']);
    expect(passages[1]?.metadata?.title).toBe('Clause 8: Warranty of construction (remedies)');
    expect(stage.calls[0]).toEqual({ topK: 20, filter: { tenant: 't1' } });
    expect(seen).toEqual(['reg']);
  });

  it('keeps first-stage chunks when navigation finds nothing, and respects considerDocuments', async () => {
    const store = await seededStore();
    const failing = new TreeNavigationRetriever({
      store,
      llm: async () => ({ text: '{"read": []}' }),
    });
    const stage = firstStage([chunk('reg#1'), chunk('reg#2')]);
    const passages = await new TwoStageRetriever(stage, failing).retrieve('q');
    expect(passages.map((passage) => passage.id)).toEqual(['reg#1', 'reg#2']);

    const llm = counting(keywordTreeLlm());
    const narrow = new TwoStageRetriever(
      firstStage([chunk('a#0'), chunk('b#0'), chunk('reg#0')]),
      new TreeNavigationRetriever({ store, llm }),
      { considerDocuments: 2 },
    );
    await narrow.retrieve('warranty');
    expect(llm.requests).toHaveLength(0);
  });
});

describe('createNavigateDocumentTool', () => {
  it('navigates the given document within the caller filter, accepting a chunk id', async () => {
    const store = await seededStore();
    const tool = createNavigateDocumentTool(
      new TreeNavigationRetriever({ store, llm: keywordTreeLlm(), maxNodes: 1 }),
      { filter: (context) => ({ tenant: context.actor.tenantRef }) },
    );
    expect(tool.spec.name).toBe('navigate_document');
    const found = (await tool.handler.execute(
      { documentId: 'reg#17', question: 'material and workmanship scope' },
      ctx('t1'),
    )) as { found: boolean; documentId: string; nodes: { title: string }[]; steps: unknown[] };
    expect(found.found).toBe(true);
    expect(found.documentId).toBe('reg');
    expect(found.nodes[0]?.title).toBe('Clause 5: Material and workmanship (scope)');
    expect(found.steps).toHaveLength(1);

    const hidden = (await tool.handler.execute(
      { documentId: 'reg', question: 'material' },
      ctx('t2'),
    )) as { found: boolean; note: string };
    expect(hidden.found).toBe(false);
    expect(hidden.note).toMatch(/search passages/);
    await expect(tool.handler.execute({ documentId: 1 }, ctx('t1'))).rejects.toThrow();
  });
});

describe('LLM adapters', () => {
  it('parseJsonReply reads bare, fenced and embedded JSON', () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonReply('Sure! {"a":3} hope it helps')).toEqual({ a: 3 });
    expect(parseJsonReply('nothing')).toBeUndefined();
  });

  it('cachedTreeLlm answers a repeated request from the cache', async () => {
    const llm = counting(keywordTreeLlm());
    const cached = cachedTreeLlm(llm);
    const store = new MemoryDocumentTreeStore();
    const options = { store, documentId: 'c', minUnits: 1, llm: cached, summaryMinChars: 10 };
    await indexDocumentTree({ pages: regulation() }, options);
    const calls = llm.requests.length;
    await store.remove('c');
    const rebuilt = await indexDocumentTree({ pages: regulation() }, options);
    expect(llm.requests.length).toBe(calls);
    expect(rebuilt.status).toBe('built');
  });

  it('treeLlmFromModelProvider runs one tool-less turn', async () => {
    const provider = new FakeModelProvider((args) => ({
      text: `echo:${args.messages[0]?.content.length}`,
    }));
    const llm = treeLlmFromModelProvider(provider);
    const reply = await llm({
      task: { kind: 'summarize', title: 't', text: 'x' },
      system: 's',
      prompt: 'hello',
      maxOutputTokens: 10,
      signal: new AbortController().signal,
    });
    expect(reply.text).toBe('echo:5');
    expect(reply.usage?.outputTokens).toBe(6);
  });

  describe('openAiChatTreeLlm', () => {
    let server: Server;
    let base: string;
    let seen: Record<string, unknown>[] = [];
    beforeAll(async () => {
      server = createServer((request: IncomingMessage, response: ServerResponse) => {
        let raw = '';
        request.on('data', (part) => {
          raw += part;
        });
        request.on('end', () => {
          const body = JSON.parse(raw) as Record<string, unknown>;
          seen.push({ ...body, auth: request.headers.authorization });
          if (body.model === 'bad') {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'unknown model' } }));
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              choices: [{ message: { content: '{"read": ["0001"]}' } }],
              usage: { prompt_tokens: 42, completion_tokens: 7 },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    });
    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('posts a chat completion and reports usage; throws HttpModelError on failure', async () => {
      seen = [];
      const llm = openAiChatTreeLlm({ baseUrl: base, model: 'm', apiKey: 'k', jsonMode: true });
      const request: TreeLlmRequest = {
        task: {
          kind: 'navigate',
          query: 'q',
          mode: 'single-pass',
          candidates: [],
          maxNodes: 1,
        },
        system: 'sys',
        prompt: 'p',
        maxOutputTokens: 50,
        signal: new AbortController().signal,
      };
      const reply = await llm(request);
      expect(reply).toEqual({
        text: '{"read": ["0001"]}',
        usage: { inputTokens: 42, outputTokens: 7 },
      });
      expect(seen[0]).toMatchObject({
        model: 'm',
        temperature: 0,
        max_tokens: 50,
        response_format: { type: 'json_object' },
        auth: 'Bearer k',
      });
      await expect(
        openAiChatTreeLlm({ baseUrl: base, model: 'bad' })(request),
      ).rejects.toMatchObject({
        status: 400,
      });
    });
  });
});
