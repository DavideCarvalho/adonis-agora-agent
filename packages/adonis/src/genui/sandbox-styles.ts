/**
 * The app's stylesheet as the model learns it — the isomorphic half of `genuiSandboxKit({ styles })`:
 *
 * - Tailwind: the theme tokens, utilities and variants the app's Tailwind directives declare
 *   (`@theme`, `@utility`, `@custom-variant`), and a Tailwind v3 config's theme as a v4 `@theme`
 *   (the frame runs the v4 browser runtime);
 * - any other CSS (plain, Sass, Less, Bootstrap…): its vocabulary — the class names it defines,
 *   grouped and deduplicated, the most used first, and the custom properties on its root;
 * - `url()`s turned into `data:` URIs (the frame has no network), within a size budget.
 *
 * Everything here is pure: the Node side (`genui/kit/styles.ts`) reads and compiles the files.
 */
import { themeVarsFromCss } from './sandbox-theme.js';

// ---------------------------------------------------------------------------------------------
// A small CSS walker: the style rules' selectors, and the at-rules they sit in.
// ---------------------------------------------------------------------------------------------

/** At-rules whose block holds more rules (their selectors count); the others' blocks are skipped. */
const GROUPING_AT_RULES = /^@(media|supports|layer|container|scope|document|starting-style)\b/i;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The index of the `}` closing the block opened at `open` (strings skipped). */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index++) {
    const c = css[index];
    if (c === '"' || c === "'") {
      const close = css.indexOf(c, index + 1);
      index = close < 0 ? css.length : close;
    } else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return css.length;
}

/** Every style rule's selector text, at any depth of grouping at-rules. */
function forEachSelector(css: string, visit: (selector: string, body: string) => void): void {
  const walk = (text: string) => {
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const c = text[index];
      if (c === '"' || c === "'") {
        const close = text.indexOf(c, index + 1);
        index = close < 0 ? text.length : close;
      } else if (c === ';' || c === '}') {
        start = index + 1;
      } else if (c === '{') {
        const prelude = text.slice(start, index).trim();
        const end = blockEnd(text, index);
        const body = text.slice(index + 1, end);
        if (prelude.startsWith('@')) {
          if (GROUPING_AT_RULES.test(prelude)) walk(body);
        } else if (prelude !== '') visit(prelude, body);
        index = end;
        start = end + 1;
      }
    }
  };
  walk(stripComments(css));
}

// ---------------------------------------------------------------------------------------------
// Vocabulary (non-Tailwind CSS)
// ---------------------------------------------------------------------------------------------

/** A stylesheet's class names as the model reads them. */
export interface CssVocabulary {
  /** Families of classes, the most used first: `{ name: 'btn', classes: ['btn', 'btn-{primary,secondary}'] }`. */
  groups: { name: string; classes: string[] }[];
  /** How many distinct class names the stylesheet defines. */
  total: number;
  /** How many of them `groups` lists (the rest were over the cap). */
  listed: number;
  /** Custom properties declared on its root (`:root`, `html`, `[data-theme]`, `.dark`…). */
  vars: string[];
}

export interface CssVocabularyOptions {
  /** Most class names listed. Default 600. */
  maxClasses?: number;
  /** Most class names listed per family (`btn`, `col`…), so utilities do not crowd out components. Default 30. */
  maxPerFamily?: number;
  /** Most custom properties listed. Default 80. */
  maxVars?: number;
}

/** A generated (CSS-modules) name: `_button_x1y2z_3`, `Button_root__a1B2c`. */
const HASHED_CLASS = /(^_[\w-]+_[a-zA-Z0-9]{5,}(_\d+)?$)|(__[a-zA-Z0-9_-]{5}$)/;

/** The class names a selector names (escaped ones — `md\:flex` — and those in attribute values left out). */
function selectorClasses(selector: string): string[] {
  const clean = selector.replace(/\[[^\]]*\]/g, '[]').replace(/"[^"]*"|'[^']*'/g, '""');
  const out: string[] = [];
  for (const match of clean.matchAll(/\.((?:-?[_a-zA-Z]|--)[_a-zA-Z0-9-]*)(\\?)/g)) {
    if (match[2] === '\\') continue;
    out.push(match[1] as string);
  }
  return out;
}

