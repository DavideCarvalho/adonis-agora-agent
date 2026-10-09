import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Card, Chart, Stack } from '../src/genui/builtins.js';
import {
  buildSandboxDocument,
  componentToText,
  defineCatalog,
  defineSandbox,
  genui,
  genuiTools,
  partialTree,
  previewHtml,
  readUiAction,
  SANDBOX_COMPONENT,
  Sandbox,
  sandboxAction,
  sandboxCsp,
  uiActionText,
  validateUiActionContext,
} from '../src/genui/index.js';
import { parsePartialJson } from '../src/partial-json.js';
import type { PartialToolInput, ToolInputPreview } from '../src/spi/tool.js';

function partial(text: string): PartialToolInput {
  const parsed = parsePartialJson(text);
  if (parsed === undefined) throw new Error(`not JSON: ${text}`);
  return {
    value: parsed.value,
    done: parsed.complete,
    isOpen: parsed.isOpen,
    pendingMember: parsed.pendingMember,
  };
}

const view = {
  initialHeight: 320,
  placeholderMessages: ['Setting up the splitter…', 'Wiring the buttons…'],
  title: 'Bill splitter',
  summary: 'Splits a bill between people, with tip.',
  css: '.total{font-weight:600}',
  html: '<div class="total" id="out">$0.00</div><button id="go">Ask</button>',
  jsFunctions: 'function split(t,n){return t/n}',
  jsExpressions: [
    'document.getElementById("out").textContent = split(120, 3)',
    'document.getElementById("go").onclick = () => agent.send({ text: "Split 3 ways", total: 120 })',
  ],
};

describe('the sandbox definition', () => {
  it('is an opt-in, model-facing leaf that streams partial and says it is a last resort', async () => {
    expect(Sandbox.name).toBe(SANDBOX_COMPONENT);
    expect(Sandbox.streaming).toBe('partial');
    expect(Sandbox.children).toBeUndefined();
    expect(Sandbox.description).toMatch(/LAST RESORT/);
    expect(Sandbox.description).toMatch(/agent\.send/);
    expect(Sandbox.description).toMatch(/No network at all/);
    const catalog = defineCatalog([Stack, Sandbox]);
    expect((await catalog.validate('Sandbox', view)).ok).toBe(true);
    // A typo the model makes is refused, not drawn.
    expect((await catalog.validate('Sandbox', { ...view, javascript: 'x' })).ok).toBe(false);
    expect((await catalog.validate('Sandbox', { css: 'x' })).ok).toBe(false);
  });

  it('describes the network the policy opens, and refuses an origin that is not one', () => {
    const maps = defineSandbox({
      policy: { allow: { images: ['https://tile.openstreetmap.org'] } },
    });
    expect(maps.description).toMatch(/images from https:\/\/tile\.openstreetmap\.org/);
    expect(maps.sandbox.allow?.images).toEqual(['https://tile.openstreetmap.org']);
    expect(() => defineSandbox({ policy: { allow: { connect: ['http://evil.test'] } } })).toThrow(
      /not an https origin/,
    );
    expect(() =>
      defineSandbox({ policy: { allow: { scripts: ["https://cdn.test 'unsafe-eval'"] } } }),
    ).toThrow(/not an https origin/);
  });

  it('prints its summary for a text channel, never its code', () => {
    const catalog = defineCatalog([Card, Sandbox]);
    const text = componentToText(catalog, 'Sandbox', view);
    expect(text).toContain('Bill splitter');
    expect(text).toContain('Splits a bill');
    expect(text).toContain('interactive');
    expect(text).not.toContain('function split');
    const tree = componentToText(catalog, 'genui:tree', {
      root: {
        type: 'Card',
        props: { title: 'Dinner' },
        children: [{ type: 'Sandbox', props: view }],
      },
    });
    expect(tree).toContain('Dinner');
    expect(tree).not.toContain('<div');
  });

  it('is added by genui({ sandbox: true }), last in the catalog the model is shown', async () => {
    const setup = await genui({ catalog: defineCatalog([Chart]), sandbox: true })({
      make: async () => {
        throw new Error('unused');
      },
    });
    expect(setup.catalog.modelComponents().map((c) => c.name)).toEqual(['Chart', 'Sandbox']);
    const description = setup.tools[0]?.spec.description ?? '';
    expect(description.indexOf('Chart')).toBeLessThan(description.indexOf('Sandbox'));
    const off = await genui({ catalog: defineCatalog([Chart]) })({
      make: async () => ({}) as never,
    });
    expect(off.catalog.has('Sandbox')).toBe(false);
  });
});

