/**
 * The sandbox's code, checked on the server BEFORE the call is accepted — so a model that wrote a
 * view the frame cannot draw gets a short, exact tool error ("jsx line 12:5: `flippy.send` — the
 * bridge is `agent.send(payload)`") and its retry succeeds, instead of the user seeing a broken
 * frame.
 *
 * - JSX goes through the SAME transpiler the frame runs ({@link transpileJsx}) and is parsed with
 *   acorn (+ acorn-jsx) for exact positions; `App` must be defined.
 * - HTML: every inline `<script>` and `on*=` handler, `jsFunctions` and each `jsExpressions` entry
 *   is parsed with acorn; a `<script src>` the policy blocks is refused.
 * - Anything that looks like a bridge (`x.send(…)` on an undeclared `x`, `agent.post(…)`) other than
 *   `agent.send` is refused.
 * - With the kit's docs, a `<Component>` the kit does not have is refused (it would throw in the
 *   frame); a prop the component does not declare is a WARNING — the call is accepted and the model
 *   is told.
 *
 * The parsers are loaded on first use (`await import`): this file is part of the isomorphic genui
 * entry, and a browser bundle that never validates never loads them.
 */
import { prepareSandboxJsx, transpileJsx } from './sandbox-jsx.js';
import type { SandboxKitDocs } from './sandbox-kit.js';

/**
 * Why a UI tool call was refused (or warned about) — what telemetry counts.
 *
 * `shape`: the input does not fit the schema (a missing wrapper, a wrong type); `syntax`: the code
 * does not parse; `missing-app`: JSX without `App`; `bridge`: a bridge other than `agent.send`;
 * `unknown-component` / `unknown-prop`: not in the kit's docs; `unavailable`: the component is not
 * offered here; `other`: anything else (a thrown handler, the emit failing).
 */
export type GenuiErrorCategory =
  | 'shape'
  | 'syntax'
  | 'missing-app'
  | 'bridge'
  | 'unknown-component'
  | 'unknown-prop'
  | 'unavailable'
  | 'other';

/** One problem with a sandbox's code, where it is. */
export interface SandboxCodeIssue {
  /** `error` refuses the call; `warning` is reported with the result. */
  severity: 'error' | 'warning';
  category: GenuiErrorCategory;
  field: 'jsx' | 'html' | 'jsFunctions' | 'jsExpressions';
  /** The `jsExpressions` entry. */
  index?: number;
  /** 1-based, in the field's own text. */
  line?: number;
  /** 1-based. */
  column?: number;
  /** What is wrong and the one-line fix. */
  message: string;
}

export interface ValidateSandboxCodeOptions {
  /** The view may be JSX (a kit bundle draws it). Default: what `kit.jsx` says. */
  jsx?: boolean;
  /** The kit's docs: `<Component>`s and their props are checked against them. */
  kit?: SandboxKitDocs;
  /** Origins the policy opens for scripts (`<script src>` from elsewhere is refused). */
  scriptOrigins?: readonly string[];
}

/** `jsx line 12:5: …` / `jsExpressions[2] line 1:3: …` — the issue as the model reads it. */
export function formatSandboxIssue(issue: SandboxCodeIssue): string {
  const field = issue.index !== undefined ? `${issue.field}[${issue.index}]` : issue.field;
  const where =
    issue.line !== undefined
      ? ` line ${issue.line}${issue.column !== undefined ? `:${issue.column}` : ''}`
      : '';
  return `${field}${where}: ${issue.message}`;
}

/** Names the frame puts in scope for JSX besides the kit's components. */
const JSX_SCOPE = new Set([
  'useState',
  'useEffect',
  'useMemo',
  'useRef',
  'useCallback',
  'useReducer',
  'useId',
  'useLayoutEffect',
  'Fragment',
  'React',
  'Kit',
]);

/** Props every element takes (React's own, and attributes a component passes through). */
const UNIVERSAL_PROPS = new Set(['key', 'ref', 'children', 'className', 'style', 'id']);

const BRIDGE_HOLDERS = new Set(['window', 'globalThis', 'self', 'parent', 'top']);

type Node = { type: string; start: number; end: number; [key: string]: unknown };
type Parse = (code: string, options: Record<string, unknown>) => Node;

interface Parsers {
  js: Parse;
  jsx: Parse;
}

let parsers: Promise<Parsers> | undefined;

