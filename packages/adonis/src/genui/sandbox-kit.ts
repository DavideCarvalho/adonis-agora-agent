/**
 * The app's design system inside the sandbox — the isomorphic half: what the kit docs look like,
 * what the model is told about them, what the browser is told about the assets, and the script that
 * draws the model's JSX in the frame. The Node half (docs generation, the bundle, the Vite plugin,
 * discovery) is `genui/kit`.
 */
import { prepareSandboxJsx, transpileJsx } from './sandbox-jsx.js';

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

/** The kit's docs: its components, and the theme variables its stylesheets declare. */
export interface SandboxKitDocs {
  version: 1;
  components: SandboxKitComponentDoc[];
  /** The theme variables (name → light value) the app's CSS declares — what the prompt names. */
  theme?: { vars: Record<string, string> };
}

/**
 * What the Vite plugin writes (dev) and emits (build), and what the server discovers: the docs, plus
 * where the browser fetches the kit bundle and the Tailwind runtime from (same origin).
 */
export interface SandboxKitDescriptor extends SandboxKitDocs {
  kit: { url: string; hash?: string } | null;
  tailwind: { url: string } | null;
}

/**
 * What a sandbox renderer needs from the server (`GET <agent>/config` → `genui.sandbox`): whether to
 * pass the theme in, and where the Tailwind runtime and the kit bundle are.
 */
export interface SandboxClientConfig {
  theme: boolean;
  tailwind?: { url: string };
  kit?: { url: string; hash?: string };
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
export function kitDocsToModelText(docs: SandboxKitDocs): string {
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

/** The rules for writing the sandbox as JSX with the kit. */
export function kitJsxInstructions(): string {
  return [
    'Write the view as JSX in `jsx` (instead of `html`/`jsFunctions`): plain JavaScript + JSX, no TypeScript, no imports — define `function App()` and return the UI; it is rendered for you.',
    'React hooks (useState, useEffect, useMemo, useRef, useCallback, useReducer) and every kit component are in scope by name. Use kit components for controls and surfaces, plain elements for the rest.',
    'Keep state in App; call agent.send({ text, ...values }) from a click handler to hand values back.',
  ].join(' ');
}

/** The Tailwind rule, for the sandbox description. */
export function tailwindInstructions(): string {
  return 'Tailwind CSS v4 utility classes work (className="flex gap-2 p-4 rounded-lg bg-card text-card-foreground"), offline — prefer them to custom CSS.';
}

/**
 * The script that draws the model's JSX in the frame: it holds the transpiler, compiles what the
 * host posts (`{ type: jsxMessage, code, final }`), runs it in a scope with the kit components and
 * React's hooks, and renders `App` into `#agora-sandbox-root`. A partial program is drawn only once
 * it closes into code that parses and renders; until then — and whenever a later version fails —
 * the last good one stays on screen. Errors are reported (to the host) only for the final program.
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
  return `(function(){var transpileJsx=${transpileJsx.toString()};var prepareSandboxJsx=${prepareSandboxJsx.toString()};
var T=${t},TYPE=${type},R=window.React,D=window.ReactDOM,K=window.Kit||{};
if(window.__GENUI_KIT_CSS__){var ks=document.createElement('style');ks.textContent=window.__GENUI_KIT_CSS__;document.head.appendChild(ks)}
var kitNames=Object.keys(K).filter(function(k){return /^[A-Z][\\w$]*$/.test(k)});
var hookNames=['useState','useEffect','useMemo','useRef','useCallback','useReducer','useId','useLayoutEffect','Fragment'].filter(function(k){return R&&R[k]!==undefined});
var root=null,lastGood=null,seq=0,lastCode=null;
function report(e){window.__agoraQuiet=false;try{window.dispatchEvent(new ErrorEvent('error',{message:String(e&&e.message||e)}))}catch(_){}}
var Boundary=R?(function(){function B(p){R.Component.call(this,p);this.state={failed:false}}
B.prototype=Object.create(R.Component.prototype);B.prototype.constructor=B;
B.getDerivedStateFromError=function(){return{failed:true}};
B.prototype.componentDidCatch=function(e){if(this.props.final)report(e)};
B.prototype.componentDidMount=function(){if(!this.state.failed)lastGood=this.props.app};
B.prototype.render=function(){if(this.state.failed)return this.props.keep?R.createElement(this.props.keep):null;return this.props.children};
return B})():null;
function draw(code,final){if(!R||!D)return false;if(code===lastCode&&!final)return true;var js;
try{js=transpileJsx(prepareSandboxJsx(code),{partial:!final})}catch(e){if(final)report(e);return false}
window.__genuiApp=undefined;window.__genuiOk=false;window.__agoraQuiet=!final;
var s=document.createElement('script');
s.textContent='(function(){var Kit=window.Kit||{},React=window.React;var {'+kitNames.join(',')+'}=Kit;var {'+hookNames.join(',')+'}=React;(function(){\\n'+js+'\\n;window.__genuiApp=typeof App==="function"?App:undefined})()})();window.__genuiOk=true;';
document.head.appendChild(s);s.remove();window.__agoraQuiet=false;
if(!window.__genuiOk||typeof window.__genuiApp!=='function'){return false}
lastCode=code;var App=window.__genuiApp;
if(!root)root=D.createRoot(document.getElementById('agora-sandbox-root'));
root.render(R.createElement(Boundary,{key:++seq,app:App,keep:lastGood,final:final},R.createElement(App)));
return true}
window.addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.token!==T||d.type!==TYPE)return;draw(String(d.code||''),d.final===true)});
var init=${initial};if(init){draw(init.code,init.final)}})();`;
}
