import { decodeProtectedHeader } from 'jose';
import { JSDOM } from 'jsdom';
import { afterEach, assert, describe, it, vi } from 'vitest';
import { callOpenApi } from '../../src/poppy-client/api.js';
import { generateBlindSigningKey, localBlindSigner } from '../../src/poppy-client/blind.js';
import {
  authorizeBrowserJoin,
  browserJoinCode,
  browserSessionEndpoint,
} from '../../src/poppy-client/browser.js';
import {
  BrowserControl,
  type BrowserControlError,
  type ControlledBrowser,
  stepProbe,
  userStepFor,
} from '../../src/poppy-client/browser_control.js';
import { type CompanyClient, PoppyAgent } from '../../src/poppy-client/company.js';
import { ConversationClient } from '../../src/poppy-client/conversations.js';
import { connectMcp } from '../../src/poppy-client/mcp.js';
import { disclosuresOf, linksOf } from '../../src/poppy-client/message_extensions.js';
import {
  type ApprovalRequest,
  afterBrowserRepeat,
  approveInConversation,
  approveWebOperation,
  declineOf,
  formatApprovalHeader,
  lookupWebOperation,
  type OperationApprover,
  operationOf,
  operationRecord,
  operationSummaryText,
  parseOperation,
  parseOperationHeader,
  webOperationReference,
} from '../../src/poppy-client/operations.js';
import { completeDirectSignIn, startDirectSignIn } from '../../src/poppy-client/signin.js';
import { fetchSkill, untarGz, unzip } from '../../src/poppy-client/skills.js';
import { parseDictionary } from '../../src/poppy-client/structured_fields.js';
import { taskCoverage } from '../../src/poppy-client/task_coverage.js';
import type { EventMessage } from '../../src/poppy-client/types.js';
import { tarGz, zip } from './fixtures/archives.js';
import { rejects } from './fixtures/assert.js';
import { CHECK_IN_PAGE } from './fixtures/fake_company.js';
import { browse, type World, world } from './fixtures/setup.js';

vi.setConfig({ testTimeout: 20_000 });

let w: World;
afterEach(async () => w?.cleanup());
const noViolations = () => assert.deepEqual(w.fake.violations, []);

const ALL = { operations: '3', links: '1', disclosures: '1' };

/** An agent declaring `extensions`, deciding operations with `approve` (and recording each ask). */
function agentWith(
  approve?: OperationApprover,
  extensions: Record<string, string> = ALL,
  more: Partial<ConstructorParameters<typeof PoppyAgent>[0]> = {},
) {
  const asked: ApprovalRequest[] = [];
  const agent = new PoppyAgent({
    ...w.agent.opts,
    extensions,
    operations: approve
      ? {
          approve: (req) => {
            asked.push(req);
            return approve(req);
          },
        }
      : undefined,
    ...more,
  });
  return { agent, asked };
}

const byUser: OperationApprover = () => ({ approver: 'user', inputType: 'tap' });
const byAgent: OperationApprover = () => ({ approver: 'agent' });
const exchange = (c: CompanyClient) =>
  callOpenApi(c, {
    method: 'POST',
    path: '/exchanges',
    body: { item_id: 'itm_4Qa', replacement_sku: 'stormline-insulated-m' },
  });

async function signIn(c: CompanyClient, scope = 'orders:read orders:write') {
  const pending = await startDirectSignIn(c, scope);
  const back = await browse(pending.url);
  await completeDirectSignIn(c, pending, back.searchParams);
}

