/**
 * The kit's docs, generated from its TypeScript types with the compiler API: each exported
 * component, its props (name, type, required, JSDoc description, `@default`), and the element whose
 * native attributes it also takes — so the model writes the props the components really have.
 *
 * `typescript` is an optional peer dependency (every TypeScript project has it).
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SandboxKitComponentDoc, SandboxKitPropDoc } from '../sandbox-kit.js';
import {
  resolveSandboxKitFiles,
  type SandboxKitFiles,
  type SandboxKitSourceOptions,
} from './files.js';

export interface GenerateSandboxKitDocsOptions extends SandboxKitSourceOptions {
  /** The project root. Default `process.cwd()`. */
  root?: string;
  /** The tsconfig the kit compiles under. Default: the nearest to the kit's first file. */
  tsconfig?: string;
  /** Already resolved files (skips `entry` / `include`). */
  files?: SandboxKitFiles;
  /**
   * The TypeScript module to read the types with. Default: the project's own `typescript` — one with
   * the JavaScript compiler API (5.x/6.x; TypeScript 7's native compiler has none).
   */
  typescript?: unknown;
}

/** React's own DOM props a component inherits — listed only when they say something. */
const KEPT_DOM_PROPS = new Set([
  'children',
  'className',
  'disabled',
  'value',
  'defaultValue',
  'onChange',
  'onClick',
  'placeholder',
  'type',
  'checked',
  'defaultChecked',
  'min',
  'max',
  'step',
  'href',
]);

const ELEMENT_OF_INTERFACE: Record<string, string> = {
  ButtonHTMLAttributes: 'button',
  InputHTMLAttributes: 'input',
  AnchorHTMLAttributes: 'a',
  TextareaHTMLAttributes: 'textarea',
  SelectHTMLAttributes: 'select',
  LabelHTMLAttributes: 'label',
  ImgHTMLAttributes: 'img',
  FormHTMLAttributes: 'form',
  TableHTMLAttributes: 'table',
  TdHTMLAttributes: 'td',
  ThHTMLAttributes: 'th',
  OptionHTMLAttributes: 'option',
};

const ELEMENT_OF_CLASS: Record<string, string> = {
  Div: 'div',
  Span: 'span',
  Button: 'button',
  Input: 'input',
  Anchor: 'a',
  Paragraph: 'p',
  Heading: 'h3',
  TextArea: 'textarea',
  Select: 'select',
  Label: 'label',
  Image: 'img',
  Form: 'form',
  Table: 'table',
  TableRow: 'tr',
  TableCell: 'td',
  TableSection: 'tbody',
  UList: 'ul',
  OList: 'ol',
  LI: 'li',
};

// Types only (a dev alias of typescript@5): the module itself is the app's, loaded at runtime.
type Ts = typeof import('typescript5');

function hasCompilerApi(mod: unknown): mod is Ts {
  return typeof (mod as { createProgram?: unknown } | null)?.createProgram === 'function';
}

async function loadTypescript(root: string, given: unknown): Promise<Ts> {
  const unwrap = (mod: unknown) => (mod as { default?: unknown }).default ?? mod;
  if (given !== undefined) {
    const mod = unwrap(given);
    if (hasCompilerApi(mod)) return mod;
    throw new TypeError('genui: `typescript` must be the TypeScript module (with createProgram)');
  }
  let found: unknown;
  try {
    const { createRequire } = await import('node:module');
    // The app's own TypeScript: the version its code is written for.
    found = unwrap(
      await import(createRequire(resolve(root, 'package.json')).resolve('typescript')),
    );
  } catch {
    found = undefined;
  }
  if (hasCompilerApi(found)) return found;
  throw new Error(
    found === undefined
      ? 'genui: generating the sandbox kit docs needs `typescript` (npm i -D typescript)'
      : "genui: the project's `typescript` has no JavaScript compiler API (TypeScript 7's native compiler) — add typescript@5 for the kit docs (npm i -D typescript5@npm:typescript@5 and pass `typescript: await import('typescript5')`)",
  );
}

function compilerOptionsFor(
  ts: Ts,
  files: SandboxKitFiles,
  tsconfig: string | undefined,
  root: string,
): import('typescript5').CompilerOptions {
  const defaults: import('typescript5').CompilerOptions = {
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
  };
  const start = dirname(files.files[0] ?? resolve(root, 'index.ts'));
  const path =
    tsconfig !== undefined
      ? resolve(root, tsconfig)
      : ts.findConfigFile(start, ts.sys.fileExists, 'tsconfig.json');
  if (path === undefined || !existsSync(path)) return defaults;
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error !== undefined) return defaults;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path));
  return {
    ...parsed.options,
    noEmit: true,
    allowJs: true,
    skipLibCheck: true,
    jsx: parsed.options.jsx ?? ts.JsxEmit.ReactJSX,
  };
}

