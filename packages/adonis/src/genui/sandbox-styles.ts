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
  /** Most class names listed. Default: all of them (they are written as patterns). */
  maxClasses?: number;
  /** Most class names listed per family (`btn`, `col`…). Default: all of them. */
  maxPerFamily?: number;
  /**
   * Most characters the families' patterns take, so the prompt stays small whatever the stylesheet;
   * the rarest families go first. Default 12000.
   */
  maxChars?: number;
  /** Most custom properties listed. Default 80. */
  maxVars?: number;
}

/** A generated (CSS-modules) name: `_button_x1y2z_3`, `Button_root__a1B2c`. */
const HASHED_CLASS = /(^_[\w-]+_[a-zA-Z0-9]{5,}(_\d+)?$)|(__[a-zA-Z0-9_-]{5}$)/;

/** Whether a class name is a generated (CSS-modules) one — nobody can write it by hand. */
export function isGeneratedClassName(name: string): boolean {
  return HASHED_CLASS.test(name);
}

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
  const maxClasses = options.maxClasses ?? Number.POSITIVE_INFINITY;
  const maxPerFamily = options.maxPerFamily ?? Number.POSITIVE_INFINITY;
  const maxChars = options.maxChars ?? 12000;
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
  const orderedFamilies = [...families.entries()].sort(
    (a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]),
  );
  // Each family as patterns; families of the same shape (`m-{0..5,auto}`, `mt-{0..5,auto}`…) as one.
  const shaped: { name: string; members: string[]; classes: string[]; count: number }[] = [];
  const byShape = new Map<string, (typeof shaped)[number]>();
  let counted = 0;
  for (const [name, entry] of orderedFamilies) {
    if (counted >= maxClasses) break;
    const names = entry.names.slice(0, Math.min(maxPerFamily, maxClasses - counted));
    counted += names.length;
    const classes = compressClassNames(names);
    // A family of one bare class (`active`, `show`) keeps its own entry.
    const own =
      classes.some((each) => each !== name) &&
      classes.every((each) => each === name || each.startsWith(`${name}-`));
    const shape = own ? classes.map((each) => `\u0000${each.slice(name.length)}`).join(' ') : '';
    const same = shape === '' ? undefined : byShape.get(shape);
    if (same !== undefined) {
      same.members.push(name);
      same.count += names.length;
      continue;
    }
    const group = { name, members: [name], classes, count: names.length };
    shaped.push(group);
    if (shape !== '') byShape.set(shape, group);
  }
  const groups: CssVocabulary['groups'] = [];
  let listed = 0;
  let chars = 0;
  for (const group of shaped) {
    let { name, classes } = group;
    if (group.members.length > 1) {
      name = renderAlternatives(group.members);
      classes = classes.map((each) => `${name}${each.slice((group.members[0] as string).length)}`);
    }
    const size = name.length + classes.reduce((sum, each) => sum + each.length + 1, 4);
    if (chars + size > maxChars) continue;
    chars += size;
    listed += group.count;
    groups.push({ name, classes });
  }
  const vars = Object.keys(themeVarsFromCss(css, { rootOnly: true })).slice(0, maxVars);
  return { groups, total: score.size, listed, vars };
}

/** One alternative set rendered: `{0..5}`, `{0..5,auto}`, `{m,p}{,t,b}`, `{primary,secondary}`. */
function renderAlternatives(alternatives: readonly string[]): string {
  if (alternatives.length === 1) return alternatives[0] as string;
  const numbers = alternatives
    .filter((each) => /^(0|[1-9]\d{0,3})$/.test(each))
    .map(Number)
    .sort((a, b) => a - b);
  const others = alternatives.filter((each) => !/^(0|[1-9]\d{0,3})$/.test(each));
  const runs: string[] = [];
  for (let index = 0; index < numbers.length; ) {
    let end = index;
    while (end + 1 < numbers.length && numbers[end + 1] === (numbers[end] as number) + 1) end++;
    if (end - index >= 2) runs.push(`${numbers[index]}..${numbers[end]}`);
    else for (let each = index; each <= end; each++) runs.push(String(numbers[each]));
    index = end + 1;
  }
  // Short words sharing their first letter (`m mt mb`: `m{,t,b}`), or their tails too
  // (`m mt p pt`: `{m,p}{,t}`).
  if (
    numbers.length === 0 &&
    others.length >= 3 &&
    others.every((each) => /^[a-z]{1,4}$/.test(each))
  ) {
    const tails = new Map<string, string[]>();
    for (const each of others) {
      const head = each.slice(0, 1);
      tails.set(head, [...(tails.get(head) ?? []), each.slice(1)]);
    }
    const lists = [...tails.values()].map((list) => list.join(','));
    if (tails.size === 1) return `${[...tails.keys()][0]}{${lists[0]}}`;
    if (lists.every((list) => list === lists[0]))
      return `{${[...tails.keys()].join(',')}}{${lists[0]}}`;
  }
  return `{${[...runs, ...others].join(',')}}`;
}

