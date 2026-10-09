/**
 * The app's theme inside the sandbox: the host page's CSS custom properties (`--background`,
 * `--primary`, `--radius`…) read from `:root` and handed to the frame, and — with Tailwind on — an
 * `@theme` that maps them to utilities (`bg-primary`, `text-muted-foreground`, `rounded-lg`).
 *
 * Isomorphic: the browser renderer collects and pushes the values, the server and the Vite plugin
 * only need the names (what the model is told it may use).
 */

/** Custom properties Tailwind and the browser keep for themselves — never the app's theme. */
const INTERNAL_VAR = /^--(tw-|vite-|agora-)/;

/** `--name: value` declarations in a stylesheet's text (what the Vite plugin scans). */
export function themeVarsFromCss(css: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const declaration = /(?:^|[;{\s])(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+)/g;
  for (const match of css.matchAll(declaration)) {
    const name = match[1] as string;
    if (INTERNAL_VAR.test(name)) continue;
    // The first value seen is the light one (`:root` comes before `.dark` in every theme file).
    if (!(name in vars)) vars[name] = (match[2] as string).trim();
  }
  return vars;
}

/** A value that is a color — a function, a hex, a named color, or shadcn's bare `H S% L%` channels. */
export function isColorValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    /^#[0-9a-f]{3,8}$/.test(v) ||
    /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/.test(v) ||
    isHslChannels(v) ||
    ['transparent', 'black', 'white', 'currentcolor'].includes(v)
  );
}

/** shadcn v3's `222.2 84% 4.9%`: hue saturation lightness, to be wrapped in `hsl(…)`. */
export function isHslChannels(value: string): boolean {
  return /^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%(\s*\/\s*[\d.]+%?)?$/.test(value.trim());
}

/** What a set of theme variables gives the model to work with. */
export interface ThemeTokens {
  /** Color names (`primary`, `muted-foreground`) — `var(--primary)`, and `bg-primary` with Tailwind. */
  colors: string[];
  /** There is a `--radius` (`rounded-sm`…`rounded-xl` follow it). */
  radius: boolean;
  /** Font variables (`--font-sans`). */
  fonts: string[];
  /** Everything else, by name. */
  other: string[];
}

/** Sort theme variables into colors, radius, fonts and the rest, by value (else by name). */
export function themeTokens(vars: Record<string, string> | readonly string[]): ThemeTokens {
  const entries: [string, string | undefined][] = Array.isArray(vars)
    ? (vars as readonly string[]).map((name) => [name, undefined])
    : Object.entries(vars as Record<string, string>);
  const tokens: ThemeTokens = { colors: [], radius: false, fonts: [], other: [] };
  for (const [name, value] of entries) {
    if (INTERNAL_VAR.test(name)) continue;
    const bare = name.replace(/^--/, '');
    if (bare === 'radius') tokens.radius = true;
    else if (bare.startsWith('font-')) tokens.fonts.push(bare);
    else if (bare.startsWith('color-')) tokens.colors.push(bare.slice('color-'.length));
    else if (
      value !== undefined
        ? isColorValue(value)
        : /(^|-)(background|foreground|primary|secondary|muted|accent|destructive|border|input|ring|card|popover|chart|sidebar)/.test(
            bare,
          )
    )
      tokens.colors.push(bare);
    else tokens.other.push(bare);
  }
  return tokens;
}

/** What the model is told about the theme (inside the sandbox description). */
export function themeToModelText(
  vars: Record<string, string> | readonly string[] | undefined,
  options: { tailwind?: boolean } = {},
): string {
  const tokens = themeTokens(vars ?? []);
  if (tokens.colors.length === 0 && !tokens.radius && tokens.fonts.length === 0) {
    return "The app's theme is on :root as CSS custom properties (for example var(--background), var(--foreground), var(--primary)); use them with a fallback, e.g. var(--primary, #2563eb), so the view matches the app in light and dark mode. The page background shows through: leave the body transparent.";
  }
  const parts = [
    `The app's theme is on :root as CSS custom properties and follows light/dark mode: colors ${tokens.colors
      .map((name) => `var(--${name})`)
      .join(', ')}${tokens.radius ? '; radius var(--radius)' : ''}${
      tokens.fonts.length > 0
        ? `; fonts ${tokens.fonts.map((name) => `var(--${name})`).join(', ')}`
        : ''
    }. Use them instead of hard-coded colors, and leave the body transparent (the page background shows through).`,
  ];
  if (options.tailwind === true) {
    parts.push(
      `With Tailwind they are utilities: ${tokens.colors
        .slice(0, 12)
        .map((name) => `bg-${name}`)
        .join(
          ', ',
        )}, text-*, border-* of the same names${tokens.radius ? ', rounded-sm/md/lg/xl (from --radius)' : ''}.`,
    );
  }
  return parts.join(' ');
}