const fromReactTypes = (fileName: string) =>
  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(?:@types[\\/]react|react)[\\/]/.test(
    fileName,
  );

/**
 * The docs of every component the kit exports, in declaration order. A component is an export named
 * in PascalCase whose type is callable with one props argument and returns JSX (function components,
 * `forwardRef`, `memo`).
 */
export async function generateSandboxKitDocs(
  options: GenerateSandboxKitDocsOptions = {},
): Promise<SandboxKitComponentDoc[]> {
  const root = options.root ?? process.cwd();
  const files = options.files ?? resolveSandboxKitFiles(root, options);
  if (files === null || files.files.length === 0) return [];
  const ts = await loadTypescript(root, options.typescript);
  const program = ts.createProgram(
    files.files,
    compilerOptionsFor(ts, files, options.tsconfig, root),
  );
  const checker = program.getTypeChecker();
  const format =
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
    ts.TypeFormatFlags.WriteArrowStyleSignature;
  const docs: SandboxKitComponentDoc[] = [];
  const seen = new Set<string>();

  for (const file of files.files) {
    const source = program.getSourceFile(file);
    if (source === undefined) continue;
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const name = exported.getName();
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || seen.has(name)) continue;
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (declaration === undefined) continue;
      const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
      const signature = type.getCallSignatures()[0];
      if (signature === undefined) continue;
      const returns = checker.typeToString(signature.getReturnType(), undefined, format);
      if (!/Element|ReactNode|ReactElement|JSX|null/.test(returns)) continue;
      const param = signature.getParameters()[0];
      const propsType =
        param === undefined ? undefined : checker.getTypeOfSymbolAtLocation(param, declaration);
      const props: SandboxKitPropDoc[] = [];
      const inheritedFrom = new Map<string, number>();
      let elementHint: string | undefined;
      for (const prop of propsType === undefined
        ? []
        : checker.getPropertiesOfType(checker.getApparentType(propsType))) {
        const propName = prop.getName();
        if (propName === 'ref' || propName === 'key' || propName === 'asChild') continue;
        const declarations = prop.getDeclarations() ?? [];
        const propDeclaration = prop.valueDeclaration ?? declarations[0];
        const inherited =
          declarations.length > 0 &&
          declarations.every((each) => fromReactTypes(each.getSourceFile().fileName));
        if (inherited) {
          for (const each of declarations) {
            const parent = each.parent;
            if (parent !== undefined && ts.isInterfaceDeclaration(parent)) {
              const iface = parent.name.text;
              inheritedFrom.set(iface, (inheritedFrom.get(iface) ?? 0) + 1);
            }
          }
          if (elementHint === undefined && (propName === 'onClick' || propName === 'onChange')) {
            const text = checker.typeToString(
              checker.getTypeOfSymbolAtLocation(prop, propDeclaration ?? declaration),
              undefined,
              format,
            );
            const match = /HTML(\w+?)Element/.exec(text);
            if (match?.[1] !== undefined) elementHint = ELEMENT_OF_CLASS[match[1]];
          }
          // Of the element's own attributes, only what a model reaches for: children, className,
          // and what the element's specific interface declares (a button's `type`, an input's
          // `value`/`onChange`…) — never the hundreds every element shares.
          const specific = declarations.some((each) => {
            const parent = each.parent;
            return (
              parent !== undefined &&
              ts.isInterfaceDeclaration(parent) &&
              ELEMENT_OF_INTERFACE[parent.name.text] !== undefined
            );
          });
          if (
            !KEPT_DOM_PROPS.has(propName) ||
            !(specific || propName === 'children' || propName === 'className')
          )
            continue;
        }
        const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
        let propType = checker.getTypeOfSymbolAtLocation(prop, propDeclaration ?? declaration);
        if (optional) propType = checker.getNonNullableType(propType);
        let text = checker.typeToString(propType, undefined, format);
        if (propName === 'children') text = 'ReactNode';
        const description = ts.displayPartsToString(prop.getDocumentationComment(checker)).trim();
        const defaultTag = prop.getJsDocTags(checker).find((tag) => tag.name === 'default');
        const defaultValue =
          defaultTag?.text !== undefined ? ts.displayPartsToString(defaultTag.text).trim() : '';
        props.push({
          name: propName,
          type: text,
          required: !optional,
          ...(description !== '' ? { description } : {}),
          ...(defaultValue !== '' ? { default: defaultValue } : {}),
        });
      }
      const specific = [...inheritedFrom.keys()]
        .map((iface) => ELEMENT_OF_INTERFACE[iface])
        .find((element) => element !== undefined);
      const inherits = inheritedFrom.size > 0 ? (specific ?? elementHint ?? 'div') : undefined;
      const description = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
      seen.add(name);
      docs.push({
        name,
        ...(description !== '' ? { description } : {}),
        props: props.slice(0, 40),
        ...(inherits !== undefined ? { inherits } : {}),
      });
    }
  }
  return docs;
}