async function loadParsers(): Promise<Parsers> {
  parsers ??= (async () => {
    const acorn = await import('acorn');
    const jsxModule = (await import('acorn-jsx')) as unknown as {
      default?: (options?: object) => (base: unknown) => unknown;
    };
    const plugin = (jsxModule.default ?? jsxModule) as (
      options?: object,
    ) => (base: typeof acorn.Parser) => typeof acorn.Parser;
    const JsxParser = acorn.Parser.extend(plugin());
    return {
      js: (code, options) => acorn.parse(code, options as never) as unknown as Node,
      jsx: (code, options) => JsxParser.parse(code, options as never) as unknown as Node,
    };
  })();
  return parsers;
}

/**
 * The sandbox's code, checked: errors first (each refuses the call), then warnings. JSX when the
 * kit allows it and the view is in `jsx` (the longer of `jsx`/`html`, as the renderer decides);
 * otherwise the HTML and its scripts.
 */
export async function validateSandboxCode(
  props: Record<string, unknown>,
  options: ValidateSandboxCodeOptions = {},
): Promise<SandboxCodeIssue[]> {
  const { js, jsx } = await loadParsers();
  const jsxSource = typeof props.jsx === 'string' ? props.jsx : '';
  const html = typeof props.html === 'string' ? props.html : '';
  const drawsJsx = jsxSource.trim() !== '' && jsxSource.trim().length >= html.trim().length;
  const issues: SandboxCodeIssue[] = [];
  if (drawsJsx && (options.jsx ?? options.kit?.jsx === true)) {
    issues.push(...checkJsx(jsxSource, options.kit, js, jsx));
  } else {
    issues.push(...checkHtml(html, options, js));
    if (typeof props.jsFunctions === 'string' && props.jsFunctions.trim() !== '') {
      issues.push(...checkScript(props.jsFunctions, 'jsFunctions', undefined, js));
    }
    if (Array.isArray(props.jsExpressions)) {
      props.jsExpressions.forEach((code, index) => {
        if (typeof code === 'string' && code.trim() !== '') {
          issues.push(...checkScript(code, 'jsExpressions', index, js));
        }
      });
    }
  }
  return [
    ...issues.filter((issue) => issue.severity === 'error'),
    ...issues.filter((issue) => issue.severity === 'warning'),
  ];
}

// ─── JSX ────────────────────────────────────────────────────────────────────────────────────────

/** {@link prepareSandboxJsx} line by line, so every line stays where it was (positions match the model's text). */
function prepareKeepingLines(source: string): string {
  return source.split('\n').map(prepareSandboxJsx).join('\n');
}

function checkJsx(
  source: string,
  kit: SandboxKitDocs | undefined,
  js: Parse,
  jsx: Parse,
): SandboxCodeIssue[] {
  const prepared = prepareKeepingLines(source);
  let output: string;
  try {
    output = transpileJsx(prepared);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const at = /\s*\(at (\d+)\)\s*$/.exec(text);
    const offset = at !== null ? Number(at[1]) : undefined;
    return [
      {
        severity: 'error',
        category: 'syntax',
        field: 'jsx',
        ...(offset !== undefined ? position(prepared, offset) : {}),
        message: `${at !== null ? text.slice(0, at.index) : text}${hintFor(prepared, offset)}`,
      },
    ];
  }
  let ast: Node | undefined;
  let located = true;
  try {
    ast = jsx(prepared, PARSE_OPTIONS);
  } catch (error) {
    // acorn-jsx is stricter than the frame in places: what counts is whether the program the frame
    // runs (the transpiled one) parses.
    try {
      ast = js(output, PARSE_OPTIONS);
      located = false;
    } catch {
      return [syntaxIssue(error, 'jsx', undefined, prepared)];
    }
  }
  const issues: SandboxCodeIssue[] = [];
  const declared = declaredNames(ast);
  if (!definesApp(ast)) {
    const candidate = topLevelComponent(ast);
    issues.push({
      severity: 'error',
      category: 'missing-app',
      field: 'jsx',
      message:
        candidate !== undefined
          ? `no \`App\` — rename \`function ${candidate}\` to \`function App\`; App is what gets drawn`
          : 'no `App` — define `function App() { return <…/>; }`; App is what gets drawn',
    });
  }
  issues.push(...bridgeIssues(ast, declared, 'jsx', undefined, located ? prepared : undefined));
  if (kit !== undefined)
    issues.push(...kitIssues(ast, declared, kit, located ? prepared : undefined));
  return issues;
}

const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  locations: false,
  allowReturnOutsideFunction: false,
} as const;

/** Does the program define `App` at its top level (a function, a `const App = …`, a class)? */
function definesApp(ast: Node): boolean {
  for (const statement of (ast.body as Node[]) ?? []) {
    if (
      (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') &&
      (statement.id as Node & { name?: string })?.name === 'App'
    ) {
      return true;
    }
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations as Node[]) {
        if ((declarator.id as Node & { name?: string }).name === 'App') return true;
      }
    }
  }
  return false;
}