/**
 * Class names written as patterns, every name covered exactly once and nothing else: names with the
 * same number of `-segments` that differ in one segment merge into one pattern (`btn-primary`,
 * `btn-secondary` → `btn-{primary,secondary}`), again and again, segment by segment from the last —
 * so a utility family becomes one line (`{m,p}{,t,b,s,e,x,y}-{0..5,auto}`,
 * `{m,p}{,t,b,s,e,x,y}-{sm,md,lg,xl,xxl}-{0..5,auto}`). A run of three or more integers is a range
 * (`{0..5}`); short words sharing their tails share them (`{m,p}{,t,b}`). Order kept (the first
 * member's place).
 */
export function compressClassNames(names: readonly string[]): string[] {
  const byLength = new Map<number, { order: number; segments: string[][] }[]>();
  names.forEach((name, order) => {
    const segments = name.split('-').map((segment) => [segment]);
    const list = byLength.get(segments.length) ?? [];
    list.push({ order, segments });
    byLength.set(segments.length, list);
  });
  const patterns: { order: number; segments: string[][] }[] = [];
  for (const [length, start] of byLength) {
    let list = start;
    // Bare words (`alert`, `fade`) are names of their own, never alternatives of each other.
    for (let changed = length > 1; changed; ) {
      changed = false;
      for (let position = length - 1; position >= 0; position--) {
        const merged = new Map<string, { order: number; segments: string[][] }>();
        for (const pattern of list) {
          const key = pattern.segments
            .map((alternatives, index) => (index === position ? '*' : alternatives.join(',')))
            .join('\u0000');
          const into = merged.get(key);
          if (into === undefined) {
            merged.set(key, {
              order: pattern.order,
              segments: pattern.segments.map((a) => [...a]),
            });
            continue;
          }
          changed = true;
          into.order = Math.min(into.order, pattern.order);
          const target = into.segments[position] as string[];
          for (const alternative of pattern.segments[position] as string[])
            if (!target.includes(alternative)) target.push(alternative);
        }
        list = [...merged.values()];
      }
    }
    patterns.push(...list);
  }
  return patterns
    .sort((a, b) => a.order - b.order)
    .map((pattern) => pattern.segments.map(renderAlternatives).join('-'));
}

/** The vocabulary as the model reads it (inside the sandbox description). */
export function vocabularyToModelText(
  vocabulary: CssVocabulary,
  options: { jsx?: boolean } = {},
): string {
  const attribute = options.jsx === true ? 'className (in JSX) or class (in html)' : 'class="…"';
  const lines = [
    `The app's stylesheet is loaded in the frame. Style the view with ITS classes (${attribute}) instead of writing your own CSS — write css only for layout it does not cover. The classes it defines, by family, most used first (a{b,c} means ab and ac; {0..3} means 0, 1, 2 and 3):`,
  ];
  // Families of one bare class (`active`, `show`, `lead`) share one line, where the first one ranks.
  const bare = vocabulary.groups.filter(
    (group) => group.classes.length === 1 && group.classes[0] === group.name,
  );
  let bareLine = false;
  for (const group of vocabulary.groups) {
    if (bare.includes(group)) {
      if (!bareLine) lines.push(`- ${bare.map((each) => each.name).join(' ')}`);
      bareLine = true;
      continue;
    }
    // Families merged into one pattern are named by it: their classes say it already.
    lines.push(
      group.name.includes('{')
        ? `- ${group.classes.join(' ')}`
        : `- ${group.name}: ${group.classes.join(' ')}`,
    );
  }
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
    'Tailwind CSS utility classes work in the frame, offline — the app\'s own Tailwind theme, compiled live for whatever classes you write (className="flex gap-2 p-4 rounded-lg bg-card text-card-foreground"). Prefer them to custom CSS; w-full for the full width of the frame.',
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
// Purging
// ---------------------------------------------------------------------------------------------

/** Where in a stylesheet {@link purgeCss} may drop rules. */
export type PurgeScope = 'utilities' | 'all';

export interface PurgeCssOptions {
  /** Whether a class name (unescaped: `hover:bg-primary/90`) is kept. */
  keep(className: string): boolean;
  /**
   * `'utilities'`: only style rules inside `@layer utilities` (Tailwind v4's compiled output — the
   * frame's runtime generates whatever utility the model writes, so only those the kit itself uses
   * must ship); `'all'`: every style rule.
   */
  scope: PurgeScope;
}

/** Split a selector list on its top-level commas (not those inside `()` / `[]` / strings). */
function splitSelectorList(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < prelude.length; index++) {
    const c = prelude[index];
    if (c === '\\') index++;
    else if (c === '"' || c === "'") {
      const close = prelude.indexOf(c, index + 1);
      index = close < 0 ? prelude.length : close;
    } else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(prelude.slice(start, index));
      start = index + 1;
    }
  }
  out.push(prelude.slice(start));
  return out;
}