describe('Operations v3: wire format', () => {
  it('Poppy-Approval is an RFC 9651 Dictionary; input_type only with user', () => {
    const header = formatApprovalHeader({
      operation_id: 'exc_5Rt2',
      revision: '1791487200-k3Jd9Qx2mW8v',
      approver: 'user',
      approved_at: 1791487260,
      input_type: 'tap',
      reference: 'apr_01JD8ZK3Q9',
    });
    assert.equal(
      header,
      'operation_id="exc_5Rt2", revision="1791487200-k3Jd9Qx2mW8v", approver="user", approved_at=1791487260, input_type="tap", reference="apr_01JD8ZK3Q9"',
    );
    const parsed = parseDictionary(header);
    assert.equal(parsed.get('approved_at')?.value, 1791487260);
    const agent = formatApprovalHeader({
      operation_id: 'a',
      revision: 'b',
      approver: 'agent',
      input_type: 'tap',
    });
    assert.notInclude(agent, 'input_type');
  });

  it('Poppy-Operation: sid and ref Strings; a bad ref or field is ignored', () => {
    assert.deepEqual(parseOperationHeader('sid="ses_1", ref="exc_5Rt2.1791487200.k3Jd"'), {
      sid: 'ses_1',
      ref: 'exc_5Rt2.1791487200.k3Jd',
    });
    assert.isUndefined(parseOperationHeader('sid="ses_1", ref="has space"'));
    assert.isUndefined(parseOperationHeader(`sid="s", ref="${'a'.repeat(2049)}"`));
    assert.isUndefined(parseOperationHeader('sid=ses_1, ref="x"'));
    assert.isUndefined(parseOperationHeader('sid="s", ref="x",'));
    assert.isUndefined(parseOperationHeader('sid="s", ref="x"; "bad"'));
  });

  it('an operation needs an ID, a revision, object terms and an RFC 3339 expiry', () => {
    const ok = {
      operation_id: 'exc_1',
      revision: 'r1',
      terms: {},
      expires_at: '2026-10-08T12:20:00-07:00',
    };
    assert.ok(parseOperation(ok));
    assert.isUndefined(parseOperation({ ...ok, terms: [] }));
    assert.isUndefined(parseOperation({ ...ok, expires_at: 'tomorrow' }));
    assert.isUndefined(parseOperation({ ...ok, operation_id: 'has space' }));
    assert.isUndefined(parseOperation({ ...ok, summary: 3 }));
  });

  it('a summary shows links, images and HTML as text', () => {
    assert.equal(
      operationSummaryText('**Exchange** it. [Details](https://evil.example) ![x](y) <b>now</b>'),
      '**Exchange** it. \\[Details\\](https://evil.example) \\!\\[x\\](y) \\<b\\>now\\</b\\>',
    );
  });
});

