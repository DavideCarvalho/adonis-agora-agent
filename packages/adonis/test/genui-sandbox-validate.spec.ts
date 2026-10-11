import { describe, expect, it } from 'vitest';
import type { SandboxKitDocs } from '../src/genui/sandbox-kit.js';
import { formatSandboxIssue, validateSandboxCode } from '../src/genui/sandbox-validate.js';

const kit: SandboxKitDocs = {
  version: 2,
  jsx: true,
  components: [
    {
      name: 'Button',
      props: [
        { name: 'variant', type: '"default" | "outline"', required: false },
        { name: 'onClick', type: '() => void', required: false },
      ],
    },
    { name: 'Card', props: [{ name: 'title', type: 'string', required: false }], inherits: 'div' },
  ],
};

async function messages(
  props: Record<string, unknown>,
  options: Parameters<typeof validateSandboxCode>[1] = { kit },
): Promise<string[]> {
  return (await validateSandboxCode(props, options)).map(formatSandboxIssue);
}

describe('validateSandboxCode — jsx', () => {
  it('accepts a valid view with kit components, hooks and agent.send', async () => {
    expect(
      await messages({
        jsx: [
          "import { Button } from '@/kit';",
          'export default function App() {',
          '  const [n, setN] = useState(0);',
          '  return <Card title="x"><Button variant="outline" onClick={() => agent.send({ text: \'hi\', n })}>{n} &gt; 1</Button></Card>;',
          '}',
        ].join('\n'),
      }),
    ).toEqual([]);
  });

  it('a syntax error from the frame transpiler, at its line and column', async () => {
    expect(await messages({ jsx: 'function App() {\n  return <div><span></div>;\n}' })).toEqual([
      'jsx line 2:21: Expected </span>, found </div> — check that every JSX tag is closed in order',
    ]);
  });

  it('a JavaScript syntax error the transpiler passes through, at its line', async () => {
    const [issue] = await validateSandboxCode(
      { jsx: 'function App() {\n  foo(;\n  return <div/>;\n}' },
      { kit },
    );
    expect(issue).toMatchObject({ category: 'syntax', line: 2, column: 7 });
  });

  it('TypeScript gets a one-line fix', async () => {
    const [message] = await messages({ jsx: 'function App(): JSX.Element {\n  return <div/>;\n}' });
    expect(message).toMatch(
      /^jsx line 1:15: .* — plain JavaScript only: drop the TypeScript types$/,
    );
  });

  it('no App: refused, and a lone component is named to rename', async () => {
    expect(await messages({ jsx: 'function Calculator() {\n  return <div/>;\n}' })).toEqual([
      'jsx: no `App` — rename `function Calculator` to `function App`; App is what gets drawn',
    ]);
    expect(await messages({ jsx: 'const x = <div/>;' })).toEqual([
      'jsx: no `App` — define `function App() { return <…/>; }`; App is what gets drawn',
    ]);
  });

  it('`const App = () => …` counts as App', async () => {
    expect(await messages({ jsx: 'const App = () => <div/>;' })).toEqual([]);
  });

  it('a bridge other than agent.send is refused with the fix', async () => {
    expect(
      await messages({
        jsx: 'function App() {\n  return <button onClick={() => flippy.send({ a: 1 })}>x</button>;\n}',
      }),
    ).toEqual(['jsx line 2:33: `flippy.send` — the bridge is `agent.send(payload)`']);
  });

  it('agent.<anything but send> and window.<x>.send are refused too', async () => {
    const found = await messages({
      jsx: 'function App() {\n  agent.post({});\n  window.app.send(1);\n  return <div/>;\n}',
    });
    expect(found).toEqual([
      'jsx line 2:3: `agent.post` — the bridge has one method: `agent.send(payload)`',
      'jsx line 3:3: `window.app.send` — the bridge is `agent.send(payload)`',
    ]);
  });

  it('a .send on something the program declares is not a bridge', async () => {
    expect(
      await messages({
        jsx: 'function App() {\n  const socket = { send() {} };\n  socket.send(1);\n  return <div/>;\n}',
      }),
    ).toEqual([]);
  });

  it('a component the kit does not have is an error; a local one is not', async () => {
    expect(
      await messages({
        jsx: 'function Row() { return <div/>; }\nfunction App() {\n  return <Card><Row/><Slider/></Card>;\n}',
      }),
    ).toEqual([
      'jsx line 3:22: `<Slider>` is not a kit component — use one of `Button`, `Card`, or a plain element',
    ]);
  });

  it('a prop the component does not declare is a warning, listed after the errors', async () => {
    const issues = await validateSandboxCode(
      {
        jsx: 'function App() {\n  return <Button size="lg" data-x="1" className="a" onClick={() => {}}>x</Button>;\n}',
      },
      { kit },
    );
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        category: 'unknown-prop',
        line: 2,
        column: 18,
        message: '`<Button size>`: Button has no prop `size` (it takes `variant`, `onClick`)',
      }),
    ]);
  });

  it('a component that inherits an element takes any attribute', async () => {
    expect(
      await messages({ jsx: 'function App() { return <Card onMouseEnter={() => {}} />; }' }),
    ).toEqual([]);
  });

  it('without kit docs, components are not checked (JSX allowed by the option)', async () => {
    expect(
      await messages({ jsx: 'function App() { return <Anything/>; }' }, { jsx: true }),
    ).toEqual([]);
  });

  it('jsx is not checked when the view is the html (the longer field wins)', async () => {
    expect(
      await messages({
        jsx: 'function App() { return null }',
        html: '<div>a much longer view here…</div>',
      }),
    ).toEqual([]);
  });
});