/**
 * What a stylesheet gives the model to write with: its class names, grouped into families
 * (`btn`, `card`, `form`…) and compressed (`btn-{primary,secondary,danger}`), the most used first —
 * a class counts once per selector it appears in, and twice more where it stands alone (`.btn {`,
 * a component's root) — plus the custom properties on its root. Generated CSS-modules names are
 * left out (nobody can write them).
 */
export function extractCssVocabulary(
  css: string,
  options: CssVocabularyOptions = {},
): CssVocabulary {
  const maxClasses = options.maxClasses ?? 600;
  const maxPerFamily = options.maxPerFamily ?? 30;
  const maxVars = options.maxVars ?? 80;
  const score = new Map<string, number>();
  forEachSelector(css, (selectorList) => {
    for (const selector of selectorList.split(',')) {
      const trimmed = selector.trim();
      const classes = selectorClasses(trimmed);
      const alone = classes.length === 1 && /^\.[_a-zA-Z0-9-]+$/.test(trimmed);
      for (const name of new Set(classes)) {
        if (HASHED_CLASS.test(name)) continue;
        score.set(name, (score.get(name) ?? 0) + 1 + (alone ? 2 : 0));
      }
    }
  });
  const family = (name: string) => name.replace(/^[-_]+/, '').split(/-|__/)[0] || name;
  const families = new Map<string, { score: number; names: string[] }>();
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [name, value] of ranked) {
    const key = family(name);
    const entry = families.get(key) ?? { score: 0, names: [] };
    // A family ranks by its most used member (a component's root, `.btn`), not by its size — a
    // utility family with a class per breakpoint and step is large, not important.
    entry.score = Math.max(entry.score, value);
    entry.names.push(name);
    families.set(key, entry);
  }
  const groups: CssVocabulary['groups'] = [];
  let listed = 0;
  const orderedFamilies = [...families.entries()].sort(
    (a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]),
  );
  for (const [name, entry] of orderedFamilies) {
    if (listed >= maxClasses) break;
    const names = entry.names.slice(0, Math.min(maxPerFamily, maxClasses - listed));
    listed += names.length;
    groups.push({ name, classes: compressClassNames(names) });
  }
  const vars = Object.keys(themeVarsFromCss(css, { rootOnly: true })).slice(0, maxVars);
  return { groups, total: score.size, listed, vars };
}

/**
 * Class names sharing everything but their last `-segment`, written once: `btn-primary`,
 * `btn-secondary` → `btn-{primary,secondary}`. Order kept (the first member's place).
 */
export function compressClassNames(names: readonly string[]): string[] {
  const stemOf = (name: string) => {
    const cut = name.lastIndexOf('-');
    return cut > 0 && cut < name.length - 1 ? name.slice(0, cut) : undefined;
  };
  const byStem = new Map<string, string[]>();
  for (const name of names) {
    const stem = stemOf(name);
    if (stem === undefined) continue;
    byStem.set(stem, [...(byStem.get(stem) ?? []), name]);
  }
  const out: string[] = [];
  const done = new Set<string>();
  for (const name of names) {
    const stem = stemOf(name);
    const siblings = stem === undefined ? undefined : byStem.get(stem);
    if (stem === undefined || siblings === undefined || siblings.length < 2) {
      out.push(name);
      continue;
    }
    if (done.has(stem)) continue;
    done.add(stem);
    out.push(`${stem}-{${siblings.map((each) => each.slice(stem.length + 1)).join(',')}}`);
  }
  return out;
}