describe('Operations v3: APIs', () => {
  it('approval_required → the User approves → the same request with Poppy-Approval → performed once', async () => {
    w = await world();
    const { agent, asked } = agentWith(byUser);
    const c = await agent.company(w.fake.domain);
    const res = await exchange(c);
    assert.equal(res.status, 201);
    assert.equal(res.operation?.status, 'performed');
    assert.deepEqual(w.fake.exchanges.length, 1);
    assert.lengthOf(asked, 1);
    const req = asked[0]!;
    assert.equal(req.company.name, 'Fake Co');
    assert.equal(req.via, 'api');
    assert.isFalse(req.userOnly);
    assert.deepEqual(req.asked.body, {
      item_id: 'itm_4Qa',
      replacement_sku: 'stormline-insulated-m',
    });
    assert.include(req.summaryText ?? '', '\\[Details\\]');
    const rec = operationRecord(c, req.operation.operation_id)!;
    assert.equal(rec.status, 'performed');
    assert.equal(rec.approvals[0]?.approver, 'user');
    assert.match(rec.approvals[0]?.reference ?? '', /^apr_/);
    noViolations();
  });

  it('nobody approves: not performed, and the 403 is what comes back', async () => {
    w = await world();
    const { agent } = agentWith(undefined);
    const c = await agent.company(w.fake.domain);
    const res = await exchange(c);
    assert.equal(res.status, 403);
    assert.equal(res.operation?.status, 'not_approved');
    assert.deepEqual(w.fake.exchanges, []);
    noViolations();
  });

  it('without the extension declared, no operation and no approval', async () => {
    w = await world();
    const { agent, asked } = agentWith(byUser, {});
    const c = await agent.company(w.fake.domain);
    const res = await exchange(c);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'extension_required', extension: 'operations' });
    assert.isUndefined(res.operation);
    assert.lengthOf(asked, 0);
    noViolations();
  });

  it('a declined agent approval is never sent again; the next revision needs the User', async () => {
    w = await world({ declineAgentApprovals: true });
    let answer: OperationApprover = byAgent;
    const { agent, asked } = agentWith((req) => answer(req));
    const c = await agent.company(w.fake.domain);
    const first = await exchange(c);
    assert.equal(first.operation?.status, 'declined');
    if (first.operation?.status !== 'declined') return;
    assert.equal(first.operation.decline.reason, 'Only the account holder can approve exchanges.');
    // The reference to an API the Company doesn't list is dropped (9.2).
    assert.deepEqual(first.operation.decline.alternative?.references, [
      { type: 'web', url: 'https://example.com/exchanges' },
    ]);
    assert.deepEqual(w.fake.exchanges, []);

    // Again: an agent decision is refused now, the User must approve.
    const second = await exchange(c);
    assert.equal(second.operation?.status, 'not_approved');
    assert.isTrue(asked[1]?.userOnly);
    assert.equal(asked[1]?.why, 'after_decline');
    answer = byUser;
    const third = await exchange(c);
    assert.equal(third.operation?.status, 'performed');
    assert.lengthOf(w.fake.exchanges, 1);
    noViolations();
  });

  it('new terms after an agent approval: the same instruction never approves them', async () => {
    w = await world();
    let calls = 0;
    const { agent, asked } = agentWith((req) => {
      calls++;
      if (calls === 1) {
        w.fake.price = 75; // the price moves before the approval arrives
        return { approver: 'agent' };
      }
      return req.userOnly ? { approver: 'user', inputType: 'voice' } : { approver: 'agent' };
    });
    const c = await agent.company(w.fake.domain);
    const res = await exchange(c);
    assert.equal(res.operation?.status, 'performed');
    assert.lengthOf(asked, 2);
    assert.notEqual(asked[0]?.operation.revision, asked[1]?.operation.revision);
    assert.isTrue(asked[1]?.userOnly);
    assert.equal(asked[1]?.why, 'new_terms_after_agent_approval');
    assert.deepEqual(
      (asked[1]!.operation.terms.price_difference as { amount: string }).amount,
      '75.00',
    );
    assert.lengthOf(w.fake.exchanges, 1);
    noViolations();
  });

  it('503 while performing: the same approval again, performed once', async () => {
    w = await world({ performing503Once: true });
    const { agent, asked } = agentWith(byUser);
    const c = await agent.company(w.fake.domain);
    const res = await exchange(c);
    assert.equal(res.status, 201);
    assert.equal(res.operation?.status, 'performed');
    assert.lengthOf(asked, 1);
    assert.lengthOf(w.fake.exchanges, 1);
    const rec = operationRecord(c, asked[0]!.operation.operation_id)!;
    assert.lengthOf(rec.approvals, 1, 'one approval, sent twice');
    noViolations();
  });

  it('a failed request answered with new terms: outcome unknown, nothing new approved', async () => {
    w = await world();
    w.fake.failFirstApprovalThenReprice = true;
    const { agent, asked } = agentWith(byUser);
    const c = await agent.company(w.fake.domain);
    const res = await exchange(c);
    assert.equal(res.operation?.status, 'unknown');
    assert.lengthOf(asked, 1, 'the User is not asked about the new terms yet');
    assert.deepEqual(w.fake.exchanges, []);
    noViolations();
  });

  it('expired terms are not approved', async () => {
    w = await world();
    const { agent, asked } = agentWith(byUser);
    const c = await agent.company(w.fake.domain);
    const { decideOperation } = await import('../../src/poppy-client/index.js');
    const outcome = await decideOperation(
      c,
      'api',
      { operation_id: 'exc_old', revision: 'r1', terms: {}, expires_at: '2020-01-01T00:00:00Z' },
      {},
    );
    assert.deepEqual('outcome' in outcome && outcome.outcome.status, 'expired');
    assert.lengthOf(asked, 0);
  });
});