describe('validateSandboxCode — html and scripts', () => {
  it('accepts valid html, scripts and handlers', async () => {
    expect(
      await messages(
        {
          html: '<button onclick="go(event)">Go</button>\n<script>\nfunction go() { agent.send({ text: "go" }) }\n</script>',
          jsFunctions: 'function a() { return 1 }',
          jsExpressions: ['a()', "document.body.dataset.x = 'y'"],
        },
        {},
      ),
    ).toEqual([]);
  });

  it('a syntax error in an inline script, at its line in the html', async () => {
    const [issue] = await validateSandboxCode(
      { html: '<div>x</div>\n<script>\nlet a = ;\n</script>' },
      {},
    );
    expect(issue).toMatchObject({ field: 'html', category: 'syntax', line: 3, column: 9 });
  });

  it('a syntax error in jsFunctions and in one jsExpressions entry', async () => {
    expect(
      await messages(
        { html: '<div/>', jsFunctions: 'function a( {', jsExpressions: ['ok()', 'if ('] },
        {},
      ),
    ).toEqual([
      'jsFunctions line 1:14: Unexpected token',
      'jsExpressions[1] line 1:5: Unexpected token',
    ]);
  });

  it('an inline handler that does not parse', async () => {
    const [message] = await messages({ html: '<button onclick="go(">x</button>' }, {});
    expect(message).toMatch(/^html line 1:\d+: .* in an inline handler$/);
  });

  it('a bridge other than agent.send, in a handler and in a script', async () => {
    expect(
      await messages(
        {
          html: '<button onclick="flippy.send({a:1})">x</button>\n<script>\nfunction go() { agent.post({}) }\n</script>',
        },
        {},
      ),
    ).toEqual([
      'html line 3:17: `agent.post` — the bridge has one method: `agent.send(payload)`',
      'html line 1:18: `flippy.send` — the bridge is `agent.send(payload)`',
    ]);
  });

  it('<script src> is refused unless the policy opens its origin', async () => {
    const html = '<script src="https://cdn.example.com/a.js"></script><div>ok</div>';
    expect(await messages({ html }, {})).toEqual([
      'html line 1:1: `<script src="https://cdn.example.com/a.js">` is blocked (the sandbox has no network) — inline the code instead',
    ]);
    expect(await messages({ html }, { scriptOrigins: ['https://*.example.com'] })).toEqual([]);
  });

  it('a script that is never closed', async () => {
    expect(await messages({ html: '<div/><script>let a = 1' }, {})).toEqual([
      'html line 1:7: `<script>` is never closed — end it with `</script>`',
    ]);
  });

  it('non-JavaScript script blocks are left alone', async () => {
    expect(
      await messages({ html: '<script type="application/json">{ not js</script>' }, {}),
    ).toEqual([]);
  });
});
