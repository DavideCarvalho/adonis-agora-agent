import type { ChannelMarkdown } from './types.js';

/**
 * How one dialect writes each construct. The input is what a turn streams: the model's markdown
 * (GitHub-flavoured: `**bold**`, `_italic_`, `[text](url)`, `# Heading`, fenced code) mixed with
 * component fallback texts, which are Slack mrkdwn (`*bold*`). So a single `*x*` is read as bold —
 * the meaning mrkdwn and WhatsApp give it — never as markdown's italic.
 */
interface Dialect {
  text(value: string): string;
  bold(inner: string): string;
  italic(inner: string): string;
  strike(inner: string): string;
  code(value: string): string;
  pre(language: string, value: string): string;
  link(label: string, url: string): string;
  heading(inner: string): string;
  bullet: string;
  quote(inner: string): string;
}

const TELEGRAM_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escape text for Telegram's MarkdownV2 — every character it reserves gets a backslash. */
export function escapeTelegramMarkdown(value: string): string {
  return value.replace(TELEGRAM_SPECIAL, '\\$&');
}

/** Undo {@link escapeTelegramMarkdown}: what a message reads as plain text when MarkdownV2 is refused. */
export function unescapeTelegramMarkdown(value: string): string {
  return value.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
}

const linkText = (label: string, url: string) =>
  label === '' || label === url ? url : `${label} (${url})`;

const DIALECTS: Record<ChannelMarkdown, Dialect> = {
  whatsapp: {
    text: (value) => value,
    bold: (inner) => `*${inner}*`,
    italic: (inner) => `_${inner}_`,
    strike: (inner) => `~${inner}~`,
    code: (value) => `\`${value}\``,
    pre: (_language, value) => `\`\`\`${value}\`\`\``,
    link: linkText,
    heading: (inner) => `*${inner}*`,
    bullet: '- ',
    quote: (inner) => `> ${inner}`,
  },
  telegram: {
    text: escapeTelegramMarkdown,
    bold: (inner) => `*${inner}*`,
    italic: (inner) => `_${inner}_`,
    strike: (inner) => `~${inner}~`,
    code: (value) => `\`${value.replace(/[`\\]/g, '\\$&')}\``,
    pre: (language, value) => `\`\`\`${language}\n${value.replace(/[`\\]/g, '\\$&')}\`\`\``,
    link: (label, url) =>
      `[${escapeTelegramMarkdown(label === '' ? url : label)}](${url.replace(/[)\\]/g, '\\$&')})`,
    heading: (inner) => `*${inner}*`,
    bullet: '• ',
    quote: (inner) => `>${inner}`,
  },
  none: {
    text: (value) => value,
    bold: (inner) => inner,
    italic: (inner) => inner,
    strike: (inner) => inner,
    code: (value) => value,
    pre: (_language, value) => value,
    link: linkText,
    heading: (inner) => inner,
    bullet: '- ',
    quote: (inner) => `> ${inner}`,
  },
};

/**
 * Inline tokens, earliest first: code, image/link, `**bold**`, `__bold__`, `~~strike~~`, then the
 * single-character forms. A single marker must hug its text (`*a*`, not `* a *`) and must not sit
 * inside a word, so `snake_case` and `2*3*4` stay as written.
 */