/** CSS identifier escapes undone: `hover\:bg-x` → `hover:bg-x`, `\31 0` → `10`. */
function unescapeCssIdent(ident: string): string {
  return ident.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_all, escaped: string) =>
    /^[0-9a-fA-F]{1,6}\s?$/.test(escaped)
      ? String.fromCodePoint(Number.parseInt(escaped.trim(), 16))
      : escaped,
  );
}

/**
 * The classes a complex selector REQUIRES — those outside functional pseudo-classes (`:not(.x)`,
 * `:is(.a, .b)`, `:where(…)`, `:has(…)`), whose classes do not all have to be on the page — unescaped.
 */
function requiredClasses(selector: string): string[] {
  let outer = '';
  let depth = 0;
  for (let index = 0; index < selector.length; index++) {
    const c = selector[index] as string;
    if (c === '\\') {
      if (depth === 0) outer += selector.slice(index, index + 2);
      index++;
    } else if (c === '"' || c === "'") {
      const close = selector.indexOf(c, index + 1);
      index = close < 0 ? selector.length : close;
      if (depth === 0) outer += '""';
    } else if (c === '[') {
      const close = selector.indexOf(']', index + 1);
      index = close < 0 ? selector.length : close;
      if (depth === 0) outer += '[]';
    } else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) outer += c;
  }
  const out: string[] = [];
  for (const match of outer.matchAll(/\.((?:\\[0-9a-fA-F]{1,6}\s?|\\[\s\S]|[\w-])+)/g))
    out.push(unescapeCssIdent(match[1] as string));
  return out;
}

/**
 * A compiled stylesheet with the style rules nobody can use taken out: a rule (or one selector of
 * its list) goes when a class it requires is not kept (`options.keep`). Rules without classes (the
 * base: elements, `:root`, `*`), `@font-face`, `@keyframes`, `@property` and every other at-rule
 * stay; grouping at-rules (`@media`, `@supports`, `@layer`…) left empty go too.
 */
export function purgeCss(css: string, options: PurgeCssOptions): string {
  const walk = (text: string, candidate: boolean): string => {
    let out = '';
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const c = text[index];
      if (c === '"' || c === "'") {
        const close = text.indexOf(c, index + 1);
        index = close < 0 ? text.length : close;
      } else if (c === ';') {
        // A statement (`@layer theme, base;`, `@import …;`, `@charset …;`): kept as it is.
        out += text.slice(start, index + 1);
        start = index + 1;
      } else if (c === '}') {
        start = index + 1;
      } else if (c === '{') {
        const prelude = text.slice(start, index);
        const trimmed = prelude.trim();
        const end = blockEnd(text, index);
        const body = text.slice(index + 1, end);
        if (trimmed.startsWith('@')) {
          if (GROUPING_AT_RULES.test(trimmed)) {
            const inner = walk(
              body,
              candidate || options.scope === 'all' || /^@layer\s+utilities\b/i.test(trimmed),
            );
            if (inner.trim() !== '') out += `${prelude}{${inner}}`;
          } else out += `${prelude}{${body}}`;
        } else if (!candidate || body.includes('{')) {
          out += `${prelude}{${body}}`;
        } else {
          const kept = splitSelectorList(prelude).filter((selector) =>
            requiredClasses(selector).every((name) => options.keep(name)),
          );
          if (kept.length > 0) out += `${kept.join(',')}{${body}}`;
        }
        index = end;
        start = end + 1;
      }
    }
    return out + text.slice(start);
  };
  return walk(stripComments(css), options.scope === 'all');
}

/**
 * The class-like tokens of a source text (a kit bundle): every run of characters between quotes,
 * backticks, whitespace and template braces — a superset of the class names it can put on an
 * element (`"inline-flex hover:bg-primary/90"` → `inline-flex`, `hover:bg-primary/90`).
 */
export function classTokensOf(source: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of source.split(/[\s"'`]|\$\{|\\[nrt]/)) {
    if (raw === '' || raw.length > 200) continue;
    tokens.add(raw);
    const trimmed = raw.replace(/^[{(,;]+|[,;)}]+$/g, '');
    if (trimmed !== raw && trimmed !== '') tokens.add(trimmed);
  }
  return tokens;
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