/** The vocabulary as the model reads it (inside the sandbox description). */
export function vocabularyToModelText(
  vocabulary: CssVocabulary,
  options: { jsx?: boolean } = {},
): string {
  const attribute = options.jsx === true ? 'className (in JSX) or class (in html)' : 'class="…"';
  const lines = [
    `The app's stylesheet is loaded in the frame. Style the view with ITS classes (${attribute}) instead of writing your own CSS — write css only for layout it does not cover. The classes it defines, by family, most used first (a{b,c} means ab and ac):`,
  ];
  for (const group of vocabulary.groups) lines.push(`- ${group.name}: ${group.classes.join(' ')}`);
  if (vocabulary.total > vocabulary.listed)
    lines.push(`(${vocabulary.total - vocabulary.listed} rarer classes not listed.)`);
  if (vocabulary.vars.length > 0)
    lines.push(
      `Its custom properties, for your own css: ${vocabulary.vars.map((name) => `var(${name})`).join(', ')}.`,
    );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Tailwind
// ---------------------------------------------------------------------------------------------

/** Whether a stylesheet's source uses Tailwind, and which major version it reads as. */
export function tailwindVersionOf(source: string): 3 | 4 | null {
  const text = stripComments(source);
  if (/@import\s+(url\()?\s*["']tailwindcss(\/[^"']*)?["']/.test(text)) return 4;
  if (/@(theme|custom-variant|utility|plugin|source)\b/.test(text)) return 4;
  if (/\/\*!\s*tailwindcss v4/.test(source)) return 4;
  if (/@tailwind\s+(base|components|utilities|variants|screens)\b/.test(text)) return 3;
  if (/\/\*!\s*tailwindcss v3/.test(source)) return 3;
  return null;
}

/**
 * The Tailwind directives of an app stylesheet the frame's Tailwind runtime gets too: its
 * `@custom-variant`s, `@utility`s, `@variant`s and `@theme` blocks (`@keyframes` inside them
 * included) — not its `@import`s, `@source`s, `@plugin`s or base styles (those reach the frame
 * compiled).
 */
export function tailwindDirectivesFromCss(css: string): string {
  const text = stripComments(css);
  const out: string[] = [];
  const directive = /@(custom-variant|utility|theme)\b/g;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const c = text[index];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '@' && depth === 0) {
      directive.lastIndex = index;
      const match = directive.exec(text);
      if (match === null || match.index !== index) continue;
      // One statement (`@custom-variant dark (&:where(.dark *));`) or one balanced block.
      let end = index;
      let inner = 0;
      for (; end < text.length; end++) {
        const ch = text[end];
        if (ch === ';' && inner === 0) break;
        if (ch === '{') inner++;
        else if (ch === '}') {
          inner--;
          if (inner === 0) break;
        }
      }
      out.push(text.slice(index, end + 1).trim());
      index = end;
    }
  }
  return out.join('\n');
}

/** What the app's Tailwind setup gives the model: theme names, its own utilities and variants. */
export interface TailwindTokens {
  /** `bg-<name>`, `text-<name>`… (`--color-<name>`). */
  colors: string[];
  /** `rounded-<name>` (`--radius-<name>`). */
  radius: string[];
  /** `font-<name>` (`--font-<name>`). */
  fonts: string[];
  /** `shadow-<name>`. */
  shadows: string[];
  /** `text-<name>` sizes (`--text-<name>`). */
  text: string[];
  /** `animate-<name>`. */
  animations: string[];
  /** `@utility` names (`figure`, `tab-*`). */
  utilities: string[];
  /** `@custom-variant` names (`dark`, `data-open`). */
  variants: string[];
}

