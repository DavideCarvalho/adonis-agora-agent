import type { HttpContext } from '@adonisjs/core/http';
import {
  AG_UI_CUSTOM,
  type AgUiEvent,
  parseRunInput,
  planResume,
  type ResumeDecision,
  readAnswersPayload,
  readApprovalPayload,
  readContext,
  readForwardedProps,
  readUserTurn,
} from '@dudousxd/nestjs-agent-core/ag-ui';
import type { AgentService } from '../agent-service.js';
import type { ProtocolAdapter, ProtocolAdapterHost } from '../spi/protocol-adapter.js';
import type { Actor, PageContext } from '../types.js';
import { type AgUiStreamOptions, agUiEvents, agUiSse } from './stream.js';

export interface AgUiAdapterOptions {
  /** Where the route mounts, under the agent's path. Default `'ag-ui'` → `POST <path>/ag-ui`. */
  path?: string;
  /**
   * How long a run that is waiting on a person AND still has other work announced may stay silent
   * before it is reported interrupted. Default 750 ms.
   */
  quietMs?: number;
}

/** The surface an AG-UI resume decision is recorded as having come through. */
const AG_UI_VIA = 'ag-ui';

/** Input material the route could not use, as the events that say so. */
function warningEvents(warnings: readonly string[]): AgUiEvent[] {
  return warnings.map((message) => ({
    type: 'CUSTOM' as const,
    name: AG_UI_CUSTOM.warning,
    value: { message },
  }));
}

/**
 * Serve the agent over AG-UI 1.0 (https://docs.ag-ui.com/spec/1.0): the body of `POST <path>/ag-ui`
 * is a `RunAgentInput`, the answer the run as AG-UI events. A run that stops to ask ends with the
 * interrupt outcome and is continued by a later request carrying `resume`.
 *
 * ```ts
 * import { agUiAdapter } from '@adonis-agora/agent/ag-ui'
 *
 * export default defineConfig({ adapters: [agUiAdapter()] })
 * ```
 *
 * Authenticated and owner-scoped exactly as `chat`, `chat/:runId/stream` and the decision routes
 * are: it goes through the gates the provider hands every adapter.
 */
