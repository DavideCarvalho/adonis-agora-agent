import type { HttpContext } from '@adonisjs/core/http';
import { decodeInterruptId } from '../ag-ui/core/interrupt-id.js';
import { agUiEvents } from '../ag-ui/stream.js';
import { type UiAction, uiActionText } from '../genui/actions.js';
import { validateUiCapabilities } from '../genui/capabilities.js';
import type { ProtocolAdapter, ProtocolAdapterHost } from '../spi/protocol-adapter.js';
import {
  A2UI_APPROVE_ACTION,
  A2UI_REJECT_ACTION,
  A2uiProjector,
  type A2uiServerMessage,
  type A2uiStreamOptions,
  a2uiThreadReplay,
  negotiateA2uiCatalog,
  readA2uiAction,
  readA2uiClientCapabilities,
} from './core.js';

export interface A2uiAdapterOptions extends A2uiStreamOptions {
  /** Where the route mounts, under the agent's path. Default `'a2ui'` → `POST <path>/a2ui`. */
  path?: string;
  /** As `agUiAdapter`'s: how long a run waiting on a person may stay silent before the stream ends. */
  quietMs?: number;
  /** Largest action accepted, as JSON, in bytes. Default 8192. */
  maxActionBytes?: number;
  /** Largest `a2uiClientDataModel` accepted, as JSON, in bytes. Default 32768. */
  maxDataModelBytes?: number;
}

const VIA = 'a2ui';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A field of the body, or of its A2A-style `metadata` (where A2UI puts client capabilities). */
function bodyField(body: Record<string, unknown>, key: string): unknown {
  if (body[key] !== undefined) return body[key];
  return isRecord(body.metadata) ? body.metadata[key] : undefined;
}

/** `a2uiClientDataModel` (`{ version, surfaces: { <surfaceId>: model } }`): its surfaces, or why not. */
function readDataModel(
  raw: unknown,
  maxBytes: number,
): Record<string, unknown> | undefined | string {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !isRecord(raw.surfaces)) {
    return 'a2uiClientDataModel carries { version, surfaces }';
  }
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(raw.surfaces)).length;
  } catch {
    return 'a2uiClientDataModel must be JSON';
  }
  if (size > maxBytes) {
    return `a2uiClientDataModel may be at most ${maxBytes} bytes (this one is ${size})`;
  }
  return Object.keys(raw.surfaces).length > 0 ? raw.surfaces : undefined;
}

/**
 * Serve the agent as an A2UI (https://a2ui.org, v0.9) agent: `POST <path>/a2ui` answers with the
 * run as a JSON Lines stream of A2UI server-to-client messages — `createSurface`,
 * `updateComponents`, `updateDataModel`, `deleteSurface` — that any A2UI renderer draws.
 *
 * ```ts
 * import { a2uiAdapter } from '@adonis-agora/agent/a2ui'
 *
 * export default defineConfig({ adapters: [a2uiAdapter()] })
 * ```
 *
 * The body is `{ threadId?, message?, action?, uiCapabilities?, a2uiClientCapabilities?,
 * a2uiClientDataModel?, agent? }` (the two A2UI fields also read from `metadata`, A2A-style):
 *  - `message` — the user's text;
 *  - `action` — an A2UI client message (`{ version: 'v0.9', action: { name, surfaceId,
 *    sourceComponentId, timestamp, context } }`, or v0.8's `{ userAction }`): it becomes the turn
 *    (`uiActionText`). `agora.approve` / `agora.reject` with `context.interruptId` decide the
 *    approval a previous stream ended on, and stream the rest of that run;
 *  - `threadId` — continue that thread (its owner is checked), or start one under that id;
 *  - `a2uiClientCapabilities` — the catalogs the client draws (`{ 'v0.9': { supportedCatalogIds } }`,
 *    what `MessageProcessor.getRendererCapabilities()` builds): the basic catalog is sent under the
 *    id the client lists for it;
 *  - `a2uiClientDataModel` — the data models of surfaces created with `sendDataModel`, handed to the
 *    prompt builder as `pageContext.a2uiDataModel`.
 *
 * `GET <path>/a2ui/threads/:threadId` answers a stored thread as `{ threadId, entries }`
 * ({@link a2uiThreadReplay}): what a client draws again after a reload.
 *
 * Response headers name the library's ids: `X-Agent-Thread-Id`, `X-Agent-Run-Id`. Authenticated and
 * owner-scoped exactly as `chat` is.
 */