/** The one capitalized top-level function, when the model named its view something else. */
function topLevelComponent(ast: Node): string | undefined {
  const names = ((ast.body as Node[]) ?? [])
    .filter((statement) => statement.type === 'FunctionDeclaration')
    .map((statement) => (statement.id as Node & { name?: string })?.name ?? '')
    .filter((name) => /^[A-Z]/.test(name));
  return names.length === 1 ? names[0] : undefined;
}

function kitIssues(
  ast: Node,
  declared: Set<string>,
  kit: SandboxKitDocs,
  source: string | undefined,
): SandboxCodeIssue[] {
  const components = new Map(kit.components.map((component) => [component.name, component]));
  const issues: SandboxCodeIssue[] = [];
  const reported = new Set<string>();
  walk(ast, (node) => {
    let name: string | undefined;
    let attributes: Node[] = [];
    if (node.type === 'JSXOpeningElement') {
      name = jsxName(node.name as Node);
      attributes = (node.attributes as Node[]) ?? [];
    } else if (node.type === 'CallExpression' && isCreateElement(node.callee as Node)) {
      // The transpiled program (acorn-jsx refused the source): `React.createElement(Name, {…})`.
      const [first] = node.arguments as Node[];
      if (first?.type === 'Identifier') name = first.name as string;
    }
    if (name === undefined || !/^[A-Z]/.test(name)) return;
    const bare = name.startsWith('Kit.') ? name.slice(4) : name;
    if (name.includes('.') && !name.startsWith('Kit.')) return;
    if (!name.startsWith('Kit.') && (declared.has(bare) || JSX_SCOPE.has(bare))) return;
    const doc = components.get(bare);
    if (doc === undefined) {
      if (reported.has(bare)) return;
      reported.add(bare);
      const known = kit.components.map((component) => component.name);
      issues.push({
        severity: 'error',
        category: 'unknown-component',
        field: 'jsx',
        ...(source !== undefined ? position(source, node.start) : {}),
        message:
          known.length > 0
            ? `\`<${name}>\` is not a kit component — use one of ${listOf(known)}, or a plain element`
            : `\`<${name}>\` does not exist here — use plain elements (or define ${bare} yourself)`,
      });
      return;
    }
    if (doc.inherits !== undefined || doc.props.length === 0) return;
    const allowed = new Set(doc.props.map((prop) => prop.name));
    for (const attribute of attributes) {
      if (attribute.type !== 'JSXAttribute') continue;
      const prop = jsxName(attribute.name as Node);
      if (
        prop === undefined ||
        allowed.has(prop) ||
        UNIVERSAL_PROPS.has(prop) ||
        /^(data|aria)-/.test(prop)
      ) {
        continue;
      }
      issues.push({
        severity: 'warning',
        category: 'unknown-prop',
        field: 'jsx',
        ...(source !== undefined ? position(source, attribute.start) : {}),
        message: `\`<${bare} ${prop}>\`: ${bare} has no prop \`${prop}\` (it takes ${listOf([...allowed])})`,
      });
    }
  });
  return issues;
}

function isCreateElement(callee: Node): boolean {
  return (
    callee.type === 'MemberExpression' &&
    (callee.object as Node & { name?: string }).name === 'React' &&
    (callee.property as Node & { name?: string }).name === 'createElement'
  );
}

function jsxName(node: Node | undefined): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (node.type === 'JSXIdentifier') return node.name as string;
  if (node.type === 'JSXMemberExpression') {
    const object = jsxName(node.object as Node);
    const property = jsxName(node.property as Node);
    return object !== undefined && property !== undefined ? `${object}.${property}` : undefined;
  }
  if (node.type === 'JSXNamespacedName') {
    return `${jsxName(node.namespace as Node)}:${jsxName(node.name as Node)}`;
  }
  return undefined;
}

// ─── HTML and plain scripts ─────────────────────────────────────────────────────────────────────

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)(<\/script\s*>|$)/gi;
const JS_TYPES = /^(|text\/javascript|application\/javascript|module|text\/ecmascript)$/i;