export function agUiAdapter(options: AgUiAdapterOptions = {}): ProtocolAdapter {
  const path = (options.path ?? 'ag-ui').replace(/^\/+|\/+$/g, '');
  const quietMs = options.quietMs;
  return {
    name: 'ag-ui',
    mount(host) {
      const { service } = host;
      const staging = host.attachments;
      host.post(path, async (ctx: HttpContext) => {
        const input = parseRunInput(ctx.request.body());
        if (typeof input === 'string') {
          return ctx.response.badRequest({ message: input, code: 'invalid_input' });
        }
        const forwarded = readForwardedProps(input.forwardedProps);
        const agentName = forwarded.agent ?? host.defaultAgentName;
        const actor = await host.resolveActor(ctx, agentName);
        if (actor === null) return;
        const warnings: string[] = [];
        if (Array.isArray(input.tools) && input.tools.length > 0) {
          warnings.push(
            'Frontend tools are not supported by this agent: the tools list was ignored.',
          );
        }

        if (input.resume !== undefined && input.resume.length > 0) {
          const plan = planResume(input.resume);
          if (typeof plan === 'string') {
            return ctx.response.badRequest({ message: plan, code: 'invalid_resume' });
          }
          for (const id of plan.unrecognised) {
            warnings.push(`The resume entry ${id} answers an interrupt this agent did not raise.`);
          }
          const first = plan.decisions[0];
          // A list that answers nothing this agent asked continues nothing: an ordinary run.
          if (first !== undefined) {
            const streamRunId = first.address.stream;
            const owner = await service.runOwner(streamRunId);
            if (!(await host.assertOwner(ctx, actor, owner, 'run'))) return;
            if (!(await service.hasStream(streamRunId))) {
              return ctx.response.conflict({
                code: 'run_not_active',
                message: 'The interrupted run is no longer waiting.',
              });
            }
            if (!(await settleResume(host, ctx, actor, plan.decisions))) {
              return;
            }
            await pipe(ctx, service, streamRunId, {
              threadId: input.threadId,
              runId: input.runId,
              streamRunId,
              skip: first.address.position,
              answered: plan.decisions.map((decision) => decision.address.toolCallId),
              ...(quietMs !== undefined ? { quietMs } : {}),
              preamble: warningEvents(warnings),
            });
            return;
          }
        }

        const turn = readUserTurn(input.messages);
        if (turn === null) {
          return ctx.response.badRequest({
            message: 'messages carries no user message to answer',
            code: 'no_user_message',
          });
        }
        warnings.push(...turn.dropped);
        // The consumer names the conversation. A thread it already has is continued (its owner
        // checked, as on `chat`); one nobody has is created under that name.
        const owner = await service.threadOwner(input.threadId);
        if (owner !== null) {
          if (!(await host.assertOwner(ctx, actor, owner, 'thread'))) return;
        }
        const refs: { mediaId: string }[] = [];
        for (const media of turn.media) {
          const label = `The ${media.kind} "${media.filename}" was not used`;
          if (staging === undefined) {
            warnings.push(`${label}: attachments are not enabled on this agent.`);
          } else if (refs.length >= staging.maxPerMessage) {
            warnings.push(
              `${label}: a message carries at most ${staging.maxPerMessage} attachments.`,
            );
          } else if (!staging.allowedContentTypes.includes(media.contentType)) {
            warnings.push(`${label}: ${media.contentType} is not an accepted type.`);
          } else if (media.data.length > staging.maxBytes) {
            warnings.push(`${label}: it is larger than ${staging.maxBytes} bytes.`);
          } else {
            try {
              const staged = await staging.store.stage({
                data: media.data,
                filename: media.filename,
                contentType: media.contentType,
                sizeBytes: media.data.length,
                actor,
              });
              refs.push({ mediaId: staged.mediaId });
            } catch {
              warnings.push(`${label}: it could not be stored.`);
            }
          }
        }
        if (turn.text.trim().length === 0 && refs.length === 0) {
          return ctx.response.badRequest({
            message: 'the user message to answer is empty',
            code: 'no_user_message',
          });
        }
        const context = readContext(input.context);
        const pageContext: PageContext | undefined =
          forwarded.pageContext !== undefined || context !== undefined
            ? {
                ...forwarded.pageContext,
                ...(context !== undefined ? { agUiContext: context } : {}),
              }
            : undefined;
        let started: { runId: string; threadId: string };
        try {
          started = await service.chat({
            actor,
            message: turn.text,
            ...(owner !== null ? { threadId: input.threadId } : { newThreadId: input.threadId }),
            ...(forwarded.agent !== undefined ? { agentName: forwarded.agent } : {}),
            ...(forwarded.model !== undefined ? { model: forwarded.model } : {}),
            ...(forwarded.persona !== undefined ? { personaId: forwarded.persona } : {}),
            ...(pageContext !== undefined ? { pageContext } : {}),
            ...(refs.length > 0 ? { attachments: refs } : {}),
          });
        } catch (error) {
          if (host.refuseSend(ctx, error)) return;
          throw error;
        }
        await pipe(ctx, service, started.runId, {
          threadId: input.threadId,
          runId: input.runId,
          streamRunId: started.runId,
          streamThreadId: started.threadId,
          ...(quietMs !== undefined ? { quietMs } : {}),
          preamble: warningEvents(warnings),
        });
      });
    },
  };
}

/**
 * Deliver what a resume list decided, through the same calls the native decision routes make.
 * Everything that can refuse — who may decide, an answer a question's rules reject, a payload that
 * says nothing — is checked for EVERY entry before the first one is delivered, so a list with one
 * bad entry settles nothing. Answers `false` after writing the refusal.
 */
