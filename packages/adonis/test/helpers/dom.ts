// A browser page for the React specs, installed by hand instead of through vitest's `jsdom`
// environment. That environment also swaps Node's `URL`, `AbortController` and friends for jsdom's,
// which breaks the AdonisJS app these specs boot in the same process (`fileURLToPath` refuses a
// jsdom `URL`; Node's `fetch` refuses a jsdom `AbortSignal`). React only needs a `window` and a
// `document`, so only those — and the DOM classes it looks up — are installed.
//
// react-dom decides whether it has a DOM when it is loaded, so the testing library is imported from
// HERE, after the page exists — a spec takes `act`/`renderHook`/`waitFor` from this module and
// cannot get the order wrong (an import sorter included).
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

const page = dom.window as unknown as Record<string, unknown>;
const scope = globalThis as unknown as Record<string, unknown>;

for (const name of [
  'window',
  'document',
  'HTMLElement',
  'HTMLIFrameElement',
  'Element',
  'Node',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  scope[name] = page[name];
}
// Node defines `navigator` as a getter-only global.
Object.defineProperty(globalThis, 'navigator', { value: page.navigator, configurable: true });
// What React asks before it lets a test drive state updates without warning.
scope.IS_REACT_ACT_ENVIRONMENT = true;

export const pageDocument = dom.window.document;

export const { act, renderHook, waitFor } = await import('@testing-library/react');
