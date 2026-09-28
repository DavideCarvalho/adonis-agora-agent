import type { Finding } from '../types.js';

/** `(?i)` prefix = case-insensitive, the one inline flag JavaScript regexes lack. */
function compileFlagged(pattern: string): RegExp {
  return pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'i') : new RegExp(pattern);
}

const compiled = new Map<string, RegExp>();

/** Compiled once per pattern (global flag added), with a bounded cache. */
export function compileGuardPattern(pattern: string): RegExp {
  let re = compiled.get(pattern);
  if (!re) {
    const base = compileFlagged(pattern);
    re = new RegExp(base.source, `${base.flags.replace('g', '')}g`);
    if (compiled.size > 5_000) compiled.clear();
    compiled.set(pattern, re);
  }
  return re;
}

export function detectRegex(
  text: string,
  patterns: readonly string[],
  label = 'custom',
): Finding[] {
  const out: Finding[] = [];
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = compileGuardPattern(p);
    } catch {
      continue;
    }
    re.lastIndex = 0;
    let guard = 0;
    for (let m = re.exec(text); m && guard < 1000; m = re.exec(text), guard++) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push({
        detector: 'regex',
        category: `regex.${label}`,
        start: m.index,
        end: m.index + m[0].length,
        score: 1,
        value: m[0],
        spanned: true,
      });
    }
  }
  return out;
}

const COMBINING = /[\u0300-\u036f]/g;

/** Lower case without accents, keeping string length stable (one output char per input char). */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const base = ch.normalize('NFD').replace(COMBINING, '');
    const c = (base.length === ch.length ? base : ch).toLowerCase();
    out += c.length === ch.length ? c : ch;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case- and accent-insensitive keyword/phrase matching. */
export function detectKeywords(
  text: string,
  words: readonly string[],
  label = 'keywords',
): Finding[] {
  const clean = words.map((w) => fold(w.trim())).filter(Boolean);
  if (clean.length === 0) return [];
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${clean.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`,
    'gu',
  );
  const folded = fold(text);
  const out: Finding[] = [];
  for (let m = re.exec(folded); m; m = re.exec(folded)) {
    out.push({
      detector: 'keywords',
      category: `keywords.${label}`,
      start: m.index,
      end: m.index + m[0].length,
      score: 1,
      value: text.slice(m.index, m.index + m[0].length),
      spanned: true,
    });
  }
  return out;
}