export function a2uiAdapter(options: A2uiAdapterOptions = {}): ProtocolAdapter {
  const path = (options.path ?? 'a2ui').replace(/^\/+|\/+$/g, '');
  const { path: _path, quietMs, maxActionBytes, maxDataModelBytes, ...configured } = options;
  return {
    name: 'a2ui',
    mount(host) {
      const { service } = host;
      host.get(`${path}/threads/:threadId`, async (ctx: HttpContext) => {
        const query = ctx.request.qs() as Record<string, unknown>;
        const agentName =
          typeof query.agent === 'string' && query.agent.length > 0 ? query.agent : undefined;
        const actor = await host.resolveActor(ctx, agentName ?? host.defaultAgentName);
        if (actor === null) return;
        const threadId = String(ctx.params.threadId);
        const owner = await service.threadOwner(threadId);
        if (owner === null) return ctx.response.json({ threadId, entries: [] });
        if (!(await host.assertOwner(ctx, actor, owner, 'thread'))) return;
        const thread = await service.getThread(threadId, actor);
        const supported =
          typeof query.catalog === 'string'
            ? [query.catalog]
            : Array.isArray(query.catalog)
              ? query.catalog.filter((id): id is string => typeof id === 'string')
              : undefined;
        return ctx.response.json({
          threadId,
          entries: a2uiThreadReplay(thread?.messages ?? [], {
            ...negotiateA2uiCatalog(configured, supported),
            ...(configured.catalog === undefined && host.genuiCatalog !== undefined
              ? { catalog: host.genuiCatalog }
              : {}),
          }),
        });
      });
      host.post(path, async (ctx: HttpContext) => {
        const body = ctx.request.body() as Record<string, unknown>;
        const agentName =
          typeof body.agent === 'string' && body.agent.length > 0 ? body.agent : undefined;
        const actor = await host.resolveActor(ctx, agentName ?? host.defaultAgentName);
        if (actor === null) return;
        const projection = negotiateA2uiCatalog(
          configured,
          readA2uiClientCapabilities(bodyField(body, 'a2uiClientCapabilities')),
        );
        const dataModel = readDataModel(
          bodyField(body, 'a2uiClientDataModel'),
          maxDataModelBytes ?? 32768,
        );
        if (typeof dataModel === 'string') {
          return ctx.response.badRequest({ message: dataModel, code: 'invalid_data_model' });
        }

        let action: UiAction | undefined;
        if (body.action !== undefined) {
          const read = isRecord(body.action)
            ? readA2uiAction(body.action, {
                ...(maxActionBytes !== undefined ? { maxBytes: maxActionBytes } : {}),
              })
            : 'action must be an A2UI action message';
          if (typeof read === 'string') {
            return ctx.response.badRequest({ message: read, code: 'invalid_action' });
          }
          action = read;
        }

        // Deciding the approval a stream ended on: settle it, then stream the rest of the run.
        if (action?.name === A2UI_APPROVE_ACTION || action?.name === A2UI_REJECT_ACTION) {
          const interruptId = action.context.interruptId;
          const address =
            typeof interruptId === 'string' ? decodeInterruptId(interruptId) : undefined;
          if (address === undefined || address === null || address.kind === 'elicitation') {
            return ctx.response.badRequest({
              message: 'an approval action carries the interruptId it decides',
              code: 'invalid_action',
            });
          }
          // An independent proposal: decided through the proposal service (its own run is not
          // waiting), answered with the configured reply.
          if (address.kind === 'proposal') {
            if (address.proposalId === undefined || address.threadId === undefined) {
              return ctx.response.badRequest({
                message: 'the interruptId names no proposal',
                code: 'invalid_action',
              });
            }
            const decision = action.name === A2UI_APPROVE_ACTION ? 'approved' : 'rejected';
            let reply: string;
            try {
              const result = await service.decideActionProposal(
                actor,
                address.threadId,
                address.proposalId,
                decision,
                {},
                VIA,
              );
              reply = service.actionProposalReply(result, decision);
            } catch (error) {
              if (host.refuseSend(ctx, error)) return;
              throw error;
            }
            writeHead(ctx, { 'X-Agent-Thread-Id': address.threadId });
            const projector = new A2uiProjector(projection);
            const messageId = `proposal-${address.proposalId}`;
            for (const event of [
              { type: 'TEXT_MESSAGE_START' as const, messageId, role: 'assistant' as const },
              { type: 'TEXT_MESSAGE_CONTENT' as const, messageId, delta: reply },
            ]) {
              for (const message of projector.project(event)) {
                ctx.response.response.write(`${JSON.stringify(message)}\n`);
              }
            }
            ctx.response.response.end();
            return;
          }
          if (!(await host.mayDecide(ctx, actor, address.parked, address.toolCallId))) return;
          try {
            if (action.name === A2UI_APPROVE_ACTION) {
              await service.approve(address.parked, address.toolCallId, {
                executedByRef: actor.id,
                via: VIA,
              });
            } else {
              await service.reject(address.parked, address.toolCallId, undefined, {
                executedByRef: actor.id,
                via: VIA,
              });
            }
          } catch (error) {
            host.conflictOnMismatch(ctx, error);
            return;
          }
          await stream(ctx, host, address.stream, {
            skip: address.position,
            answered: [address.toolCallId],
            projection,
            quietMs,
          });
          return;
        }

        const message = typeof body.message === 'string' ? body.message : '';
        const text = action !== undefined ? uiActionText(action) : message;
        if (text.trim().length === 0) {
          return ctx.response.badRequest({
            message: 'send a message or an action',
            code: 'no_user_message',
          });
        }
        const threadId =
          typeof body.threadId === 'string' && body.threadId.length > 0 ? body.threadId : undefined;
        const owner = threadId !== undefined ? await service.threadOwner(threadId) : null;
        if (owner !== null && !(await host.assertOwner(ctx, actor, owner, 'thread'))) return;
        let started: { runId: string; threadId: string };
        try {
          started = await service.chat({
            actor,
            message: text,
            ...(threadId === undefined
              ? {}
              : owner !== null
                ? { threadId }
                : { newThreadId: threadId }),
            ...(agentName !== undefined ? { agentName } : {}),
            // An A2UI client draws like a web page: no channel stamped, which `turnChannel` reads as `web`.
            ...(dataModel !== undefined ? { pageContext: { a2uiDataModel: dataModel } } : {}),
            ...(Object.hasOwn(body, 'uiCapabilities')
              ? { uiCapabilities: validateUiCapabilities(body.uiCapabilities) }
              : {}),
          });
        } catch (error) {
          if (host.refuseSend(ctx, error)) return;
          throw error;
        }
        await stream(ctx, host, started.runId, {
          threadId: started.threadId,
          projection,
          quietMs,
        });
      });
    },
  };
}