describe('Operations v3: MCP', () => {
  it('isError + structuredContent.operation → the same tool, the approval in _meta', async () => {
    w = await world();
    const { agent, asked } = agentWith(byUser);
    const c = await agent.company(w.fake.domain);
    const conn = await connectMcp(c);
    try {
      const { result, operation } = await conn.callTool('exchange_item', {
        item_id: 'itm_4Qa',
        replacement_sku: 'stormline-insulated-m',
      });
      assert.equal(operation?.status, 'performed');
      assert.notEqual(result.isError, true);
      assert.lengthOf(asked, 1);
      assert.deepEqual(asked[0]?.asked, {
        tool: 'exchange_item',
        arguments: { item_id: 'itm_4Qa', replacement_sku: 'stormline-insulated-m' },
      });
      assert.lengthOf(w.fake.exchanges, 1);
    } finally {
      await conn.close();
    }
    noViolations();
  });

  it('declined over MCP; without the extension, an ordinary tool error', async () => {
    w = await world({ declineAgentApprovals: true });
    const { agent } = agentWith(byAgent);
    const c = await agent.company(w.fake.domain);
    const conn = await connectMcp(c);
    try {
      const { operation } = await conn.callTool('exchange_item', {
        item_id: 'itm_9',
        replacement_sku: 'x',
      });
      assert.equal(operation?.status, 'declined');
    } finally {
      await conn.close();
    }
    const plain = agentWith(byUser, {});
    const c2 = await plain.agent.company(w.fake.domain);
    const conn2 = await connectMcp(c2);
    try {
      const { result, operation } = await conn2.callTool('exchange_item', {
        item_id: 'itm_9',
        replacement_sku: 'x',
      });
      assert.isTrue(result.isError);
      assert.isUndefined(operation);
      assert.lengthOf(plain.asked, 0);
    } finally {
      await conn2.close();
    }
    noViolations();
  });
});

describe('Operations v3: conversations', () => {
  it('the operation in a Company message; the approval in extensions.operations', async () => {
    w = await world();
    const { agent, asked } = agentWith(byUser);
    const c = await agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const { conversation_id } = await conv.start({
      author: { type: 'agent' },
      text: 'Exchange my jacket for the insulated one',
    });
    const { events } = await conv.collect(conversation_id, { wait: 1 });
    const operation = events.map((e) => operationOf(e.message)).find(Boolean);
    assert.ok(operation, 'the Company asked for approval');
    assert.equal(operationRecord(c, operation!.operation_id)?.status, 'pending');
    const outcome = await approveInConversation(conv, conversation_id, operation!, {
      text: 'The user approved the exchange.',
    });
    assert.equal(outcome.status, 'sent');
    assert.equal(asked[0]?.via, 'conversation');
    const after = await conv.collect(conversation_id, { wait: 1 });
    const texts = after.events.map((e) => e.message?.text).filter(Boolean);
    assert.include(texts, 'Done: the exchange went through.');
    assert.lengthOf(w.fake.exchanges, 1);
    noViolations();
  });

  it('a decline comes in a later message and is remembered', async () => {
    w = await world({ declineAgentApprovals: true });
    const { agent } = agentWith(byAgent);
    const c = await agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const { conversation_id } = await conv.start({ author: { type: 'agent' }, text: 'exchange' });
    const { events } = await conv.collect(conversation_id, { wait: 1 });
    const operation = events.map((e) => operationOf(e.message)).find(Boolean)!;
    await approveInConversation(conv, conversation_id, operation);
    const after = await conv.collect(conversation_id, { wait: 1 });
    const decline = after.events.map((e) => declineOf(e.message, c)).find(Boolean);
    assert.equal(decline?.operation_id, operation.operation_id);
    assert.equal(operationRecord(c, operation.operation_id)?.status, 'declined');
    assert.isTrue(operationRecord(c, operation.operation_id)?.declined);
    assert.deepEqual(w.fake.exchanges, []);
    noViolations();
  });

  it('without the extension the Company answers in text; approval content is refused', async () => {
    w = await world();
    const { agent } = agentWith(byUser, { links: '1' });
    const c = await agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const { conversation_id } = await conv.start({ author: { type: 'agent' }, text: 'exchange' });
    const { events } = await conv.collect(conversation_id, { wait: 1 });
    assert.isUndefined(events.map((e) => operationOf(e.message)).find(Boolean));
    await rejects(
      () =>
        conv.send(conversation_id, {
          author: { type: 'agent' },
          extensions: { operations: { approval: {} } },
        }),
      /isn't an extension this agent uses/,
    );
    await rejects(
      () =>
        conv.send(conversation_id, {
          author: { type: 'agent' },
          extensions: { links: { items: [] } },
        }),
      /only Company messages carry links/,
    );
    noViolations();
  });
});