const INLINE =
  /`([^`\n]+)`|!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*(?!\s)(.+?)(?<!\s)\*\*|__(?!\s)(.+?)(?<!\s)__|~~(?!\s)(.+?)(?<!\s)~~|(?<![\w*\\])\*(?![\s*])([^*\n]+?)(?<![\s\\])\*(?![\w*])|(?<![\w_\\])_(?![\s_])([^_\n]+?)(?<![\s\\])_(?![\w_])|(?<![\w~\\])~(?![\s~])([^~\n]+?)(?<![\s\\])~(?![\w~])/g;

function inline(source: string, dialect: Dialect): string {
  let out = '';
  let last = 0;
  for (const match of source.matchAll(INLINE)) {
    const index = match.index ?? 0;
    out += dialect.text(source.slice(last, index));
    last = index + match[0].length;
    const [, code, label, url, bold, underscoreBold, strike, starBold, italic, tildeStrike] = match;
    if (code !== undefined) out += dialect.code(code);
    else if (url !== undefined) out += dialect.link(label ?? '', url);
    else if (bold !== undefined) out += dialect.bold(inline(bold, dialect));
    else if (underscoreBold !== undefined) out += dialect.bold(inline(underscoreBold, dialect));
    else if (strike !== undefined) out += dialect.strike(inline(strike, dialect));
    else if (starBold !== undefined) out += dialect.bold(inline(starBold, dialect));
    else if (italic !== undefined) out += dialect.italic(inline(italic, dialect));
    else if (tildeStrike !== undefined) out += dialect.strike(inline(tildeStrike, dialect));
  }
  return out + dialect.text(source.slice(last));
}

function line(source: string, dialect: Dialect): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(source);
  if (heading) {
    // A heading is bold already; markers inside it would nest bold in bold.
    return dialect.heading(inline((heading[1] ?? '').replace(/\*\*|__/g, ''), dialect));
  }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(source)) return '';
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(source);
  if (bullet) return `${bullet[1] ?? ''}${dialect.bullet}${inline(bullet[2] ?? '', dialect)}`;
  const quote = /^\s{0,3}>\s?(.*)$/.exec(source);
  if (quote) return dialect.quote(inline(quote[1] ?? '', dialect));
  return inline(source, dialect);
}

/** A table row: `| a | b |` (outer pipes optional, at least one inner pipe). */
const TABLE_ROW = /^\s{0,3}\|?.*\|.*\|?\s*$/;
/** The row under a table's header: `|---|:--:|`. */
const TABLE_DIVIDER = /^\s{0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * One table row as a bullet — no chat channel draws tables, and the raw pipes arrive as noise. The
 * first cell leads in bold; with two columns the second follows it, with more each cell is named
 * by its header (`*Ana* — Idade: 3; Peso: 14 kg`). Empty cells are left out.
 */
function tableRow(row: string[], header: string[], dialect: Dialect): string {
  const [first = '', ...rest] = row.map((cell) => inline(cell, dialect));
  const lead = first === '' ? '' : dialect.bold(first);
  const values = rest.flatMap((cell, index) => {
    if (cell === '') return [];
    const name = header.length > 2 ? (header[index + 1] ?? '') : '';
    return [name === '' ? cell : `${inline(name, dialect)}: ${cell}`];
  });
  const separator = header.length > 2 ? ' — ' : ': ';
  const body = values.join('; ');
  return dialect.bullet + (lead && body ? `${lead}${separator}${body}` : lead || body);
}

/** A GitHub table found in a turn's text: header cells and body rows, as the model wrote them. */
export interface MarkdownTable {
  header: string[];
  rows: string[][];
}

/** A turn's text cut around its tables (`source` is the table as written, to fall back to). */
export type MarkdownPiece =
  | { kind: 'text'; text: string }
  | { kind: 'table'; table: MarkdownTable; source: string };

/**
 * Cut `text` around its GitHub tables (header, divider, rows), outside fenced code. Text pieces
 * keep their line breaks; the pieces joined back with `\n` are the input.
 */
export function splitTables(text: string): MarkdownPiece[] {
  const rows = text.split('\n');
  const pieces: MarkdownPiece[] = [];
  let prose: string[] = [];
  let fenced = false;
  const flushProse = () => {
    if (prose.length > 0) pieces.push({ kind: 'text', text: prose.join('\n') });
    prose = [];
  };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (/^\s{0,3}```/.test(row)) fenced = !fenced;
    const divider = rows[index + 1];
    if (!fenced && TABLE_ROW.test(row) && divider !== undefined && TABLE_DIVIDER.test(divider)) {
      const start = index;
      const body: string[][] = [];
      index += 2;
      while (index < rows.length && TABLE_ROW.test(rows[index]!)) {
        body.push(cells(rows[index]!));
        index += 1;
      }
      flushProse();
      pieces.push({
        kind: 'table',
        table: { header: cells(row), rows: body },
        source: rows.slice(start, index).join('\n'),
      });
      index -= 1;
      continue;
    }
    prose.push(row);
  }
  flushProse();
  return pieces;
}

/** Every line through {@link line}, except GitHub tables, which become bullet lists. */
function withoutTables(rows: string[], dialect: Dialect): string[] {
  const out: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const divider = rows[index + 1];
    if (TABLE_ROW.test(row) && divider !== undefined && TABLE_DIVIDER.test(divider)) {
      const header = cells(row);
      index += 2;
      while (index < rows.length && TABLE_ROW.test(rows[index]!)) {
        out.push(tableRow(cells(rows[index]!), header, dialect));
        index += 1;
      }
      index -= 1;
      continue;
    }
    out.push(line(row, dialect));
  }
  return out;
}

/**
 * Convert a turn's markdown to what `markdown` renders: WhatsApp's `*bold*` `_italic_` `~strike~`,
 * Telegram's MarkdownV2 (every reserved character escaped), or plain text. Links become
 * `label (url)` where the channel has no link syntax; headings become bold lines.
 */
export function toChannelMarkdown(text: string, markdown: ChannelMarkdown): string {
  const dialect = DIALECTS[markdown];
  const fence = /```([\w+-]*)[^\S\n]*\n?([\s\S]*?)\n?```/g;
  let out = '';
  let last = 0;
  const prose = (source: string) => withoutTables(source.split('\n'), dialect).join('\n');
  for (const match of text.matchAll(fence)) {
    const index = match.index ?? 0;
    out += prose(text.slice(last, index));
    out += dialect.pre(match[1] ?? '', match[2] ?? '');
    last = index + match[0].length;
  }
  return out + prose(text.slice(last));
}
