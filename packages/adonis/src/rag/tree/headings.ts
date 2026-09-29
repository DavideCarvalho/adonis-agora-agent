/**
 * Deterministic structure detection — the cheap path that runs before any LLM. Finds headings in
 * page text: markdown headers, and the numbered/keyword headings long structured documents use
 * (`PART 52`, `Subpart 9.1`, `Item 7.`, `52.236-5 Material and Workmanship.`, `3.2 Scope`).
 */

/** A heading found in (or declared for) the document, before nesting. */
export interface DetectedHeading {
  title: string;
  level: number;
  unit: number;
  /** The heading is the first text of its unit, so the previous section ends in the unit before. */
  atUnitStart: boolean;
}

const MARKDOWN = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Keyword headings, with the level each keyword usually sits at. */
const KEYWORD_LEVEL: Record<string, number> = {
  part: 1,
  chapter: 1,
  title: 1,
  appendix: 1,
  annex: 1,
  exhibit: 1,
  schedule: 1,
  subpart: 2,
  article: 2,
  item: 2,
  section: 3,
};

const KEYWORD =
  /^(PART|Part|CHAPTER|Chapter|TITLE|APPENDIX|Appendix|ANNEX|Annex|EXHIBIT|Exhibit|SCHEDULE|Schedule|SUBPART|Subpart|ARTICLE|Article|ITEM|Item|SECTION|Section)\s+([0-9]{1,4}[A-Z]?(?:[.\-–][0-9A-Z]{1,4}){0,3}|[IVXLC]{1,6}|[A-Z])\b\.?(?:\s*[—–:\-.]\s*|\s+)?(.{0,110})$/;

/** `3.2 Scope`, `52.236–5 Material and Workmanship.`, `1.1.4 Definitions` — dotted numbering only. */
const NUMBERED = /^(\d{1,3}(?:\.\d{1,4}){1,4})([-–]\d{1,4})?\.?\s+([A-Z[][^\n]{1,100})$/;

function clean(title: string): string {
  return title
    .replace(/\s+/g, ' ')
    .replace(/[\s.:—–-]+$/, '')
    .trim();
}

/** Does this line look like prose or a table row rather than a heading? */
function looksLikeBody(rest: string): boolean {
  return /(\d\)?|[%$])\s*$/.test(rest) || rest.split(' ').length > 16;
}

/** Words a heading title rarely ends with — a line ending in one is wrapped body text. */
const DANGLING = new Set(
  'a an the of to in for and or as by with on at from that which is are be than under'.split(' '),
);

function dangling(title: string): boolean {
  if (/[,;(]$/.test(title)) {
    return true;
  }
  const last = title.split(/\s+/).pop()?.toLowerCase() ?? '';
  return DANGLING.has(last);
}

/**
 * Detect headings in each unit's text. `markdownOnly` restricts detection to markdown headers (for
 * text you know is markdown, where a numbered line is more likely a list item).
 *
 * Besides running headers (below), it drops **table-of-contents listings**: five or more
 * consecutive keyword/numbered heading lines with no body text between them are a contents page
 * (a regulation part opens with one), not sections — only a leading top-level heading of the run
 * (`PART 2—…`) and its last line (the first real heading, which body text follows) are kept. Markdown headers are explicit and never dropped this way.
 */
export function detectHeadings(texts: readonly string[], markdownOnly = false): DetectedHeading[] {
  const headings: DetectedHeading[] = [];
  let inFence = false;
  /** The current run of consecutive non-markdown heading lines, as indexes into `headings`. */
  let run: { index: number; keyword: boolean }[] = [];
  const dropped = new Set<number>();
  const closeRun = () => {
    if (run.length >= 5) {
      run.forEach((entry, position) => {
        const heading = headings[entry.index];
        // The last line of the run is followed by body text: that one is the real heading the
        // contents page was listing ahead of.
        const keep =
          position === run.length - 1 ||
          (position === 0 && entry.keyword && heading !== undefined && heading.level === 1);
        if (!keep) {
          dropped.add(entry.index);
        }
      });
    }
    run = [];
  };
  texts.forEach((text, unit) => {
    let seenText = false;
    const lines = text.split('\n').map((raw) => raw.trim());
    for (let at = 0; at < lines.length; at++) {
      let line = lines[at] ?? '';
      if (line.startsWith('```')) {
        inFence = !inFence;
        seenText = true;
        closeRun();
        continue;
      }
      if (line === '') {
        continue;
      }
      if (inFence || line.length > 140) {
        seenText = true;
        closeRun();
        continue;
      }
      const atUnitStart = !seenText;
      seenText = true;
      const markdown = MARKDOWN.exec(line);
      if (markdown?.[1] !== undefined && markdown[2] !== undefined) {
        closeRun();
        const title = clean(markdown[2].replace(/\*\*/g, ''));
        if (title !== '') {
          headings.push({ title, level: markdown[1].length, unit, atUnitStart });
        }
        continue;
      }
      if (markdownOnly) {
        continue;
      }
      const candidate = KEYWORD.test(line) || NUMBERED.test(line);
      if (candidate) {
        // A heading hyphenated over lines (`52.236–3 Site Investigation and Condi-` / `tions
        // Affecting the Work.`): join up to two continuation lines.
        for (let joined = 0; joined < 2; joined++) {
          const next = lines[at + 1];
          if (!/[a-z]-$/.test(line) || next === undefined || next === '' || next.length > 80) {
            break;
          }
          line = `${line.slice(0, -1)}${next}`;
          at += 1;
        }
      }
      const keyword = KEYWORD.exec(line);
      if (keyword?.[1] !== undefined && keyword[2] !== undefined) {
        const rest = keyword[3] ?? '';
        const allCaps = keyword[1] === keyword[1].toUpperCase();
        if (
          !looksLikeBody(rest) &&
          !/^[a-z,;)]/.test(rest) &&
          (rest !== '' || allCaps) &&
          !dangling(clean(line))
        ) {
          const level = KEYWORD_LEVEL[keyword[1].toLowerCase()] ?? 2;
          run.push({ index: headings.length, keyword: true });
          headings.push({ title: clean(line), level, unit, atUnitStart });
          continue;
        }
      }
      const numbered = NUMBERED.exec(line);
      if (
        numbered?.[1] !== undefined &&
        numbered[3] !== undefined &&
        !looksLikeBody(numbered[3]) &&
        !dangling(clean(numbered[3]))
      ) {
        // Below the keyword levels: `52.236` is 3, `52.236–5` is 4, `1.1.4` is 4.
        const level = Math.min(6, numbered[1].split('.').length + 1 + (numbered[2] ? 1 : 0));
        run.push({ index: headings.length, keyword: false });
        headings.push({ title: clean(line), level, unit, atUnitStart });
        continue;
      }
      // A body line ends a run of heading lines; a heading-shaped line that was rejected (a contents
      // entry cut mid-title), a short Title Case line (its wrapped second line) or page furniture
      // does not.
      if (!candidate && /[A-Za-z]{3,}/.test(line) && !isPageFurniture(line) && !isTitleCase(line)) {
        closeRun();
      }
    }
  });
  closeRun();
  return dropContentsDuplicates(
    dropRunningHeaders(
      headings.filter((_, index) => !dropped.has(index)),
      texts.length,
    ),
  );
}