describe('Operations v3: websites', () => {
  /** Plays the agent's own browser: the join, then the exchange form. */
  async function joinBrowser(c: CompanyClient) {
    const endpoint = browserSessionEndpoint(c);
    const page = await fetch(endpoint);
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const code = browserJoinCode(await page.text());
    await authorizeBrowserJoin(c, code);
    const res = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ code }).toString(),
    });
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }
  const submitExchange = (origin: string, cookie: string, accept = 'text/html') =>
    fetch(`${origin}/shop/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, accept },
      body: 'item_id=itm_4Qa&replacement_sku=stormline-insulated-m',
    });

  it('403 + Poppy-Operation → the endpoint → approval recorded → the browser repeats', async () => {
    w = await world();
    const { agent, asked } = agentWith(byUser);
    const c = await agent.company(w.fake.domain);
    const cookie = await joinBrowser(c);
    const first = await submitExchange(w.fake.origin, cookie, 'application/json');
    assert.equal(first.status, 403);
    assert.deepEqual(await first.json(), { error: 'approval_required' });
    const reference = webOperationReference(c, first.headers);
    assert.ok(reference);
    // A header naming a Session this browser didn't join is ignored.
    assert.isUndefined(
      webOperationReference(c, {
        'poppy-operation': `sid="someone-else", ref="${reference!.ref}"`,
      }),
    );
    const asking = { method: 'POST', url: `${w.fake.origin}/shop/exchange` };
    const outcome = await approveWebOperation(c, reference!.ref, asking);
    assert.equal(outcome.status, 'recorded');
    assert.equal(asked[0]?.via, 'website');
    assert.deepEqual(await lookupWebOperation(c, reference!.ref), {
      kind: 'status',
      operationId: asked[0]!.operation.operation_id,
      status: 'approved',
    });
    const repeat = await submitExchange(w.fake.origin, cookie);
    assert.equal(repeat.status, 200);
    assert.deepEqual(await afterBrowserRepeat(c, reference!.ref, repeat.headers, asking), {
      status: 'done',
    });
    assert.lengthOf(w.fake.exchanges, 1);

    // The browser repeats once more (a retry): a new reference, but the first one was performed.
    const again = await submitExchange(w.fake.origin, cookie);
    assert.equal(again.status, 403);
    assert.deepEqual(await afterBrowserRepeat(c, reference!.ref, again.headers, asking), {
      status: 'performed',
    });
    assert.lengthOf(asked, 1, 'never approved again');
    assert.lengthOf(w.fake.exchanges, 1);
    noViolations();
  });

  it('an unknown reference is invalid_request', async () => {
    w = await world();
    const { agent } = agentWith(byUser);
    const c = await agent.company(w.fake.domain);
    assert.deepEqual(await lookupWebOperation(c, 'nope.nope'), { kind: 'invalid' });
    noViolations();
  });
});

describe('Links and Disclosures', () => {
  const shipped = async (extensions: Record<string, string>) => {
    const { agent } = agentWith(undefined, extensions);
    const c = await agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const { conversation_id } = await conv.start({
      author: { type: 'agent' },
      text: 'Has it shipped?',
    });
    const { events } = await conv.collect(conversation_id, { wait: 1 });
    const message = events.find((e) => e.message?.role === 'company')?.message as EventMessage;
    return { c, message };
  };

  it('read from Company messages when declared; HTTPS links only, each with its domain', async () => {
    w = await world();
    const { c, message } = await shipped({ links: '1', disclosures: '1' });
    assert.deepEqual(linksOf(c, message), [
      {
        url: `https://127.0.0.1.example/orders/ord_1/tracking`,
        domain: '127.0.0.1.example',
        title: 'Tracking',
      },
      { url: 'https://example.com/help/returns', domain: 'example.com' },
    ]);
    assert.deepEqual(disclosuresOf(c, message), [
      { text: 'Lithium batteries ship by ground only.' },
    ]);
    assert.notInclude(message.text ?? '', 'Lithium');
    assert.deepEqual(linksOf(c, { ...message, role: 'user' }), [], 'never from the User’s side');
    noViolations();
  });

  it('not declared: none sent, the notice comes in text', async () => {
    w = await world();
    const { c, message } = await shipped({});
    assert.isUndefined(message.extensions);
    assert.deepEqual(linksOf(c, message), []);
    assert.include(message.text ?? '', 'Lithium batteries ship by ground only.');
    noViolations();
  });
});