/**
 * `:root { --x: value; … }` — the theme as the frame gets it. `colorScheme` is the host root's
 * computed `color-scheme`: mirrored when the host sets one (a frame whose scheme differs from its
 * page's is painted opaque), left out when it is `normal`.
 */
export function hostThemeCss(
  vars: Record<string, string>,
  options: { colorScheme?: string } = {},
): string {
  const body = Object.entries(vars)
    .filter(([name, value]) => !INTERNAL_VAR.test(name) && value.trim() !== '')
    .map(([name, value]) => `${name}:${value.replace(/[<>{}]/g, '')}`)
    .join(';');
  const scheme = options.colorScheme?.trim();
  return `:root{${scheme && scheme !== 'normal' ? `color-scheme:${scheme.replace(/[<>{};]/g, '')};` : ''}${body}}`;
}

/**
 * The `@theme` that maps the host's variables to Tailwind utilities — colors to `--color-*`
 * (`hsl(…)`-wrapped for bare channels), `--radius` to the radius scale, fonts as they are — and a
 * `dark` variant that follows the `dark` class and `data-theme` the frame mirrors from the host.
 */
export function tailwindThemeCss(vars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    if (INTERNAL_VAR.test(name)) continue;
    const bare = name.replace(/^--/, '');
    if (bare === 'radius') {
      lines.push(
        '--radius-sm: calc(var(--radius) - 4px)',
        '--radius-md: calc(var(--radius) - 2px)',
        '--radius-lg: var(--radius)',
        '--radius-xl: calc(var(--radius) + 4px)',
      );
    } else if (bare.startsWith('font-')) {
      lines.push(`--${bare}: var(--${bare})`);
    } else if (bare.startsWith('color-')) {
      lines.push(`--${bare}: var(--${bare})`);
    } else if (isColorValue(value)) {
      lines.push(
        isHslChannels(value)
          ? `--color-${bare}: hsl(var(--${bare}))`
          : `--color-${bare}: var(--${bare})`,
      );
    }
  }
  return `@custom-variant dark (&:where(.dark, .dark *, [data-theme=dark], [data-theme=dark] *));\n@theme inline {\n${lines
    .map((line) => `  ${line};`)
    .join('\n')}\n}`;
}

/**
 * The Tailwind directives of an app stylesheet the sandbox's Tailwind should know too: its
 * `@custom-variant`s (shadcn's `data-open:`, `data-horizontal:`…), `@utility`s and `@theme` blocks —
 * not its `@import`s, `@source`s or base styles. What `genuiSandboxKit({ tailwindCss })` collects.
 */
export function tailwindDirectivesFromCss(css: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
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

/** Light or dark: the host's `dark` class / `data-theme`, else the system preference. */
export function isHostDark(doc: Document): boolean {
  const root = doc.documentElement;
  if (root.classList.contains('dark')) return true;
  if (root.classList.contains('light')) return false;
  const attribute = root.getAttribute('data-theme') ?? root.getAttribute('data-mode');
  if (attribute === 'dark') return true;
  if (attribute === 'light') return false;
  return doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/** Every custom property any same-origin stylesheet declares (and the root's inline style sets). */
function declaredVarNames(doc: Document): Set<string> {
  const names = new Set<string>();
  const visit = (rules: CSSRuleList | undefined) => {
    if (rules === undefined) return;
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSStyleRule).style;
      if (style !== undefined) {
        for (let index = 0; index < style.length; index++) {
          const name = style.item(index);
          if (name.startsWith('--') && !INTERNAL_VAR.test(name)) names.add(name);
        }
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested !== undefined) visit(nested);
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      /* a cross-origin stylesheet: its rules are not readable */
    }
  }
  const inline = doc.documentElement.style;
  for (let index = 0; index < inline.length; index++) {
    const name = inline.item(index);
    if (name.startsWith('--') && !INTERNAL_VAR.test(name)) names.add(name);
  }
  return names;
}

/** The host's theme as it is NOW: each declared variable's computed value on `:root`. */
export function collectHostThemeVars(doc: Document): Record<string, string> {
  const computed = doc.defaultView?.getComputedStyle(doc.documentElement);
  const vars: Record<string, string> = {};
  if (computed === undefined) return vars;
  for (const name of [...declaredVarNames(doc)].sort()) {
    const value = computed.getPropertyValue(name).trim();
    if (value !== '') vars[name] = value;
  }
  return vars;
}

/**
 * Call `onChange` when the host's theme may have changed: its root's class, style or `data-theme`,
 * a stylesheet added or removed, or the system's color scheme. Returns the unsubscribe.
 */
export function watchHostTheme(doc: Document, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 30);
  };
  const observer =
    typeof MutationObserver === 'function' ? new MutationObserver(changed) : undefined;
  observer?.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-mode'],
  });
  observer?.observe(doc.head, { childList: true });
  const media = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', changed);
  return () => {
    clearTimeout(timer);
    observer?.disconnect();
    media?.removeEventListener?.('change', changed);
  };
}