describe('the sandbox document', () => {
  const options = { token: 't0k', hostOrigin: 'https://app.test' };

  it('carries a CSP with no network by default, first in its head', () => {
    const csp = sandboxCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https?:/);
    const doc = buildSandboxDocument(view, { ...options, mode: 'live' });
    const head = doc.slice(0, doc.indexOf('</head>'));
    expect(head.indexOf('Content-Security-Policy')).toBeLessThan(head.indexOf('<script>'));
    expect(doc).toContain('agent=Object.freeze');
  });

  it('opens exactly the listed origins', () => {
    const csp = sandboxCsp({
      allow: { images: ['https://*.tile.example'], connect: ['https://api.example:8443'] },
    });
    expect(csp).toContain('img-src data: blob: https://*.tile.example');
    expect(csp).toContain('connect-src https://api.example:8443');
  });

  it('runs functions then expressions, in order, after the markup — and cannot be closed early', () => {
    const doc = buildSandboxDocument(
      { ...view, jsExpressions: ['console.log("</script><img src=x>")'] },
      { ...options, mode: 'live' },
    );
    const body = doc.slice(doc.indexOf('<body>'));
    expect(body.indexOf('id="out"')).toBeLessThan(body.indexOf('function split'));
    expect(body.indexOf('function split')).toBeLessThan(body.indexOf('console.log'));
    expect(body).toContain('<\\/script><img');
    expect(body.match(/<\/script>/g)?.length).toBe(2);
  });

  it('runs nothing in preview mode, and posts only to the host origin', () => {
    const doc = buildSandboxDocument(view, { ...options, mode: 'preview' });
    expect(doc).not.toContain('function split');
    expect(doc).toContain('"https://app.test"');
    expect(buildSandboxDocument(view, { ...options, mode: 'live', inlineJs: false })).not.toContain(
      'function split',
    );
  });

  it('makes half-written markup safe to preview', () => {
    expect(previewHtml('<div>a</div><scr')).toBe('<div>a</div>');
    expect(previewHtml('<p>x</p><script>alert(1)</script><b>y')).toBe('<p>x</p><b>y');
    expect(previewHtml('<style>p{}</st')).toBe('');
    expect(previewHtml('<p>5 &am')).toBe('<p>5 ');
    expect(previewHtml('<html><body><p>in</p></body></html>')).toBe('<p>in</p>');
  });
});