async function settleResume(
  host: ProtocolAdapterHost,
  ctx: HttpContext,
  actor: Actor,
  decisions: ResumeDecision[],
): Promise<boolean> {
  const { service } = host;
  const deliveries: (() => Promise<void>)[] = [];
  for (const { address, entry } of decisions) {
    const { parked, toolCallId } = address;
    const abandoned = entry.status === 'cancelled';
    if (address.kind === 'approval') {
      if (!(await host.mayDecide(ctx, actor, parked, toolCallId))) {
        return false;
      }
      const decision = abandoned ? { approved: false } : readApprovalPayload(entry.payload);
      if (decision === null) {
        ctx.response.badRequest({
          code: 'invalid_resume',
          message: 'an approval is answered with { approved: boolean, reason?, remember? }',
        });
        return false;
      }
      deliveries.push(() =>
        decision.approved
          ? service.approve(parked, toolCallId, {
              executedByRef: actor.id,
              via: AG_UI_VIA,
              ...(decision.remember !== undefined ? { remember: decision.remember } : {}),
            })
          : service.reject(
              parked,
              toolCallId,
              decision.reason ?? (abandoned ? 'abandoned' : undefined),
              {
                executedByRef: actor.id,
                via: AG_UI_VIA,
              },
            ),
      );
      continue;
    }
    const owner = await service.runOwner(parked);
    if (!(await host.assertOwner(ctx, actor, owner, 'run'))) return false;
    if (abandoned) {
      deliveries.push(() =>
        service.skip({
          runId: parked,
          toolCallId,
          answeredByRef: actor.id,
          answeredVia: AG_UI_VIA,
        }),
      );
      continue;
    }
    const answers = readAnswersPayload(entry.payload);
    if (answers === null) {
      ctx.response.badRequest({
        code: 'invalid_resume',
        message: 'a question set is answered with { answers: { <questionId>: string[] } }',
      });
      return false;
    }
    const problem = await service.answerProblem(toolCallId, answers);
    if (problem !== null) {
      ctx.response.badRequest({ code: 'invalid_resume', message: problem });
      return false;
    }
    deliveries.push(() =>
      service.answer({
        runId: parked,
        toolCallId,
        answers,
        answeredByRef: actor.id,
        answeredVia: AG_UI_VIA,
      }),
    );
  }
  try {
    for (const deliver of deliveries) await deliver();
  } catch (error) {
    host.conflictOnMismatch(ctx, error);
    return false;
  }
  return true;
}

/**
 * Pipe a run to the client as AG-UI 1.0 over SSE: one event per `data:` line, from `RUN_STARTED` to
 * the run's terminal event. It ends when the run stops to ask — the library run stays parked, and
 * the request that answers re-attaches to it.
 */
async function pipe(
  ctx: HttpContext,
  service: AgentService,
  runId: string,
  options: AgUiStreamOptions,
): Promise<void> {
  const raw = ctx.response.response;
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Agent-Run-Id': runId,
  };
  const pending = ctx.response.getHeaders();
  for (const [name, value] of Object.entries(pending)) {
    if (value !== undefined && !(name in headers)) raw.setHeader(name, value as string | string[]);
  }
  raw.writeHead(200, headers);
  let terminal = false;
  try {
    for await (const event of agUiEvents(service.subscribe(runId), options)) {
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') terminal = true;
      raw.write(agUiSse(event));
    }
  } catch {
    // The stream under the run broke. The status line is long gone, so the failure travels
    // in-stream — and says nothing of what broke, which is the server's to know.
    if (!terminal) {
      raw.write(
        agUiSse({
          type: 'RUN_ERROR',
          message: 'The run could not be followed.',
          code: 'run_failed',
        }),
      );
    }
  }
  raw.end();
}