function checkHtml(
  html: string,
  options: ValidateSandboxCodeOptions,
  js: Parse,
): SandboxCodeIssue[] {
  const issues: SandboxCodeIssue[] = [];
  let blanked = html;
  for (const match of html.matchAll(SCRIPT)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const at = match.index ?? 0;
    const bodyStart = at + match[0].indexOf('>') + 1;
    blanked =
      blanked.slice(0, at) + match[0].replace(/[^\n]/g, ' ') + blanked.slice(at + match[0].length);
    if (match[3] === '') {
      issues.push({
        severity: 'error',
        category: 'syntax',
        field: 'html',
        ...position(html, at),
        message: '`<script>` is never closed — end it with `</script>`',
      });
      continue;
    }
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(attributes);
    if (src !== null) {
      const origin = originOf(src[1] ?? '');
      if (
        origin === undefined ||
        !(options.scriptOrigins ?? []).some((each) => allows(each, origin))
      ) {
        issues.push({
          severity: 'error',
          category: 'syntax',
          field: 'html',
          ...position(html, at),
          message: `\`<script src="${src[1]}">\` is blocked (the sandbox has no network) — inline the code instead`,
        });
      }
      continue;
    }
    const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attributes)?.[1] ?? '';
    if (!JS_TYPES.test(type)) continue;
    const parsed = parseAt(body, js, type.toLowerCase() === 'module' ? 'module' : 'script');
    if (!parsed.ok) {
      issues.push(syntaxIssue(parsed.error, 'html', undefined, html, bodyStart));
      continue;
    }
    issues.push(
      ...bridgeIssues(parsed.ast, declaredNames(parsed.ast), 'html', undefined, html, bodyStart),
    );
  }
  // Inline handlers (`onclick="…"`), outside the scripts.
  const handler = /<[a-zA-Z][^>]*?\son[a-z]+\s*=\s*("([^"]*)"|'([^']*)')/g;
  const attribute = /\son[a-z]+\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const tag of blanked.matchAll(handler)) {
    const tagStart = tag.index ?? 0;
    const whole = blanked.slice(tagStart, blanked.indexOf('>', tagStart) + 1 || undefined);
    for (const each of whole.matchAll(attribute)) {
      const value = each[2] ?? each[3] ?? '';
      const valueStart = tagStart + (each.index ?? 0) + each[0].indexOf(each[1] ?? '') + 1;
      const code = decodeEntities(value);
      const wrapped = `(function(event){${code}\n})`;
      const parsed = parseAt(wrapped, js, 'script');
      if (!parsed.ok) {
        const offset = Math.max(0, errorOffset(parsed.error) - '(function(event){'.length);
        issues.push({
          severity: 'error',
          category: 'syntax',
          field: 'html',
          ...position(html, valueStart + Math.min(offset, value.length)),
          message: `${errorText(parsed.error)} in an inline handler`,
        });
        continue;
      }
      issues.push(
        ...bridgeIssues(
          parsed.ast,
          declaredNames(parsed.ast),
          'html',
          undefined,
          html,
          valueStart - '(function(event){'.length,
        ),
      );
    }
  }
  return dedupe(issues);
}

function checkScript(
  code: string,
  field: 'jsFunctions' | 'jsExpressions',
  index: number | undefined,
  js: Parse,
): SandboxCodeIssue[] {
  const parsed = parseAt(code, js, 'script');
  if (!parsed.ok) return [syntaxIssue(parsed.error, field, index, code)];
  return bridgeIssues(parsed.ast, declaredNames(parsed.ast), field, index, code);
}

function parseAt(
  code: string,
  js: Parse,
  sourceType: 'script' | 'module',
): { ok: true; ast: Node } | { ok: false; error: unknown } {
  try {
    return { ok: true, ast: js(code, { ...PARSE_OPTIONS, sourceType }) };
  } catch (error) {
    return { ok: false, error };
  }
}

