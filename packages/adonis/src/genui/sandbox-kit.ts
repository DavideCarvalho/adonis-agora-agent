/**
 * The app's design system inside the sandbox — the isomorphic half: what the kit docs look like,
 * what the model is told about them, what the browser is told about the assets, and the script that
 * draws the model's JSX in the frame. The Node half (docs generation, the bundle, the Vite plugin,
 * discovery) is `genui/kit`.
 */
import { SANDBOX_JSX_FRAME_SOURCE } from './sandbox-jsx-frame-generated.js';
import type { CssVocabulary, TailwindTokens } from './sandbox-styles.js';

/** One prop of a kit component, as its TypeScript type declares it. */
export interface SandboxKitPropDoc {
  name: string;
  /** The type as TypeScript prints it: `"default" | "outline"`, `(value: number[]) => void`. */
  type: string;
  required: boolean;
  description?: string;
  /** From a `@default` JSDoc tag. */
  default?: string;
}

/** One kit component — an export of the kit entry the model may use as `<Name />`. */
export interface SandboxKitComponentDoc {
  name: string;
  description?: string;
  props: SandboxKitPropDoc[];
  /** The element whose native attributes it also takes (`button`), when it spreads them. */
  inherits?: string;
}

/**
 * What the model is told about the app's design system: its components (when there are any), what
 * its styles are — Tailwind (its tokens) or plain CSS (its class vocabulary) — the theme's variables,
 * and the app's own notes. Only what exists is described.
 */
export interface SandboxKitDocs {
  version: 2;
  /** The kit's components, from their types (or names and propTypes in a JavaScript project). */
  components: SandboxKitComponentDoc[];
  /** The model writes JSX: a kit bundle exists (components, or a wrapper). */
  jsx?: boolean;
  /** The App is rendered inside the app's wrapper (`genuiSandboxKit({ wrapper })`: providers, theme). */
  wrapper?: boolean;
  /** The theme variables (name → light value) the app's CSS declares — what the prompt names. */
  theme?: { vars: Record<string, string> };
  /** The styles use Tailwind: the frame runs it, with these tokens. */
  tailwind?: { version: 3 | 4; tokens: TailwindTokens };
  /** The styles are plain CSS (Sass, Less, Bootstrap…): the classes they define. */
  vocabulary?: CssVocabulary;
  /** The app's own guidance on its styles (`stylesDocs`), as written. */
  guide?: string;
}

/** Where the browser fetches the frame's assets from (same origin). `null`: there is none. */
export interface SandboxKitAssets {
  /** React, ReactDOM, the components and the wrapper, as one classic script (JSX views only). */
  kit: { url: string; hash?: string } | null;
  /** The app's styles, compiled (fonts and images inlined). */
  css: { url: string; hash?: string } | null;
  /** The Tailwind v4 browser runtime, and the app's Tailwind directives (`@theme`, variants, utilities). */
  tailwind: { url: string; css?: string } | null;
}

/** What the Vite plugin writes (dev) and emits (build), and what the server discovers. */
export interface SandboxKitDescriptor extends SandboxKitDocs {
  assets: SandboxKitAssets;
}

/**
 * What a sandbox renderer needs from the server (`GET <agent>/config` → `genui.sandbox`): whether to
 * pass the theme in, and where the kit bundle, the compiled styles and the Tailwind runtime are.
 */
export interface SandboxClientConfig {
  theme: boolean;
  kit?: { url: string; hash?: string };
  css?: { url: string; hash?: string };
  tailwind?: { url: string; css?: string };
}

/** What the opt-in assets weigh, inlined into every sandbox frame that uses them. */
export const SANDBOX_ASSET_SIZES = {
  /** `@tailwindcss/browser` v4 (minified, as inlined; ≈75 KB gzipped over the wire, once). */
  tailwind: '≈280 KB',
  /** React + ReactDOM in the kit bundle, before the app's own components. */
  kit: '≈230 KB + your components',
} as const;