/** The tokens a Tailwind stylesheet's directives declare (see {@link tailwindDirectivesFromCss}). */
export function tailwindTokensFromCss(css: string): TailwindTokens {
  const tokens: TailwindTokens = {
    colors: [],
    radius: [],
    fonts: [],
    shadows: [],
    text: [],
    animations: [],
    utilities: [],
    variants: [],
  };
  const text = stripComments(css);
  const add = (list: string[], name: string) => {
    if (name !== '' && name !== '*' && !list.includes(name)) list.push(name);
  };
  for (const block of text.matchAll(/@theme\b[^{]*\{/g)) {
    const open = (block.index ?? 0) + block[0].length - 1;
    const body = text.slice(open + 1, blockEnd(text, open));
    for (const match of body.matchAll(/(?:^|[;{\s])--([A-Za-z0-9_-]+)\s*:\s*([^;]*)/g)) {
      const name = match[1] as string;
      if ((match[2] ?? '').trim() === 'initial') continue;
      const pick = (prefix: string, list: string[]) => {
        if (!name.startsWith(prefix)) return false;
        const rest = name.slice(prefix.length);
        if (!rest.includes('--')) add(list, rest);
        return true;
      };
      if (pick('color-', tokens.colors)) continue;
      if (pick('radius-', tokens.radius)) continue;
      if (pick('font-', tokens.fonts)) continue;
      if (pick('shadow-', tokens.shadows)) continue;
      if (pick('text-', tokens.text)) continue;
      pick('animate-', tokens.animations);
    }
  }
  for (const match of text.matchAll(/@utility\s+([A-Za-z0-9_*-]+)/g))
    add(tokens.utilities, match[1] as string);
  for (const match of text.matchAll(/@custom-variant\s+([A-Za-z0-9_-]+)/g))
    add(tokens.variants, match[1] as string);
  return tokens;
}

/** What the model is told about Tailwind in the frame. `colors` may add the host theme's names. */
export function tailwindToModelText(
  tokens: TailwindTokens,
  options: { version?: 3 | 4; colors?: readonly string[] } = {},
): string {
  const colors = [...new Set([...tokens.colors, ...(options.colors ?? [])])];
  const list = (names: readonly string[], max: number) =>
    names.slice(0, max).join(', ') + (names.length > max ? ', …' : '');
  const parts = [
    'Tailwind CSS utility classes work in the frame, offline — the app\'s own Tailwind theme, compiled live for whatever classes you write (className="flex gap-2 p-4 rounded-lg bg-card text-card-foreground"). Prefer them to custom CSS.',
  ];
  if (options.version === 3)
    parts.push(
      'The app is on Tailwind v3, the frame runs v4 with its theme mapped: write v4 names (shadow-xs, rounded-xs, outline-hidden where v3 had shadow-sm, rounded-sm, outline-none).',
    );
  const theme: string[] = [];
  if (colors.length > 0) theme.push(`colors ${list(colors, 40)} (bg-*, text-*, border-*, ring-*)`);
  if (tokens.radius.length > 0) theme.push(`radius rounded-{${list(tokens.radius, 12)}}`);
  if (tokens.fonts.length > 0) theme.push(`fonts font-{${list(tokens.fonts, 8)}}`);
  if (tokens.shadows.length > 0) theme.push(`shadows shadow-{${list(tokens.shadows, 10)}}`);
  if (tokens.text.length > 0) theme.push(`text sizes text-{${list(tokens.text, 14)}}`);
  if (tokens.animations.length > 0)
    theme.push(`animations animate-{${list(tokens.animations, 10)}}`);
  if (theme.length > 0) parts.push(`The app's theme: ${theme.join('; ')}.`);
  if (tokens.utilities.length > 0) parts.push(`Its own utilities: ${list(tokens.utilities, 30)}.`);
  if (tokens.variants.length > 0)
    parts.push(
      `Its variants: ${tokens.variants
        .slice(0, 20)
        .map((name) => `${name}:`)
        .join(', ')}.`,
    );
  return parts.join(' ');
}

type TailwindV3Theme = Record<string, unknown>;

/** `{ primary: { DEFAULT: x, foreground: y } }` → `[['primary', x], ['primary-foreground', y]]`. */
function flattenThemeObject(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string' || typeof value === 'number')
    return prefix === '' ? [] : [[prefix, String(value)]];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const out: [string, string][] = [];
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const name = key === 'DEFAULT' ? prefix : prefix === '' ? key : `${prefix}-${key}`;
    if (name === '') continue;
    out.push(...flattenThemeObject(inner, name));
  }
  return out;
}

function cssName(key: string): string {
  return key.replace(/\./g, '_').replace(/[^A-Za-z0-9_-]/g, '-');
}

function fontStack(value: unknown): string | undefined {
  const list = Array.isArray(value) ? (Array.isArray(value[0]) ? value[0] : value) : [value];
  const names = (list as unknown[]).filter((each): each is string => typeof each === 'string');
  if (names.length === 0) return undefined;
  return names
    .map((name) =>
      /\s/.test(name) && !/^["']/.test(name) && !name.includes('(') ? `"${name}"` : name,
    )
    .join(', ');
}

function keyframesCss(name: string, frames: unknown): string | undefined {
  if (typeof frames !== 'object' || frames === null) return undefined;
  const steps = Object.entries(frames as Record<string, unknown>).map(([step, decls]) => {
    const body = Object.entries((decls ?? {}) as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
      .map(
        ([prop, value]) =>
          `${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${String(value)}`,
      )
      .join('; ');
    return `${step} { ${body} }`;
  });
  return `@keyframes ${cssName(name)} { ${steps.join(' ')} }`;
}

/**
 * A Tailwind v3 config's theme as the v4 directives the frame's runtime reads: colors →
 * `--color-*` (nested shades flattened, `DEFAULT` dropped, `<alpha-value>` → 1), `borderRadius` →
 * `--radius-*`, `fontFamily` → `--font-*`, `fontSize` → `--text-*`, `boxShadow` → `--shadow-*`,
 * `screens` → `--breakpoint-*`, `keyframes`/`animation` → `@keyframes` + `--animate-*` — the
 * `theme` and its `extend` together, function values skipped. `darkMode: 'class'` / `'selector'` /
 * `['class', '<selector>']` becomes a `dark` variant.
 */
export function tailwindV3ConfigToCss(config: unknown): string {
  const cfg = (config ?? {}) as {
    theme?: TailwindV3Theme & { extend?: TailwindV3Theme };
    darkMode?: unknown;
  };
  const theme: TailwindV3Theme = {};
  for (const [key, value] of Object.entries(cfg.theme ?? {}))
    if (key !== 'extend') theme[key] = value;
  for (const [key, value] of Object.entries(cfg.theme?.extend ?? {})) {
    const base = theme[key];
    theme[key] =
      typeof base === 'object' && base !== null && typeof value === 'object' && value !== null
        ? { ...(base as object), ...(value as object) }
        : value;
  }
  const lines: string[] = [];
  const extra: string[] = [];
  const scale = (key: string, prefix: string) => {
    for (const [name, value] of flattenThemeObject(theme[key]))
      lines.push(`--${prefix}-${cssName(name)}: ${value.replace(/<alpha-value>/g, '1')}`);
  };
  scale('colors', 'color');
  scale('borderRadius', 'radius');
  scale('boxShadow', 'shadow');
  scale('screens', 'breakpoint');
  scale('spacing', 'spacing');
  for (const [name, value] of Object.entries((theme.fontFamily ?? {}) as Record<string, unknown>)) {
    const stack = fontStack(value);
    if (stack !== undefined) lines.push(`--font-${cssName(name)}: ${stack}`);
  }
  for (const [name, value] of Object.entries((theme.fontSize ?? {}) as Record<string, unknown>)) {
    const [size, rest] = Array.isArray(value) ? value : [value];
    if (typeof size !== 'string') continue;
    lines.push(`--text-${cssName(name)}: ${size}`);
    const lineHeight =
      typeof rest === 'string' ? rest : (rest as { lineHeight?: unknown } | undefined)?.lineHeight;
    if (typeof lineHeight === 'string')
      lines.push(`--text-${cssName(name)}--line-height: ${lineHeight}`);
  }
  for (const [name, value] of Object.entries((theme.animation ?? {}) as Record<string, unknown>))
    if (typeof value === 'string') lines.push(`--animate-${cssName(name)}: ${value}`);
  for (const [name, frames] of Object.entries((theme.keyframes ?? {}) as Record<string, unknown>)) {
    const css = keyframesCss(name, frames);
    if (css !== undefined) extra.push(css);
  }
  const dark = cfg.darkMode;
  let variant: string | undefined;
  if (dark === 'class' || dark === 'selector') variant = '.dark';
  else if (
    Array.isArray(dark) &&
    (dark[0] === 'class' || dark[0] === 'selector') &&
    typeof dark[1] === 'string'
  )
    variant = dark[1];
  const out: string[] = [];
  if (variant !== undefined) out.push(`@custom-variant dark (&:where(${variant}, ${variant} *));`);
  if (lines.length > 0 || extra.length > 0)
    out.push(
      `@theme {\n${lines.map((line) => `  ${line};`).join('\n')}${extra.length > 0 ? `\n  ${extra.join('\n  ')}` : ''}\n}`,
    );
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// url() inlining
// ---------------------------------------------------------------------------------------------

/** What a `url()` resolves to: its bytes (base64) and type — or why it cannot be inlined. */
export type CssUrlResolution =
  | { data: string; mime: string; bytes: number }
  | { dropped: string }
  | null;

export interface InlineCssUrlsOptions {
  /** The bytes behind a url that is not already `data:` (`null`: unknown, dropped). */
  resolve(url: string): CssUrlResolution;
  /** Largest file inlined, in bytes. Default 128 KB. */
  limit?: number;
  /** Most bytes inlined in all, `data:` URIs already in the CSS included. Default 1 MB. */
  budget?: number;
  /** Told about every url dropped, and why. */
  warn?(message: string): void;
}

export const INLINE_ASSET_DEFAULTS = { limit: 128 * 1024, budget: 1024 * 1024 } as const;

/** `data:` URI payload size in bytes (base64 decoded). */
function dataUriBytes(uri: string): number {
  const comma = uri.indexOf(',');
  const payload = comma < 0 ? '' : uri.slice(comma + 1);
  return /;base64/i.test(uri.slice(0, comma))
    ? Math.floor((payload.length * 3) / 4)
    : payload.length;
}

const EMPTY_URL = 'url("data:,")';

/**
 * Every `url()` of a stylesheet made network-less: `data:` URIs kept (within the budget), files
 * inlined as `data:` URIs when `resolve` finds them and they fit `limit` and `budget`, everything
 * else — remote urls, files too big, files not found — replaced by an empty `data:,` (the browser
 * falls back: the next font in the stack, no background image), each with a warning.
 */
export function inlineCssUrls(css: string, options: InlineCssUrlsOptions): string {
  const limit = options.limit ?? INLINE_ASSET_DEFAULTS.limit;
  const budget = options.budget ?? INLINE_ASSET_DEFAULTS.budget;
  let used = 0;
  const drop = (url: string, why: string) => {
    options.warn?.(`dropped url(${url.length > 80 ? `${url.slice(0, 77)}…` : url}): ${why}`);
    return EMPTY_URL;
  };
  return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/g, (whole, a, b, c) => {
    const url = ((a ?? b ?? c ?? '') as string).trim();
    if (url === '' || url.startsWith('#')) return whole;
    if (/^data:/i.test(url)) {
      const bytes = dataUriBytes(url);
      if (bytes > limit)
        return drop(
          url.slice(0, 40),
          `inlined asset of ${kb(bytes)} is over the ${kb(limit)} limit`,
        );
      if (used + bytes > budget)
        return drop(url.slice(0, 40), `over the ${kb(budget)} budget for inlined assets`);
      used += bytes;
      return whole;
    }
    if (/^blob:/i.test(url)) return whole;
    const found = options.resolve(url);
    if (found === null)
      return drop(url, /^(https?:)?\/\//i.test(url) ? 'the sandbox has no network' : 'not found');
    if ('dropped' in found) return drop(url, found.dropped);
    if (found.bytes > limit) return drop(url, `${kb(found.bytes)} is over the ${kb(limit)} limit`);
    if (used + found.bytes > budget)
      return drop(url, `over the ${kb(budget)} budget for inlined assets`);
    used += found.bytes;
    return `url("data:${found.mime};base64,${found.data}")`;
  });
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}