describe('streaming a sandbox', () => {
  const catalog = defineCatalog([Card, Sandbox]);
  const tree = {
    type: 'Card',
    props: { title: 'Dinner' },
    children: [{ type: 'Sandbox', props: view }],
  };
  const json = JSON.stringify(tree);
  const nodeAt = (text: string) => {
    // The card around it streams too: a `complete` layout would hold its whole subtree back.
    const result = partialTree(catalog, partial(text), { streaming: 'partial' });
    return result?.root?.children?.[0];
  };

  it('previews in field order, never with half-written CSS or code', () => {
    const cut = (marker: string, extra = 0) => json.slice(0, json.indexOf(marker) + extra);
    const height = nodeAt(cut('"placeholderMessages"'));
    expect(height?.props).toEqual({ initialHeight: 320 });
    expect(height?.incomplete).toBe(true);
    const midCss = nodeAt(cut('font-weight'));
    expect(midCss?.props.css).toBeUndefined();
    expect(midCss?.props.placeholderMessages).toEqual(view.placeholderMessages);
    const midHtml = nodeAt(cut('$0.00'));
    expect(midHtml?.props.css).toBe(view.css);
    expect(midHtml?.props.html).toBe('<div class=\\"total\\" id=\\"out\\">'.replace(/\\"/g, '"'));
    const midFunctions = nodeAt(cut('return t/n'));
    expect(midFunctions?.props.html).toBe(view.html);
    expect(midFunctions?.props.jsFunctions).toBeUndefined();
    const midSecond = nodeAt(cut('agent.send'));
    expect(midSecond?.props.jsFunctions).toBe(view.jsFunctions);
    expect(midSecond?.props.jsExpressions).toEqual([view.jsExpressions[0]]);
    const whole = partialTree(catalog, partial(json), { streaming: 'partial' })?.root
      ?.children?.[0];
    expect(whole?.props).toEqual(view);
    expect(whole?.incomplete).toBeUndefined();
  });

  it('previews a per-component call as a one-node tree', async () => {
    const [tool] = genuiTools(defineCatalog([Sandbox]), { mode: 'per-component' });
    expect(tool?.spec.name).toBe('ui__show_sandbox');
    const preview = (await tool?.handler.previewInput?.({
      actor: { id: 'u1' } as never,
      toolCallId: 'c1',
    } as never)) as ToolInputPreview;
    const body = JSON.stringify(view);
    const frame = preview.render(partial(body.slice(0, body.indexOf('return t/n'))));
    expect(frame?.component).toBe('genui:tree');
    const root = (frame?.props as { root: Record<string, unknown> } | undefined)?.root ?? {};
    expect(root).toMatchObject({ id: 'root', type: 'Sandbox', incomplete: true });
    expect((root.props as Record<string, unknown>).jsFunctions).toBeUndefined();
    expect((root.props as Record<string, unknown>).html).toBe(view.html);
  });
});

describe('UI actions', () => {
  it('turn a sandbox send into an action: text said, values carried', () => {
    const action = sandboxAction(
      { text: 'Split it 3 ways', action: 'split', total: 120, people: 3 },
      { title: 'Bill splitter', componentId: 'root.0' },
    );
    expect(action).toMatchObject({
      source: 'sandbox',
      name: 'split',
      text: 'Split it 3 ways',
      context: { total: 120, people: 3 },
      title: 'Bill splitter',
      componentId: 'root.0',
    });
    const text = uiActionText(action);
    expect(text.startsWith('Split it 3 ways')).toBe(true);
    expect(text).toContain('"total": 120');
    expect(text).toContain('UI action "split"');
  });

  it('refuse what is too large, not JSON or badly named', () => {
    expect(readUiAction({ name: 'go', context: { blob: 'x'.repeat(10_000) } })).toMatch(
      /at most 8192 bytes/,
    );
    expect(
      readUiAction({ name: 'go', context: { blob: 'x'.repeat(100) } }, { maxBytes: 64 }),
    ).toMatch(/at most 64/);
    expect(readUiAction({ name: 'drop table;', context: {} })).toMatch(/name/);
    expect(readUiAction({ name: 'go', context: [] })).toMatch(/context/);
    expect(readUiAction('go')).toMatch(/object/);
    expect(readUiAction({ name: 'go' })).toMatchObject({ name: 'go', context: {} });
  });

  it('check their values against a schema', async () => {
    const schema = z.object({ total: z.number().positive(), people: z.number().int().min(1) });
    const ok = await validateUiActionContext(sandboxAction({ total: 12, people: 2 }), schema);
    expect(ok).toEqual({ ok: true, context: { total: 12, people: 2 } });
    const bad = await validateUiActionContext(sandboxAction({ total: -1, people: 0 }), schema);
    expect(bad.ok).toBe(false);
  });
});