/** A prop's line in the model text: `variant?: "default" | "outline" = "default" — the look`. */
function propLine(prop: SandboxKitPropDoc): string {
  const type = prop.type.length > 160 ? `${prop.type.slice(0, 157)}…` : prop.type;
  return `${prop.name}${prop.required ? '' : '?'}: ${type}${
    prop.default !== undefined ? ` = ${prop.default}` : ''
  }${prop.description ? ` — ${prop.description.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`;
}

/** The kit as the model reads it: one entry per component, its props from their types. */
export function kitDocsToModelText(docs: Pick<SandboxKitDocs, 'components'>): string {
  const lines = [
    'Kit components (the app design system — use these first; each is in scope by name, and on the global `Kit`):',
  ];
  for (const component of docs.components) {
    const head = `- <${component.name}>${component.description ? ` ${component.description.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
    lines.push(head);
    for (const prop of component.props) lines.push(`    ${propLine(prop)}`);
    if (component.inherits !== undefined)
      lines.push(`    …and every <${component.inherits}> attribute (className, onClick, …)`);
  }
  return lines.join('\n');
}

/** The rules for writing the sandbox as JSX. */
export function kitJsxInstructions(
  options: { components?: boolean; wrapper?: boolean } = {},
): string {
  const components = options.components !== false;
  return [
    'Write the view as JSX in `jsx` (instead of `html`/`jsFunctions`): plain JavaScript + JSX, no TypeScript, no imports — define `function App()` and return the UI; it is rendered for you.',
    components
      ? 'React hooks (useState, useEffect, useMemo, useRef, useCallback, useReducer) and every kit component are in scope by name. Use kit components for controls and surfaces, plain elements for the rest.'
      : 'React hooks (useState, useEffect, useMemo, useRef, useCallback, useReducer) are in scope by name; use plain elements.',
    ...(options.wrapper === true
      ? [
          "App is rendered inside the app's own providers (its theme, its baseline styles): do not add a theme provider or global resets of your own.",
        ]
      : []),
    'Keep state in App; call agent.send({ text, ...values }) from a click handler to hand values back.',
  ].join(' ');
}

/** The rule for a kit with styles but no components: the model writes HTML with those styles. */
export function kitHtmlInstructions(): string {
  return 'There is no component kit here: write html (and jsFunctions/jsExpressions), never jsx.';
}

/**
 * The script that draws the model's JSX in the frame: it holds the transpiler, compiles what the
 * host posts (`{ type: jsxMessage, code, final }`), runs it in a scope with the kit components and
 * React's hooks, and renders `App` into `#agora-sandbox-root`. A partial program is drawn only once
 * it closes into code that parses and renders; until then — and whenever a later version fails —
 * the last good one stays on screen. Errors are reported (to the host) only for the final program.
 * A partial program is not tried before its JSX has begun (nothing to draw before then).
 */
export function sandboxJsxRuntime(options: {
  token: string;
  jsxMessage: string;
  /** Code to draw at once (a document built for a whole program). */
  initial?: { code: string; final: boolean };
}): string {
  const t = JSON.stringify(options.token);
  const type = JSON.stringify(options.jsxMessage);
  const initial = options.initial === undefined ? 'null' : JSON.stringify(options.initial);
  // The transpiler ships prebuilt as a string (never `fn.toString()` of bundled code, which a
  // consumer's minifier rewrites): see scripts/build-frame-runtime.mjs.
  return `(function(){${SANDBOX_JSX_FRAME_SOURCE};var transpileJsx=__genuiJsx.transpileJsx,prepareSandboxJsx=__genuiJsx.prepareSandboxJsx;
var T=${t},TYPE=${type},R=window.React,D=window.ReactDOM,K=window.Kit||{},W=typeof window.KitWrapper==='function'||(window.KitWrapper&&typeof window.KitWrapper==='object')?window.KitWrapper:null;
if(window.__GENUI_KIT_CSS__){var ks=document.createElement('style');ks.textContent=window.__GENUI_KIT_CSS__;document.head.appendChild(ks)}
var kitNames=Object.keys(K).filter(function(k){return /^[A-Z][\\w$]*$/.test(k)});
var hookNames=['useState','useEffect','useMemo','useRef','useCallback','useReducer','useId','useLayoutEffect','Fragment'].filter(function(k){return R&&R[k]!==undefined});
var root=null,lastGood=null,seq=0,lastCode=null;
window.addEventListener('error',function(e){if(window.__agoraQuiet){e.preventDefault();e.stopImmediatePropagation()}},true);
function report(e){window.__agoraQuiet=false;try{window.dispatchEvent(new ErrorEvent('error',{message:String(e&&e.message||e)}))}catch(_){}}
var Boundary=R?(function(){function B(p){R.Component.call(this,p);this.state={failed:false}}
B.prototype=Object.create(R.Component.prototype);B.prototype.constructor=B;
B.getDerivedStateFromError=function(){return{failed:true}};
B.prototype.componentDidCatch=function(e){if(this.props.final)report(e)};
B.prototype.componentDidMount=function(){if(!this.state.failed)lastGood=this.props.app};
B.prototype.render=function(){if(this.state.failed)return this.props.keep?R.createElement(this.props.keep):null;return this.props.children};
return B})():null;
function draw(code,final){if(!R||!D)return false;if(code===lastCode&&!final)return true;
if(!final&&!/(return|=>)\\s*\\(?\\s*</.test(code))return false;var js;
try{js=transpileJsx(prepareSandboxJsx(code),{partial:!final})}catch(e){if(final)report(e);return false}
window.__genuiApp=undefined;window.__genuiOk=false;window.__agoraQuiet=!final;
var s=document.createElement('script');
s.textContent='(function(){var Kit=window.Kit||{},React=window.React;var {'+kitNames.join(',')+'}=Kit;var {'+hookNames.join(',')+'}=React;(function(){\\n'+js+'\\n;window.__genuiApp=typeof App==="function"?App:undefined})()})();window.__genuiOk=true;';
document.head.appendChild(s);s.remove();window.__agoraQuiet=false;
if(!window.__genuiOk||typeof window.__genuiApp!=='function'){return false}
lastCode=code;var App=window.__genuiApp;
if(!root)root=D.createRoot(document.getElementById('agora-sandbox-root'));
var view=R.createElement(Boundary,{key:++seq,app:App,keep:lastGood,final:final},R.createElement(App));\nroot.render(W?R.createElement(W,null,view):view);
return true}
window.addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.token!==T||d.type!==TYPE)return;draw(String(d.code||''),d.final===true)});
var init=${initial};if(init){draw(init.code,init.final)}})();`;
}
