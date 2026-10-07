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
  const prose = (source: string) =>
    source
      .split('\n')
      .map((row) => line(row, dialect))
      .join('\n');
  for (const match of text.matchAll(fence)) {
    const index = match.index ?? 0;
    out += prose(text.slice(last, index));
    out += dialect.pre(match[1] ?? '', match[2] ?? '');
    last = index + match[0].length;
  }
  return out + prose(text.slice(last));
}
