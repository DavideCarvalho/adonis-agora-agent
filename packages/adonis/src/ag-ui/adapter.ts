import type { HttpContext } from '@adonisjs/core/http';
import {
  A2UI_LEGACY_BASIC_CATALOG_ID,
  type A2uiOptions,
  negotiateA2uiCatalog,
  readAgUiA2uiCatalogIds,
} from '../a2ui/core.js';
import type { AgentService } from '../agent-service.js';
import { uiActionText } from '../genui/actions.js';
import { stampChannel, WEB_CHANNEL } from '../genui/channels.js';
import type { ProtocolAdapter, ProtocolAdapterHost } from '../spi/protocol-adapter.js';
import type { Actor, PageContext } from '../types.js';
import {
  AG_UI_CUSTOM,
  type AgUiEvent,
  actionProposalDecisionEvents,
  parseRunInput,
  planResume,
  type ResumeDecision,
  readAnswersPayload,
  readApprovalPayload,
  readContext,
  readForwardedProps,
  readUserTurn,
} from './core/index.js';
import { type AgUiStreamOptions, agUiEvents, agUiSse } from './stream.js';

export interface AgUiAdapterOptions {
  /** Where the route mounts, under the agent's path. Default `'ag-ui'` → `POST <path>/ag-ui`. */
  path?: string;
  /**
   * How long a run that is waiting on a person AND still has other work announced may stay silent
   * before it is reported interrupted. Default 750 ms.
   */
  quietMs?: number;
  /**
   * A2UI over AG-UI: every generative-UI frame is also sent as an `ACTIVITY_SNAPSHOT` of type
   * `a2ui-surface` (the A2UI messages under `a2ui_operations`), so CopilotKit's A2UI renderer — or
   * any client of AG-UI's A2UI binding — draws it. `true` maps the library builtins onto A2UI's
   * basic catalog; pass {@link A2uiOptions} for the app's own mappings or catalog. Inbound,
   * `forwardedProps.a2uiAction.userAction` is always read: the action becomes the user's turn.
   *
   * The basic catalog goes under the id the client advertises — `forwardedProps
   * .a2uiClientCapabilities`, or the "A2UI catalog capabilities" context entry CopilotKit sends —
   * and, when it advertises none, under the id AG-UI's A2UI binding uses
   * (`A2UI_LEGACY_BASIC_CATALOG_ID`: CopilotKit 1.77, `@ag-ui/a2ui-middleware`).
   */
  a2ui?: boolean | A2uiOptions;
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
  const a2ui =
    options.a2ui === undefined || options.a2ui === false
      ? undefined
      : options.a2ui === true
        ? {}
        : options.a2ui;
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
          // Independent proposals do not park their run: deciding them is the whole answer.
          if (
            first !== undefined &&
            plan.decisions.every((decision) => decision.address.kind === 'proposal')
          ) {
            const decided = await decideProposals(host, ctx, actor, plan.decisions);
            if (decided === null) return;
            writeEvents(ctx, [
              ...warningEvents(warnings),
              ...decided.flatMap((outcome, index) =>
                actionProposalDecisionEvents({
                  threadId: input.threadId,
                  runId: index === 0 ? input.runId : `${input.runId}:${index}`,
                  text: outcome.text,
                  proposalDecision: outcome.proposalDecision,
                }),
              ),
            ]);
            return;
          }
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
              ...(a2ui !== undefined ? { a2ui: forClient(withCatalog(a2ui, host), input) } : {}),
              preamble: warningEvents(warnings),
            });
            return;
          }
        }

        // A UI action (a sandbox's `agent.send`, an A2UI button) IS the turn: the messages only
        // restate the conversation so far.
        const action = forwarded.uiAction;
        if (typeof action === 'string') {
          return ctx.response.badRequest({ message: action, code: 'invalid_ui_action' });
        }
        const turn =
          action !== undefined
            ? { text: uiActionText(action), media: [], staged: [], dropped: [] }
            : readUserTurn(input.messages);
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
        // A regenerate re-answers the thread's last user message: the message restated here (and
        // anything attached to it) is not a new turn.
        const regenerate = forwarded.regenerate === true;
        if (regenerate && owner === null) {
          return ctx.response.badRequest({
            message: 'regenerate requires an existing thread',
            code: 'thread_required',
          });
        }
        if (
          owner !== null &&
          !regenerate &&
          action === undefined &&
          turn.media.length === 0 &&
          turn.staged.length === 0
        ) {
          try {
            const decision = await service.handleTextDecision(actor, input.threadId, turn.text);
            if ('proposalDecision' in decision) {
              writeEvents(ctx, [
                ...warningEvents(warnings),
                ...actionProposalDecisionEvents({
                  threadId: input.threadId,
                  runId: input.runId,
                  text: decision.text,
                  proposalDecision: decision.proposalDecision,
                }),
              ]);
              return;
            }
          } catch (error) {
            if (host.refuseSend(ctx, error)) return;
            throw error;
          }
        }
        const refs: { mediaId: string }[] = [];
        // Uploads this agent already staged: resolved for this actor by the send itself, which
        // refuses one that is not theirs (as `chat` refuses its `attachments` refs).
        for (const ref of regenerate ? [] : turn.staged) {
          if (staging === undefined) {
            warnings.push(
              `The upload ${ref.mediaId} was not used: attachments are not enabled on this agent.`,
            );
          } else if (refs.length >= staging.maxPerMessage) {
            warnings.push(
              `The upload ${ref.mediaId} was not used: a message carries at most ${staging.maxPerMessage} attachments.`,
            );
          } else refs.push(ref);
        }
        for (const media of regenerate ? [] : turn.media) {
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
        if (!regenerate && turn.text.trim().length === 0 && refs.length === 0) {
          return ctx.response.badRequest({
            message: 'the user message to answer is empty',
            code: 'no_user_message',
          });
        }
        const context = readContext(input.context);
        // An AG-UI client is a web page, unless its page context names another channel.
        const pageContext: PageContext = stampChannel(
          {
            ...forwarded.pageContext,
            ...(context !== undefined ? { agUiContext: context } : {}),
          },
          WEB_CHANNEL,
        );
        let started: { runId: string; threadId: string };
        try {
          started = await service.chat({
            actor,
            // A regenerate answers the stored user message; whatever this one says is ignored.
            message: regenerate ? '' : turn.text,
            ...(regenerate ? { regenerate: true } : {}),
            ...(owner !== null ? { threadId: input.threadId } : { newThreadId: input.threadId }),
            ...(forwarded.agent !== undefined ? { agentName: forwarded.agent } : {}),
            ...(forwarded.model !== undefined ? { model: forwarded.model } : {}),
            ...(forwarded.uiCapabilities !== undefined
              ? { uiCapabilities: forwarded.uiCapabilities }
              : {}),
            ...(forwarded.persona !== undefined ? { personaId: forwarded.persona } : {}),
            pageContext,
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
          ...(a2ui !== undefined ? { a2ui: forClient(withCatalog(a2ui, host), input) } : {}),
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
  const proposals = decisions.filter((decision) => decision.address.kind === 'proposal');
  if (proposals.length > 0) {
    // Settled before the parked calls, like any other delivery: one refusal settles nothing more.
    if ((await decideProposals(host, ctx, actor, proposals)) === null) return false;
  }
  for (const { address, entry } of decisions) {
    const { parked, toolCallId } = address;
    const abandoned = entry.status === 'cancelled';
    if (address.kind === 'proposal') continue;
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
 * Decide independent proposals through the proposal service — the call the native
 * `action-proposals/:id/approve|reject` routes make — never by signalling the origin run, which is
 * not waiting. Every payload is checked before the first decision. `null` after writing a refusal.
 */
async function decideProposals(
  host: ProtocolAdapterHost,
  ctx: HttpContext,
  actor: Actor,
  decisions: ResumeDecision[],
): Promise<{ proposalDecision: unknown; text: string }[] | null> {
  const { service } = host;
  const planned: {
    threadId: string;
    proposalId: string;
    decision: 'approved' | 'rejected';
    body: Record<string, unknown>;
  }[] = [];
  for (const { address, entry } of decisions) {
    const decision =
      entry.status === 'cancelled' ? { approved: false } : readApprovalPayload(entry.payload);
    if (decision === null || address.proposalId === undefined || address.threadId === undefined) {
      ctx.response.badRequest({
        code: 'invalid_resume',
        message: 'an approval is answered with { approved: boolean, reason?, remember? }',
      });
      return null;
    }
    planned.push({
      threadId: address.threadId,
      proposalId: address.proposalId,
      decision: decision.approved ? 'approved' : 'rejected',
      body: {
        ...(decision.remember !== undefined ? { remember: decision.remember } : {}),
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      },
    });
  }
  const outcomes: { proposalDecision: unknown; text: string }[] = [];
  try {
    for (const item of planned) {
      const result = await service.decideActionProposal(
        actor,
        item.threadId,
        item.proposalId,
        item.decision,
        item.body,
        AG_UI_VIA,
      );
      outcomes.push({
        proposalDecision: result,
        text: service.actionProposalReply(result, item.decision),
      });
    }
  } catch (error) {
    if (host.refuseSend(ctx, error)) return null;
    throw error;
  }
  return outcomes;
}

/** Answer with a complete list of events, no run behind them. */
function writeEvents(ctx: HttpContext, events: AgUiEvent[]): void {
  const raw = ctx.response.response;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
  });
  for (const event of events) raw.write(agUiSse(event));
  raw.end();
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
  // Every event goes out with the run's own sequence number as its SSE `id:`, so a consumer can
  // follow the rest of the run on `chat/:runId/stream?after=<id>` once this AG-UI run ends.
  const cursor = { seq: 0 };
  try {
    for await (const event of agUiEvents(service.subscribe(runId), { ...options, cursor })) {
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') terminal = true;
      raw.write(agUiSse(event, cursor.seq));
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

/** The A2UI options for this request's client: the basic catalog under the id it advertises. */
function forClient(
  options: A2uiOptions,
  input: { forwardedProps?: unknown; context?: readonly unknown[] },
): A2uiOptions {
  return negotiateA2uiCatalog(options, readAgUiA2uiCatalogIds(input), A2UI_LEGACY_BASIC_CATALOG_ID);
}

/** The app's genui catalog under the A2UI options, for the text of components nothing maps. */
function withCatalog(options: A2uiOptions, host: ProtocolAdapterHost): A2uiOptions {
  if (options.catalog !== undefined) return options;
  const catalog = host.genuiCatalog;
  return catalog !== undefined ? { ...options, catalog } : options;
}