describe('Browser Control v1', () => {
  const dom = new JSDOM(CHECK_IN_PAGE);
  const doc = dom.window.document;
  const step = (id: string, action: 'fill' | 'activate' | 'submit') =>
    userStepFor(stepProbe(doc.getElementById(id)), action);

  it('marks: interaction controls, submission forms, form owners, unknown values', () => {
    assert.isNull(step('seat', 'fill'), 'a submission form’s field can be filled');
    assert.isNull(step('meal', 'fill'));
    assert.isNull(step('outside', 'fill'), 'a control owned through its form attribute');
    assert.equal(step('passport', 'fill'), 'interaction', 'a marked control is the User’s');
    assert.equal(step('submit', 'activate'), 'submission');
    assert.equal(step('label', 'activate'), 'submission', 'a span inside the submit button');
    assert.equal(step('more', 'activate'), 'submission', 'other buttons are left to the User too');
    assert.equal(step('check-in', 'submit'), 'submission');
    assert.equal(step('meal', 'submit'), 'submission', 'Enter in a field submits it');
    assert.equal(step('email', 'fill'), 'interaction', 'an interaction form');
    assert.equal(step('q', 'fill'), 'interaction', 'an unknown value is interaction');
    assert.equal(step('div-marked', 'activate'), 'interaction', 'submission off a form');
    assert.isNull(step('free', 'fill'));
    assert.isNull(step('go', 'activate'));
  });

  /** A jsdom "browser": init scripts run in every new document, in order. */
  function fakeBrowser(url: string) {
    const scripts: string[] = [];
    let page = new JSDOM('<!doctype html>', { url, runScripts: 'outside-only' });
    const browser: ControlledBrowser = {
      addInitScript: async (s) => {
        scripts.push(s);
      },
      evaluate: async (s) => page.window.eval(s),
    };
    const navigate = (to: string) => {
      page = new JSDOM('<!doctype html>', { url: to, runScripts: 'outside-only' });
      for (const s of scripts) page.window.eval(s);
      return page.window.eval('navigator.poppy?.controller');
    };
    return {
      browser,
      scripts,
      navigate,
      read: () => page.window.eval('navigator.poppy?.controller'),
    };
  }

  it('navigator.poppy.controller: agent, user while the User holds control, Company hosts only', async () => {
    w = await world();
    const { agent } = agentWith(undefined, { 'browser-control': '1' });
    const c = await agent.company(w.fake.domain);
    const host = new URL(w.fake.origin).hostname;
    const b = fakeBrowser(`http://${host}/`);
    const steps: unknown[] = [];
    const control = new BrowserControl(c, b.browser, { onUserStep: (s) => steps.push(s) });
    await control.attach();
    assert.equal(b.read(), 'agent');
    assert.equal(b.navigate(`http://${host}/orders`), 'agent');
    assert.isUndefined(b.navigate('http://elsewhere.example/'), 'not on another website');

    const submit = stepProbe(doc.getElementById('submit'));
    await rejects(() => control.guard(submit, 'activate'), /submit this form/);
    assert.deepEqual(steps, [{ kind: 'submission', action: 'activate' }]);

    await control.handToUser();
    assert.equal(b.navigate(`http://${host}/check-in`), 'user', 'new pages see it too');
    let err: BrowserControlError | undefined;
    try {
      await control.guard(stepProbe(doc.getElementById('free')), 'fill');
    } catch (e) {
      err = e as BrowserControlError;
    }
    assert.equal(err?.code, 'held_by_user');
    await control.userHandsBack();
    assert.equal(b.read(), 'agent');
    assert.equal(b.navigate(`http://${host}/`), 'agent');
    await control.guard(stepProbe(doc.getElementById('free')), 'fill');
  });

  it('a Session that does not declare it: no navigator.poppy', async () => {
    w = await world();
    const { agent } = agentWith(undefined, {});
    const c = await agent.company(w.fake.domain);
    const b = fakeBrowser(`http://${new URL(w.fake.origin).hostname}/`);
    const control = new BrowserControl(c, b.browser);
    await control.attach();
    assert.lengthOf(b.scripts, 0);
    assert.isUndefined(b.read());
  });
});

