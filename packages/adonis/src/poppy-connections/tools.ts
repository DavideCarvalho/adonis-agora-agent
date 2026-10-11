import type { StandardSchemaV1 } from '@standard-schema/spec';
import { ResourceAuthError } from '../poppy-client/index.js';
import type { AiToolCtx, ToolHandler, ToolPreflightResult } from '../spi/tool.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ToolSpec } from '../types.js';
import { normalizeDomain, type TwoStepConvention } from './config.js';
import { OAuthError, PoppyCompanyNotAllowedError, type PoppyConnections } from './service.js';

type JsonType = 'string' | 'object' | 'array';
interface Field {
  type: JsonType;
  description: string;
  items?: { type: 'string' };
}

/** A small Standard Schema for a flat object — what these tools take. */
function objectSchema<T>(
  fields: Record<string, Field>,
  required: string[],
): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'adonis-agora-agent',
      validate: (value: unknown) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return { issues: [{ message: 'must be an object' }] };
        }
        const v = value as Record<string, unknown>;
        for (const name of required) {
          if (v[name] === undefined || v[name] === '') {
            return { issues: [{ message: 'required', path: [name] }] };
          }
        }
        for (const [name, field] of Object.entries(fields)) {
          const x = v[name];
          if (x === undefined) continue;
          const ok =
            field.type === 'array'
              ? Array.isArray(x) && x.every((i) => typeof i === 'string')
              : field.type === 'object'
                ? x !== null && typeof x === 'object' && !Array.isArray(x)
                : typeof x === 'string';
          if (!ok) return { issues: [{ message: `must be ${field.type}`, path: [name] }] };
        }
        return { value: value as T };
      },
      jsonSchema: {
        input: () => ({
          type: 'object',
          properties: fields,
          required,
          additionalProperties: false,
        }),
      },
    },
  } as StandardSchemaV1<unknown, T>;
}

const company: Field = {
  type: 'string',
  description: 'The company, by its domain (as listed by the companies tool).',
};

/** What a failure tells the model — the next step, never a stack. */
function explain(prefix: string, error: unknown): Record<string, unknown> {
  if (error instanceof PoppyCompanyNotAllowedError) {
    return {
      error: 'not_allowed',
      message: `${error.domain} is not a company this assistant may use.`,
      next: `Call ${prefix}companies: it lists the companies you can use, by domain — use that domain exactly.`,
    };
  }
  if (error instanceof ResourceAuthError) {
    if (error.code === 'insufficient_scope') {
      return {
        error: 'needs_permission',
        scopes: (error.scope ?? '').split(' ').filter(Boolean),
        next: `Call ${prefix}connect with these scopes; the person approves them on the company.`,
      };
    }
    if (error.code === 'sign_in_required' || error.code === 'invalid_token') {
      return { error: 'not_connected', next: `Call ${prefix}connect first.` };
    }
  }
  if (error instanceof OAuthError && error.code === 'invalid_grant') {
    return {
      error: 'not_connected',
      message: 'The connection was revoked.',
      next: `Call ${prefix}connect.`,
    };
  }
  return { error: 'failed', message: error instanceof Error ? error.message : String(error) };
}

/**
 * A failure at a company the owner is not connected to (never connected, disconnected, revoked):
 * whatever the company answered (a 401 in any shape), the next step is to connect.
 */