/** Write one run as A2UI JSON Lines, until it ends or stops to ask. */
async function stream(
  ctx: HttpContext,
  host: ProtocolAdapterHost,
  runId: string,
  options: {
    threadId?: string;
    skip?: number;
    answered?: string[];
    projection: A2uiStreamOptions;
    quietMs: number | undefined;
  },
): Promise<void> {
  const raw = ctx.response.response;
  writeHead(ctx, {
    'X-Agent-Run-Id': runId,
    ...(options.threadId !== undefined ? { 'X-Agent-Thread-Id': options.threadId } : {}),
  });
  const projector = new A2uiProjector({
    ...options.projection,
    ...(options.projection.catalog === undefined && host.genuiCatalog !== undefined
      ? { catalog: host.genuiCatalog }
      : {}),
  });
  const write = (messages: A2uiServerMessage[]) => {
    for (const message of messages) raw.write(`${JSON.stringify(message)}\n`);
  };
  try {
    for await (const event of agUiEvents(host.service.subscribe(runId), {
      threadId: options.threadId ?? runId,
      runId,
      streamRunId: runId,
      ...(options.threadId !== undefined ? { streamThreadId: options.threadId } : {}),
      ...(options.skip !== undefined ? { skip: options.skip } : {}),
      ...(options.answered !== undefined ? { answered: options.answered } : {}),
      ...(options.quietMs !== undefined ? { quietMs: options.quietMs } : {}),
    })) {
      write(projector.project(event));
    }
  } catch {
    write(projector.project({ type: 'RUN_ERROR', message: 'The run could not be followed.' }));
  }
  raw.end();
}

/** Open the JSON Lines response, carrying over the headers already set on the context (cookies). */
function writeHead(ctx: HttpContext, extra: Record<string, string>): void {
  const raw = ctx.response.response;
  const headers: Record<string, string> = {
    'Content-Type': 'application/jsonl; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extra,
  };
  const pending = ctx.response.getHeaders();
  for (const [name, value] of Object.entries(pending)) {
    if (value !== undefined && !(name in headers)) raw.setHeader(name, value as string | string[]);
  }
  raw.writeHead(200, headers);
}