/**
 * A numbered title (`19.800 General`, `Subpart 19.8—…`) names one section; seen twice, the earlier
 * one is a contents entry pointing at the later — keep the later. Titles without a number
 * ("General", "Definitions") legitimately repeat and are all kept.
 */
function dropContentsDuplicates(headings: DetectedHeading[]): DetectedHeading[] {
  const last = new Map<string, number>();
  headings.forEach((heading, index) => {
    if (/\d/.test(heading.title)) {
      last.set(heading.title.toLowerCase(), index);
    }
  });
  return headings.filter((heading, index) => {
    const key = heading.title.toLowerCase();
    return !last.has(key) || last.get(key) === index;
  });
}

/** A short line whose longer words are mostly capitalized — a title fragment, not prose. */
function isTitleCase(line: string): boolean {
  if (line.length > 70 || /\.\s*$/.test(line)) {
    return false;
  }
  const words = line.split(/\s+/).filter((word) => /^[A-Za-z]{4,}/.test(word));
  return (
    words.length > 0 && words.filter((word) => /^[A-Z]/.test(word)).length / words.length >= 0.6
  );
}

/** A page number, a running citation line (`48 CFR Ch. 1 (10–1–24 Edition)`) — neither body nor heading. */
function isPageFurniture(line: string): boolean {
  return (
    line.length < 50 &&
    /^[\d\s\-–—.()]*(\d+\s*CFR|Federal Acquisition Regulation|Page \d+)/i.test(line)
  );
}

/**
 * Lines that repeat across many units (running headers/footers, page furniture), digits ignored so
 * `Page 3 of 40` and `Page 4 of 40` count as one. Used to pick meaningful lines for group titles.
 */
export function runningLines(texts: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const seen = new Set<string>();
    for (const raw of text.split('\n')) {
      const key = raw.trim().replace(/\d+/g, '#').toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const threshold = Math.max(3, Math.ceil(texts.length * 0.2));
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([key]) => key));
}

/**
 * Remove running headers/footers: the same title repeated on many units ("PART 52—SOLICITATION
 * PROVISIONS" printed atop every page) is page furniture, not structure. Keeps the first occurrence.
 */
function dropRunningHeaders(headings: DetectedHeading[], unitCount: number): DetectedHeading[] {
  const counts = new Map<string, number>();
  for (const heading of headings) {
    const key = heading.title.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const threshold = Math.max(3, Math.ceil(unitCount * 0.2));
  return headings.filter((heading) => {
    const key = heading.title.toLowerCase();
    if ((counts.get(key) ?? 0) >= threshold) {
      if (seen.has(key)) {
        return false;
      }
    }
    seen.add(key);
    return true;
  });
}