async function explainAt(
  connections: PoppyConnections,
  owner: string,
  company: string,
  prefix: string,
  error: unknown,
): Promise<Record<string, unknown>> {
  const explained = explain(prefix, error);
  if (explained.error !== 'failed') return explained;
  const current = await connections.connection(owner, company).catch(() => null);
  if (current?.status === 'active') return explained;
  return {
    error: 'not_connected',
    message: `The person's account at ${normalizeDomain(company)} is not connected.`,
    next: `Call ${prefix}connect first.`,
  };
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`);
}

/** The JSON of `value`, cut for a confirmation card. */
function preview(value: unknown, max = 600): string {
  const json = JSON.stringify(value ?? {}, null, 2);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

interface CompanyInput {
  company: string;
}

const DEFAULT_TWO_STEP: TwoStepConvention = { confirm: 'confirm', token: 'confirmToken' };
const DEFAULT_SUMMARY_FIELDS = ['summary', 'resumo', 'message'];

type McpTool = { name: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } };

/** The convention when `tool` declares both of its fields, else null. */
function twoStepOf(tool: McpTool, convention: TwoStepConvention | false | undefined) {
  const c = convention === undefined ? DEFAULT_TWO_STEP : convention;
  if (c === false) return null;
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return props && c.confirm in props && c.token in props ? c : null;
}

function textOf(result: unknown): string {
  const raw = (result as { content?: unknown }).content;
  const content = Array.isArray(raw) ? raw : [];
  return content
    .map((part) =>
      (part as { type?: string }).type === 'text'
        ? String((part as { text?: string }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** A two-step preview: the token to commit with and a summary for the card, or null. */
function previewOf(
  text: string,
  convention: TwoStepConvention,
): { token: string; summary: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const body = parsed as Record<string, unknown>;
  const token = body[convention.token];
  if (typeof token !== 'string' || token === '') return null;
  const field = (convention.summary ?? DEFAULT_SUMMARY_FIELDS).find(
    (f) => typeof body[f] === 'string' && body[f] !== '',
  );
  return { token, summary: field ? (body[field] as string) : null };
}

export interface CallCompanyToolOptions {
  prefix?: string;
  /** The Company's two-step confirmation convention (default `confirm` / `confirmToken`); `false` = off. */
  twoStep?: TwoStepConvention | false;
}

/**
 * Runs a company MCP tool for `owner` and words the outcome for the model (`readOnly` refuses a
 * tool the company does not mark `readOnlyHint`). For apps that build their own confirmed tools.
 *
 * A write (`readOnly: false`) to a tool that confirms in two steps (see `tools.twoStep`) is
 * committed: the call is made for its preview, then again with `confirm` and the fresh token —
 * call it only once the person has confirmed.
 */
export async function callCompanyTool(
  connections: PoppyConnections,
  owner: string,
  input: CompanyInput & { tool: string; arguments?: Record<string, unknown> },
  readOnly: boolean,
  options: string | CallCompanyToolOptions = {},
): Promise<Record<string, unknown>> {
  const opts = typeof options === 'string' ? { prefix: options } : options;
  const prefix = opts.prefix ?? 'poppy_';
  try {
    const conn = await connections.mcp(owner, input.company);
    try {
      const { tools } = await conn.client.listTools();
      const tool = tools.find((t) => t.name === input.tool);
      if (!tool)
        return { error: 'unknown_tool', message: `${input.company} has no tool ${input.tool}` };
      if (readOnly && tool.annotations?.readOnlyHint !== true) {
        return {
          error: 'not_read_only',
          next: `${input.tool} can change things: use ${prefix}write (the person confirms).`,
        };
      }
      const args = input.arguments ?? {};
      let result = await conn.client.callTool({ name: input.tool, arguments: args });
      const twoStep = readOnly ? null : twoStepOf(tool as McpTool, opts.twoStep);
      if (twoStep && !result.isError && args[twoStep.confirm] === undefined) {
        const pending = previewOf(textOf(result), twoStep);
        if (pending) {
          result = await conn.client.callTool({
            name: input.tool,
            arguments: { ...args, [twoStep.confirm]: true, [twoStep.token]: pending.token },
          });
        }
      }
      const text = textOf(result);
      return { ...(result.isError ? { error: 'tool_error' } : {}), result: text };
    } finally {
      await conn.close().catch(() => {});
    }
  } catch (error) {
    return explainAt(connections, owner, input.company, prefix, error);
  }
}

/**
 * The Company's own preview of a two-step write, for the confirmation card — nothing is written.
 * Null when the tool does not confirm in two steps, or the preview did not come back.
 */
export async function previewCompanyWrite(
  connections: PoppyConnections,
  owner: string,
  input: CompanyInput & { tool: string; arguments?: Record<string, unknown> },
  twoStep?: TwoStepConvention | false,
): Promise<{ summary: string | null } | null> {
  const conn = await connections.mcp(owner, input.company);
  try {
    const { tools } = await conn.client.listTools();
    const tool = tools.find((t) => t.name === input.tool);
    const convention = tool ? twoStepOf(tool as McpTool, twoStep) : null;
    const args = input.arguments ?? {};
    if (!convention || args[convention.confirm] !== undefined) return null;
    const result = await conn.client.callTool({ name: input.tool, arguments: args });
    if (result.isError) return null;
    const pending = previewOf(textOf(result), convention);
    return pending ? { summary: pending.summary } : null;
  } finally {
    await conn.close().catch(() => {});
  }
}

/** One exchange with the company's agent for `owner`, worded for the model (`act: false` = read-only token). */
export async function talkToCompany(
  connections: PoppyConnections,
  owner: string,
  input: CompanyInput & { message: string },
  act: boolean,
  prefix = 'poppy_',
): Promise<Record<string, unknown>> {
  try {
    const reply = await connections.ask(owner, input.company, input.message, { act });
    const out: Record<string, unknown> = {
      reply: reply.replies
        .map((r) => r.text)
        .filter(Boolean)
        .join('\n\n'),
      status: reply.status,
    };
    const actions = reply.replies.flatMap((r) =>
      Array.isArray(r.data?.actions) ? (r.data.actions as unknown[]) : [],
    );
    if (actions.length > 0) out.actions = actions;
    if (reply.authorization) {
      if (reply.authorization.error === 'no_read_scope') {
        out.error = 'needs_permission';
        out.next = `The connection has no read-only permission: call ${prefix}connect, or ${prefix}request (confirmed).`;
      } else if (!act && reply.authorization.error === 'insufficient_scope') {
        out.error = 'needs_action';
        out.next = `That needs the company to act: use ${prefix}request with the same message (the person confirms), or ${prefix}connect if it still lacks permission${reply.authorization.scope ? ` (${reply.authorization.scope})` : ''}.`;
      } else {
        out.error =
          reply.authorization.error === 'sign_in_required' ? 'not_connected' : 'needs_permission';
        if (reply.authorization.scope) out.scopes = reply.authorization.scope.split(' ');
        out.next = `Call ${prefix}connect${reply.authorization.scope ? ' with these scopes' : ''}.`;
      }
    }
    return out;
  } catch (error) {
    return explain(prefix, error);
  }
}

/**
 * Registers the tools a turn uses to work with OTHER Poppy Companies for its user. Reads run at
 * once; anything that can change something at a Company (`write`, `request`, `disconnect`) is an
 * `action` — it goes through this app's confirmation (a card with Confirm/Cancel, or the channel's
 * text approval), never silently. `connect` is an action too: its card carries the link, and
 * completing the sign-in decides it, so the conversation resumes on its own.
 */
export function registerPoppyConnectionTools(
  registry: ToolRegistry,
  connections: PoppyConnections,
  options: {
    prefix?: string;
    roles?: string[];
    /** An authorization ability every tool declares (for an ability-aware `RolesPolicy`). */
    ability?: string;
    /**
     * `'action'` (default): `connect` is an action whose card carries the link, and completing the
     * sign-in decides it (the turn resumes). `'link'`: a read tool returning the link — for loops
     * that do not park on approvals; the person says when they are done.
     */
    connect?: 'action' | 'link';
    /**
     * Register `write`, `request` and `disconnect` (actions). `false` for a loop that confirms writes
     * its own way: build them on {@link callCompanyTool} / {@link talkToCompany}.
     */
    writes?: boolean;
    /** The Companies' two-step confirmation convention (see `tools.twoStep`). */
    twoStep?: TwoStepConvention | false;
  } = {},
): string[] {
  const p = options.prefix ?? 'poppy_';
  const roles = {
    ...(options.roles !== undefined ? { roles: options.roles } : {}),
    ...(options.ability !== undefined ? { ability: options.ability } : {}),
  };
  const texts = connections.texts;
  const owner = (ctx: AiToolCtx) => connections.ownerOf(ctx.actor);
  const names: string[] = [];
  const notAllowed = (domain: string) =>
    `${domain} is not a company this assistant may use. Call ${p}companies for the domains you can use.`;
  const writeTools = new Set([`${p}write`, `${p}request`, `${p}disconnect`]);
  const register = <I>(
    spec: Omit<ToolSpec, 'inputSchema'> & { inputSchema: StandardSchemaV1<unknown, I> },
    raw: ToolHandler<I>,
  ) => {
    if (options.writes === false && writeTools.has(spec.name)) return;
    const handler = resolved(raw);
    if (options.connect === 'link' && spec.name === `${p}connect`) {
      const prepare = handler.preflight!;
      registry.register(
        {
          ...spec,
          ...roles,
          kind: 'read',
          description:
            'Connect the person’s account at a company (or ask for more permissions there): returns a link they open to sign in at the company. Give them the link; once they say they finished, continue.',
        } as ToolSpec,
        {
          async execute(input: unknown, ctx: AiToolCtx) {
            const pre = await prepare(input as I, ctx, { phase: 'prepare' });
            if (pre.status === 'completed') return pre.output;
            if (pre.status === 'denied') return { error: 'not_allowed', message: pre.reason };
            const id = connections.connectIdFor(
              `${ctx.runId}:${ctx.toolCallId ?? (input as CompanyInput).company}`,
            );
            return {
              connected: false,
              company: normalizeDomain((input as CompanyInput).company),
              link: connections.connectUrl(id),
              next: 'Send the person this link to sign in at the company; continue once they say they finished.',
            };
          },
        } as ToolHandler,
      );
      names.push(spec.name);
      return;
    }
    registry.register({ ...spec, ...roles } as ToolSpec, handler as ToolHandler);
    names.push(spec.name);
  };
  // Every tool takes the company as the model named it; resolve it to the allow-listed domain.
  const resolved = <I>(handler: ToolHandler<I>): ToolHandler<I> => {
    const fix = async (input: I, ctx: AiToolCtx): Promise<I> => {
      const company = (input as { company?: unknown }).company;
      if (typeof company !== 'string') return input;
      return { ...input, company: await connections.resolveCompany(owner(ctx), company) };
    };
    return {
      ...handler,
      execute: async (input, ctx) => handler.execute(await fix(input, ctx), ctx),
      ...(handler.preflight
        ? {
            preflight: async (input: I, ctx: AiToolCtx, phase: unknown) =>
              handler.preflight!(await fix(input, ctx), ctx, phase as never),
          }
        : {}),
    } as ToolHandler<I>;
  };

  register<Record<string, never>>(
    {
      name: `${p}companies`,
      kind: 'read',
      description:
        'Companies (other apps and services) you can work with on the person’s behalf, and whether their account there is connected. Start here when the person asks for something at another company.',
      inputSchema: objectSchema({}, []),
    },
    {
      async execute(_input, ctx) {
        const connected = await connections.list(owner(ctx));
        return {
          companies: await Promise.all(
            connections.allowedCompanies().map(async (c) => {
              const found = connected.find((x) => x.domain === c.domain);
              // Its name even before connecting (its `poppy.json`), so the model can match it.
              const organization =
                found?.organization ?? (await connections.organizationOf(c.domain));
              return {
                company: c.domain,
                ...(c.label !== undefined ? { label: c.label } : {}),
                ...(organization !== undefined ? { organization } : {}),
                connected: found?.status === 'active',
                scopes: found?.status === 'active' ? found.scope.split(' ').filter(Boolean) : [],
              };
            }),
          ),
        };
      },
    },
  );

  register<CompanyInput & { scopes?: string[] }>(
    {
      name: `${p}connect`,
      kind: 'action',
      // The card lives as long as its sign-in link, not as long as a Confirm button.
      approvalTtlMs: connections.connectTtlMs,
      description:
        'Connect the person’s account at a company (or ask for more permissions there): they get a link, sign in at the company and choose what to allow. The conversation continues once they finish. Use when a tool answered not_connected or needs_permission.',
      inputSchema: objectSchema(
        {
          company,
          scopes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Permissions to ask for (from needs_permission). Omit for the defaults.',
          },
        },
        ['company'],
      ),
    },
    {
      async preflight(input, ctx): Promise<ToolPreflightResult> {
        const domain = normalizeDomain(input.company);
        if (connections.policy(domain) === null) {
          return { status: 'denied', reason: notAllowed(domain) };
        }
        const current = await connections.connection(owner(ctx), domain);
        const granted = new Set((current?.scope ?? '').split(' '));
        const wanted = input.scopes ?? [];
        if (current?.status === 'active' && wanted.every((s) => granted.has(s))) {
          return {
            status: 'completed',
            output: {
              connected: true,
              company: domain,
              organization: current.organization,
              scopes: [...granted].filter(Boolean),
            },
          };
        }
        try {
          const started = await connections.startConnect({
            actor: ctx.actor,
            domain,
            ...(wanted.length > 0 ? { scope: wanted.join(' ') } : {}),
            threadId: ctx.threadId,
            runId: ctx.runId,
            ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
            id: connections.connectIdFor(`${ctx.runId}:${ctx.toolCallId ?? domain}`),
          });
          const values = { company: started.organization, link: started.url };
          return {
            status: 'ready',
            confirmation: {
              title: fill(texts.confirmConnectTitle, values),
              verb: fill(texts.confirmConnectVerb, values),
              detail: fill(texts.confirmConnectDetail, values),
              // The action is opening the link (finishing the sign-in decides the card).
              link: started.url,
            },
          };
        } catch (error) {
          return {
            status: 'denied',
            reason: String(explain(p, error).message ?? (error as Error).message),
          };
        }
      },
      async execute(input, ctx) {
        const domain = normalizeDomain(input.company);
        const current = await connections.connection(owner(ctx), domain);
        if (current?.status === 'active') {
          return {
            connected: true,
            company: domain,
            organization: current.organization,
            scopes: current.scope.split(' ').filter(Boolean),
          };
        }
        const id = connections.connectIdFor(`${ctx.runId}:${ctx.toolCallId ?? domain}`);
        return {
          connected: false,
          company: domain,
          link: connections.connectUrl(id),
          message: 'Not connected yet: the person has to open the link and sign in.',
        };
      },
    },
  );

  register<CompanyInput>(
    {
      name: `${p}tools`,
      kind: 'read',
      description:
        'The tools a connected company offers (its MCP server): name, description, whether it only reads, and its input schema. Read-only ones run with the read tool; the others with the write tool, which the person confirms.',
      inputSchema: objectSchema({ company }, ['company']),
    },
    {
      async execute(input, ctx) {
        try {
          const conn = await connections.mcp(owner(ctx), input.company);
          try {
            const { tools } = await conn.client.listTools();
            return {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description ?? '',
                readOnly: t.annotations?.readOnlyHint === true,
                inputSchema: t.inputSchema,
              })),
            };
          } finally {
            await conn.close().catch(() => {});
          }
        } catch (error) {
          return explainAt(connections, owner(ctx), input.company, p, error);
        }
      },
    },
  );

  const toolInput = objectSchema<
    CompanyInput & { tool: string; arguments?: Record<string, unknown> }
  >(
    {
      company,
      tool: { type: 'string', description: 'The company tool’s name (from the tools tool).' },
      arguments: { type: 'object', description: 'Its arguments, as its input schema says.' },
    },
    ['company', 'tool'],
  );

  register(
    {
      name: `${p}read`,
      kind: 'read',
      description:
        'Run a READ-ONLY tool of a connected company (readOnly: true in the tools list).',
      inputSchema: toolInput,
    },
    {
      execute: (input, ctx) => callCompanyTool(connections, owner(ctx), input, true, { prefix: p }),
    },
  );

  register(
    {
      name: `${p}write`,
      kind: 'action',
      description:
        'Run a company tool that can CHANGE something there. The person confirms it first. Use only for what they asked.',
      inputSchema: toolInput,
    },
    {
      async preflight(input, ctx): Promise<ToolPreflightResult> {
        const domain = normalizeDomain(input.company);
        if (connections.policy(domain) === null) {
          return { status: 'denied', reason: notAllowed(domain) };
        }
        const current = await connections.connection(owner(ctx), domain);
        if (current?.status !== 'active') {
          return {
            status: 'denied',
            reason: `Not connected to ${domain}: call ${p}connect first.`,
          };
        }
        // A two-step Company words the change itself: its preview goes on the card (nothing is
        // written yet); confirming commits it with a fresh token.
        const companyPreview = await previewCompanyWrite(
          connections,
          owner(ctx),
          input,
          options.twoStep,
        ).catch(() => null);
        const args = preview(input.arguments);
        return {
          status: 'ready',
          confirmation: {
            title: fill(texts.confirmWriteTitle, {
              company: current.organization,
              tool: input.tool,
            }),
            verb: texts.confirmVerb,
            detail: companyPreview?.summary ? `${companyPreview.summary}\n\n${args}` : args,
          },
        };
      },
      execute: (input, ctx) =>
        callCompanyTool(connections, owner(ctx), input, false, {
          prefix: p,
          ...(options.twoStep !== undefined ? { twoStep: options.twoStep } : {}),
        }),
    },
  );

  const messageInput = objectSchema<CompanyInput & { message: string }>(
    {
      company,
      message: { type: 'string', description: 'What to say to the company’s assistant.' },
    },
    ['company', 'message'],
  );

  register(
    {
      name: `${p}ask`,
      kind: 'read',
      description:
        'Ask a company’s own assistant a question (read-only: it cannot change anything with this). Answers what its tools cannot: policies, status, availability.',
      inputSchema: messageInput,
    },
    { execute: (input, ctx) => talkToCompany(connections, owner(ctx), input, false, p) },
  );

  register(
    {
      name: `${p}request`,
      kind: 'action',
      description:
        'Ask a company’s assistant to DO something on the person’s account there. The person confirms the message first.',
      inputSchema: messageInput,
    },
    {
      async preflight(input, ctx): Promise<ToolPreflightResult> {
        const domain = normalizeDomain(input.company);
        if (connections.policy(domain) === null) {
          return { status: 'denied', reason: notAllowed(domain) };
        }
        const current = await connections.connection(owner(ctx), domain);
        return {
          status: 'ready',
          confirmation: {
            title: fill(texts.confirmRequestTitle, { company: current?.organization ?? domain }),
            verb: texts.confirmVerb,
            detail: input.message,
          },
        };
      },
      execute: (input, ctx) => talkToCompany(connections, owner(ctx), input, true, p),
    },
  );

  register<CompanyInput>(
    {
      name: `${p}disconnect`,
      kind: 'action',
      description:
        'Disconnect the person’s account at a company (revokes this assistant’s access there).',
      inputSchema: objectSchema({ company }, ['company']),
    },
    {
      async preflight(input, ctx): Promise<ToolPreflightResult> {
        const current = await connections.connection(owner(ctx), input.company);
        if (current?.status !== 'active') {
          return {
            status: 'completed',
            output: { disconnected: true, company: normalizeDomain(input.company) },
          };
        }
        return {
          status: 'ready',
          confirmation: {
            title: fill(texts.confirmDisconnectTitle, { company: current.organization }),
            verb: texts.confirmVerb,
          },
        };
      },
      async execute(input, ctx) {
        try {
          await connections.disconnect(owner(ctx), input.company);
          return { disconnected: true, company: normalizeDomain(input.company) };
        } catch (error) {
          return explain(p, error);
        }
      },
    },
  );

  return names;
}
