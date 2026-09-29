import type { TreeLlm, TreeLlmRequest, TreeLlmResponse } from './llm.js';

const STOP = new Set(
  'the and for are was were with that this from which what when where who whom how does did has have had not but its into under over than then there their about any all can may must shall should would could will our your they them his her per each other such only also more most'.split(
    ' ',
  ),
);

function terms(text: string): Set<string> {
  return new Set(
    (
      text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.-]*[\p{L}\p{N}]|[\p{L}\p{N}]{3,}/gu) ?? []
    ).filter((term) => term.length >= 3 && !STOP.has(term)),
  );
}

function overlap(query: Set<string>, text: string): number {
  let score = 0;
  for (const term of terms(text)) {
    if (query.has(term)) {
      score += 1;
    }
  }
  return score;
}

/**
 * A deterministic stand-in for the tree LLM — no model, no network — for tests and offline
 * development. It answers from the structured {@link TreeLlmRequest.task}, never the prose:
 *
 * - `navigate` / `select`: ranks candidates by how many of the question's terms their title and
 *   summary share, keeps those sharing any (deepest first on ties in single-pass mode); in a beam,
 *   candidates with subsections are expanded, the rest read;
 * - `summarize`: the section's first sentence; `describe`: the top-level titles;
 * - `structure`: lines in ALL CAPS (or markdown headers) become level-1 sections.
 *
 * Wrap it to count calls, inject failures or slow replies when testing budgets.
 */
export function keywordTreeLlm(): TreeLlm {
  return async (request: TreeLlmRequest): Promise<TreeLlmResponse> => {
    const { task } = request;
    let text: string;
    switch (task.kind) {
      case 'navigate': {
        const query = terms(task.query);
        const ranked = task.candidates
          .map((candidate, order) => ({
            candidate,
            order,
            score: overlap(query, `${candidate.title} ${candidate.summary ?? ''}`),
          }))
          .filter((entry) => entry.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              (b.candidate.depth ?? 0) - (a.candidate.depth ?? 0) ||
              a.order - b.order,
          )
          .slice(0, task.maxNodes)
          .map((entry) => entry.candidate);
        text =
          task.mode === 'single-pass'
            ? JSON.stringify({ thinking: 'keyword overlap', read: ranked.map((c) => c.id) })
            : JSON.stringify({
                thinking: 'keyword overlap',
                expand: ranked.filter((c) => c.hasChildren).map((c) => c.id),
                read: ranked.filter((c) => !c.hasChildren).map((c) => c.id),
              });
        break;
      }
      case 'select': {
        const query = terms(task.query);
        const ranked = task.documents
          .map((document) => ({
            id: document.id,
            score: overlap(query, `${document.title ?? ''} ${document.description ?? ''}`),
          }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, task.maxDocuments)
          .map((entry) => entry.id);
        text = JSON.stringify({ thinking: 'keyword overlap', documents: ranked });
        break;
      }
      case 'summarize': {
        const flat = task.text.replace(/\s+/g, ' ').trim();
        const sentence = /^.*?[.!?](\s|$)/.exec(flat)?.[0] ?? flat;
        text = `${task.title}: ${sentence.slice(0, 200).trim()}`;
        break;
      }
      case 'describe':
        text = `${task.title ?? 'Document'} covering ${task.outline.map((entry) => entry.title).join(', ')}.`;
        break;
      case 'structure': {
        const sections: { title: string; level: number; unit: number }[] = [];
        for (const unit of task.units) {
          for (const line of unit.text.split('\n')) {
            const trimmed = line.trim();
            const markdown = /^(#{1,6})\s+(.+)$/.exec(trimmed);
            if (markdown?.[1] !== undefined && markdown[2] !== undefined) {
              sections.push({ title: markdown[2], level: markdown[1].length, unit: unit.unit });
            } else if (/^[A-Z][A-Z0-9 ,.'&-]{3,80}$/.test(trimmed) && /[A-Z]{3}/.test(trimmed)) {
              sections.push({ title: trimmed, level: 1, unit: unit.unit });
            }
          }
        }
        text = JSON.stringify({ sections });
        break;
      }
    }
    return {
      text,
      usage: {
        inputTokens: Math.ceil(request.prompt.length / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
    };
  };
}