function originOf(url: string): string | undefined {
  const match = /^(https:\/\/[^/?#]+)/i.exec(url);
  return match?.[1]?.toLowerCase();
}

function allows(pattern: string, origin: string): boolean {
  const lower = pattern.toLowerCase();
  if (!lower.includes('*.')) return lower === origin;
  const suffix = lower.replace('https://*.', '');
  return origin.startsWith('https://') && origin.slice(8).endsWith(`.${suffix}`);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ─── The bridge ─────────────────────────────────────────────────────────────────────────────────

/**
 * Calls that look like a way out of the frame but are not `agent.send`: `flippy.send(…)` on an
 * undeclared name, `window.app.send(…)`, `agent.post(…)`.
 */
function bridgeIssues(
  ast: Node,
  declared: Set<string>,
  field: SandboxCodeIssue['field'],
  index: number | undefined,
  source: string | undefined,
  base = 0,
): SandboxCodeIssue[] {
  const issues: SandboxCodeIssue[] = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as Node;
    if (callee.type !== 'MemberExpression' || callee.computed === true) return;
    const method = (callee.property as Node & { name?: string }).name;
    const object = callee.object as Node & { name?: string };
    let holder: string | undefined;
    if (object.type === 'Identifier') holder = object.name;
    else if (
      object.type === 'MemberExpression' &&
      object.computed !== true &&
      BRIDGE_HOLDERS.has((object.object as Node & { name?: string }).name ?? '')
    ) {
      const inner = (object.property as Node & { name?: string }).name;
      if (inner === 'agent') holder = 'agent';
      else if (inner !== undefined)
        holder = `${(object.object as Node & { name: string }).name}.${inner}`;
    }
    if (holder === undefined) return;
    const where = {
      ...(index !== undefined ? { index } : {}),
      ...(source !== undefined ? position(source, base + callee.start) : {}),
    };
    if (holder === 'agent') {
      if (method === 'send' || declared.has('agent')) return;
      issues.push({
        severity: 'error',
        category: 'bridge',
        field,
        ...where,
        message: `\`agent.${method}\` — the bridge has one method: \`agent.send(payload)\``,
      });
      return;
    }
    if (method !== 'send') return;
    const root = holder.split('.')[0] ?? holder;
    if (!holder.includes('.') && declared.has(root)) return;
    issues.push({
      severity: 'error',
      category: 'bridge',
      field,
      ...where,
      message: `\`${holder}.send\` — the bridge is \`agent.send(payload)\``,
    });
  });
  return issues;
}

// ─── AST helpers ────────────────────────────────────────────────────────────────────────────────

function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node !== 'object' || node === null || typeof (node as Node).type !== 'string') return;
  visit(node as Node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    if (typeof value === 'object' && value !== null) walk(value, visit);
  }
}

/** Every name the program binds anywhere (conservative: scope is ignored). */
function declaredNames(ast: Node): Set<string> {
  const names = new Set<string>();
  const bind = (pattern: unknown): void => {
    if (typeof pattern !== 'object' || pattern === null) return;
    const node = pattern as Node;
    switch (node.type) {
      case 'Identifier':
        names.add(node.name as string);
        return;
      case 'ObjectPattern':
        for (const property of node.properties as Node[]) {
          bind(property.type === 'RestElement' ? property.argument : property.value);
        }
        return;
      case 'ArrayPattern':
        for (const element of node.elements as Node[]) bind(element);
        return;
      case 'RestElement':
        bind(node.argument);
        return;
      case 'AssignmentPattern':
        bind(node.left);
        return;
    }
  };
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') bind(node.id);
    else if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      if (node.id !== null && node.id !== undefined) bind(node.id);
      for (const param of node.params as Node[]) bind(param);
    } else if (node.type === 'ClassDeclaration' && node.id !== null) bind(node.id);
    else if (node.type === 'CatchClause' && node.param !== null) bind(node.param);
    else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier')
      bind(node.local);
  });
  return names;
}

function position(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

function errorOffset(error: unknown): number {
  const pos = (error as { pos?: unknown }).pos;
  return typeof pos === 'number' ? pos : 0;
}

/** acorn's message without its `(line:column)` suffix. */
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s*\(\d+:\d+\)\s*$/, '');
}

function syntaxIssue(
  error: unknown,
  field: SandboxCodeIssue['field'],
  index: number | undefined,
  source: string,
  base = 0,
): SandboxCodeIssue {
  const offset = base + errorOffset(error);
  return {
    severity: 'error',
    category: 'syntax',
    field,
    ...(index !== undefined ? { index } : {}),
    ...position(source, offset),
    message: `${errorText(error)}${hintFor(source, offset)}`,
  };
}

/** A one-line fix for the syntax errors models make most. */
function hintFor(source: string, offset: number | undefined): string {
  if (offset === undefined) return '';
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const lineEnd = source.indexOf('\n', offset);
  const line = source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  if (
    /^\s*(type|interface)\s+\w+/.test(line) ||
    /\)\s*:\s*[\w.]+[\w.<>[\]|]*\s*(=>|\{)/.test(line) ||
    /\b(useState|useRef|useMemo)<|\bas\s+(const|[A-Z]\w*|string|number)\b/.test(line)
  ) {
    return ' — plain JavaScript only: drop the TypeScript types';
  }
  if (/\b(class|for)=/.test(line) && /</.test(line)) return '';
  if (/<\/?[A-Za-z]/.test(line)) return ' — check that every JSX tag is closed in order';
  return '';
}

function listOf(names: readonly string[], max = 12): string {
  const shown = names.slice(0, max).map((name) => `\`${name}\``);
  return names.length > max ? `${shown.join(', ')}…` : shown.join(', ');
}

function dedupe(issues: SandboxCodeIssue[]): SandboxCodeIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = formatSandboxIssue(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