describe('Skills (9.4)', () => {
  it('fetched without credentials and verified: skill-md, tar.gz, zip, redirects', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const { skills } = await taskCoverage(c);
    const named = (n: string) => skills.find((s) => s.name === n)!;
    const md = await fetchSkill(c, named('manage-orders'));
    assert.include(md.skillMd, '# Orders');
    const tar = await fetchSkill(c, named('bundle'));
    assert.deepEqual([...tar.files.keys()].sort(), ['SKILL.md', 'scripts/run.sh']);
    assert.deepEqual([...tar.links], [['scripts/latest', 'scripts/run.sh']]);
    const z = await fetchSkill(c, named('bundle-zip'));
    assert.equal(new TextDecoder().decode(z.files.get('references/GUIDE.md')), 'guide');
    assert.equal((await fetchSkill(c, named('moved'))).skillMd, md.skillMd);
    noViolations();
  });

  it('refused: a digest mismatch, path traversal, a link out of the skill, too large', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const { skills } = await taskCoverage(c);
    const named = (n: string) => skills.find((s) => s.name === n)!;
    await rejects(() => fetchSkill(c, named('tampered')), /doesn't match its digest/);
    await rejects(() => fetchSkill(c, named('evil')), /path traversal/);
    await rejects(() => fetchSkill(c, named('escaping-link')), /points outside the skill/);
    const big = { ...named('bundle-zip'), digest: `sha256:${'0'.repeat(64)}` };
    await rejects(() => fetchSkill(c, big, { maxBytes: 10 }), /too large/);
  });

  it('archive checks: SKILL.md at the root, absolute paths, decompression bombs', () => {
    assert.throws(() => untarGz(tarGz([{ path: '/etc/x', data: 'x' }])), /absolute path/);
    assert.throws(
      () => untarGz(tarGz([{ path: 'SKILL.md', data: 'x'.repeat(5000) }]), 1000),
      /too large|bad_archive|not a valid/,
    );
    assert.throws(() => unzip(zip([{ path: 'a/../../b', data: 'x' }])), /path traversal/);
    const files = unzip(zip([{ path: 'SKILL.md', data: 'ok' }], true)).files;
    assert.equal(new TextDecoder().decode(files.get('SKILL.md')), 'ok');
  });
});

describe('identity: blind signing, Agent IDs, anonymous User IDs', () => {
  it('PS384 blind signing: client assertions and delegations, verified as ordinary PS384', async () => {
    const key = await generateBlindSigningKey(2048);
    w = await world({}, { keys: [], blindSigner: localBlindSigner(key) });
    const jwks = w.identity.jwks().keys;
    assert.deepEqual(
      jwks.map((k) => [k.kty, k.alg, k.kid]),
      [['RSA', 'PS384', key.kid]],
    );
    assert.notProperty(jwks[0]!, 'd');
    const c = await w.agent.company(w.fake.domain);
    await signIn(c);
    const res = await callOpenApi(c, { method: 'GET', path: '/orders' });
    assert.equal(res.status, 200);
    const delegation = c.state.delegation!.jwt;
    assert.equal(decodeProtectedHeader(delegation).alg, 'PS384');
    assert.equal(decodeProtectedHeader(await w.identity.clientAssertion(c.issuer)).alg, 'PS384');
    noViolations();
  });

  it('Agent IDs: one per named agent, stable, sharing the sign-in, a Session each', async () => {
    w = await world();
    const travel = new PoppyAgent({ ...w.agent.opts, agent: 'travel' });
    const shopping = new PoppyAgent({ ...w.agent.opts, agent: 'shopping' });
    const t = await travel.company(w.fake.domain);
    await signIn(t, 'orders:read');
    await callOpenApi(t, { method: 'GET', path: '/orders' });
    const s = await shopping.company(w.fake.domain);
    // Same User, same refresh token; another agent, another Session.
    assert.equal(s.userId, t.userId);
    assert.ok(s.accountToken);
    assert.equal((await callOpenApi(s, { method: 'GET', path: '/orders' })).status, 200);
    assert.notEqual(s.sessionId, t.sessionId);
    const sessions = [...w.fake.sessions.values()];
    const ids = sessions.map((x) => x.agentId);
    assert.lengthOf(new Set(ids), 2);
    assert.match(ids[0] ?? '', /^agt_/);
    assert.equal(t.agentId, (await travel.company(w.fake.domain)).agentId, 'stable');
    // An agent without a name sends none.
    const plain = await w.agent.company(w.fake.domain);
    await callOpenApi(plain, { method: 'GET', path: '/public' });
    assert.isUndefined([...w.fake.sessions.values()].at(-1)?.agentId);
    noViolations();
  });

  it('anonymous browsing: a new User ID, never a token, nothing saved, discarded', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    await signIn(c, 'orders:read');
    const anon = await c.anonymousSession();
    assert.notEqual(anon.userId, c.userId);
    const res = await callOpenApi(anon, { method: 'GET', path: '/public' });
    assert.deepEqual(res.body, { hello: 'world', signed_in: false });
    const last = [...w.fake.sessions.values()].at(-1)!;
    assert.equal(last.userId, anon.userId);
    assert.isUndefined(last.account);
    const saved = JSON.stringify(w.store.data);
    assert.notInclude(saved, anon.userId, 'never saved');
    assert.notEqual(anon.state.delegation?.key.kid, c.state.delegation?.key.kid);
    await rejects(
      () =>
        anon.applySignIn(
          { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' },
          'direct',
          'x',
        ),
      /never signs in/,
    );
    anon.discard();
    await rejects(() => callOpenApi(anon, { method: 'GET', path: '/public' }), /discarded/);
    noViolations();
  });
});

describe('the fake Company still flags violations', () => {
  it('bad approvals, Company-only content, a Session changing agent_id', async () => {
    w = await world();
    const { agent } = agentWith(undefined, ALL, { agent: 'travel' });
    const c = await agent.company(w.fake.domain);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      c.fetch(`${w.fake.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    await post(
      '/api/exchanges',
      { item_id: 'a', replacement_sku: 'b' },
      { 'poppy-approval': 'operation_id="x", revision="y", approver="agent", input_type="tap"' },
    );
    await post(
      '/api/exchanges',
      { item_id: 'a', replacement_sku: 'b' },
      { 'poppy-approval': 'nope=' },
    );
    await post('/poppy/conversations', {
      id: 'msg_violation_1',
      message: { author: { type: 'agent' }, extensions: { links: { items: [] }, other: {} } },
    });
    c.state.agentIds!.travel = 'agt_somebodyElseEntirely';
    await post('/api/exchanges', { item_id: 'a', replacement_sku: 'b' });
    const v = w.fake.violations.join('\n');
    assert.include(v, 'input_type sent with an agent approval');
    assert.include(v, 'Poppy-Approval is not a valid Dictionary');
    assert.include(v, 'the Personal Agent sent links content');
    assert.include(v, "extension content for other, which the request doesn't declare");
    assert.include(v, 'agent_id changed within a Session');
    w.fake.violations.length = 0;
  });
});
