import type { UIMessage } from 'ai';
import type { ToolResult } from '../../index.js';
import { DEFAULT_REFUSAL_REASON } from '../../refusal.js';
import type { StoredMessage } from './client-wire.js';
import { reasoningDurationMetadata } from './reasoning/timing.js';
import type { AgentMessageMetadata } from './stored-thread-to-ui-messages.js';

/**
 * Convert a persisted `StoredMessage` (the agent-lib's on-disk shape) into an AI SDK v7
 * `UIMessage` so a loaded thread can seed `useChat`'s `initialMessages` / `messages`.
 *
 * The lib stores a message as flat `content` text plus `toolCalls`/`toolResults` arrays; the SDK
 * renders from `parts`. This maps, in this order:
 *   - `reasoning`          → a `reasoning` part (state `done`) BEFORE the text, as it streamed; its
 *                            `reasoningMs` rides `providerMetadata.agent.reasoningMs`, where the
 *                            live transport stamps it too.
 *   - `content`            → a single `text` part (skipped when empty).
 *   - each `attachment`    → a `file` part (image/PDF) so the user bubble re-renders its
 *                            thumbnails on a reloaded thread.
 *   - each `ui` component  → a `data-ui` part keyed by the component id — the same part a live
 *                            `ui` stream frame becomes.
 *   - each `approval`      → a `data-approval-requested` part keyed by the call id (who decides,
 *                            until when) and, once decided, a `data-approval-settled` one — the
 *                            same parts the live `approval-requested`/`approval-settled` frames
 *                            become, so the transcript folds both into `call.approval` either way.
 *   - each `toolCall`      → a `tool-<name>` part, pairing its `toolResult` (matched by id):
 *       - a result found   → `output-available` state, carrying `output`; `output-denied` when a
 *                            person declined it; `output-error` (carrying `errorText`) when it
 *                            failed — the states the live stream leaves the part in.
 *       - no result found  → `input-available` state (the call never finished, e.g. the run was
 *                            interrupted) — `output` is omitted, never a fabricated value.
 *     When the store reports the tool's kind (`'read' | 'action'`), it rides along as
 *     `toolMetadata.toolKind` so a UI can render an approval affordance for `action` tools
 *     without hardcoding tool-name sets, matching how live-streamed tool parts carry it.
 *
 * Live streaming still arrives as fully-typed SDK tool parts (see `AgentChatTransport`); this
 * converter only feeds replayed history, so the tool cards render the same either way.
 */
/**
 * Did a person decline this call? `denied` is what the loop sets today. The `output.rejected` shape
 * is how a refusal was recorded before that flag existed, and threads holding those are still read
 * back — so both count, and a thread from either era reloads as the same part.
 */
function isRefusal(result: ToolResult): boolean {
  if (result.denied === true) {
    return true;
  }
  const { output } = result;
  return (
    output !== null &&
    typeof output === 'object' &&
    'rejected' in output &&
    (output as { rejected: unknown }).rejected === true
  );
}

/** The reason given when declining, when one was given. */
function refusalReason(result: ToolResult): string | undefined {
  const { output } = result;
  if (output !== null && typeof output === 'object' && 'reason' in output) {
    const reason = (output as { reason: unknown }).reason;
    return typeof reason === 'string' && reason !== DEFAULT_REFUSAL_REASON ? reason : undefined;
  }
  return undefined;
}

export function storedMessageToUiMessage(message: StoredMessage): UIMessage {
  const parts: UIMessage['parts'] = [];

  if (message.reasoning) {
    parts.push({
      type: 'reasoning',
      text: message.reasoning,
      state: 'done',
      ...(message.reasoningMs !== undefined
        ? { providerMetadata: reasoningDurationMetadata(message.reasoningMs) }
        : {}),
    });
  }

  if (message.content) {
    parts.push({ type: 'text', text: message.content });
  }

  for (const attachment of message.attachments ?? []) {
    parts.push({
      type: 'file',
      mediaType: attachment.contentType,
      filename: attachment.name,
      url: attachment.url,
      // The stored id rides along, so a replayed file can be referenced again (`messageFiles`).
      providerMetadata: { agent: { mediaId: attachment.mediaId } },
    });
  }

  // A component a tool pushed (`toolCallId`) goes right after that call's tool part, where the live
  // stream put it; the rest keep their place ahead of the calls.
  const toolCallIds = new Set((message.toolCalls ?? []).map((call) => call.id));
  const pushedByCall = new Map<string, UIMessage['parts']>();
  for (const component of message.ui ?? []) {
    const part: UIMessage['parts'][number] = {
      type: 'data-ui',
      id: component.id,
      data: {
        id: component.id,
        component: component.component,
        props: component.props,
        ...(component.componentVersions !== undefined
          ? { componentVersions: component.componentVersions }
          : {}),
        ...(component.fallbackText !== undefined ? { fallbackText: component.fallbackText } : {}),
        ...(component.version !== undefined ? { version: component.version } : {}),
        ...(component.toolCallId !== undefined ? { toolCallId: component.toolCallId } : {}),
      },
    };
    if (component.toolCallId !== undefined && toolCallIds.has(component.toolCallId)) {
      const list = pushedByCall.get(component.toolCallId) ?? [];
      list.push(part);
      pushedByCall.set(component.toolCallId, list);
    } else {
      parts.push(part);
    }
  }

  for (const approval of message.approvals ?? []) {
    parts.push({
      type: 'data-approval-requested',
      id: approval.toolCallId,
      data: {
        id: approval.toolCallId,
        approver: approval.approver,
        ...(approval.target !== undefined
          ? { target: approval.target }
          : approval.proposalId !== undefined
            ? { target: { kind: 'proposal', proposalId: approval.proposalId } }
            : {}),
        ...(approval.confirmation !== undefined ? { confirmation: approval.confirmation } : {}),
        ...(approval.expiresAt !== undefined ? { expiresAt: approval.expiresAt } : {}),
      },
    });
    if (approval.status !== 'pending') {
      parts.push({
        type: 'data-approval-settled',
        id: approval.toolCallId,
        data: {
          id: approval.toolCallId,
          status: approval.status,
          ...(approval.decidedBy !== undefined ? { decidedBy: approval.decidedBy } : {}),
          ...(approval.decidedVia !== undefined ? { decidedVia: approval.decidedVia } : {}),
          ...(approval.remember === true ? { remember: true } : {}),
          ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
        },
      });
    }
  }

  for (const call of message.toolCalls ?? []) {
    const result = message.toolResults?.find((candidate) => candidate.id === call.id);
    // `call.kind` — the store's `'read' | 'action'` classification, once it lands there
    // (parallel to `RecordToolCallInput.toolType` and the stream's `toolKind`).
    const toolKind = call.kind;
    // `parentId` nests a replayed call under its parent, as the live frames did.
    const toolMetadata = {
      ...(toolKind !== undefined ? { toolKind } : {}),
      ...(call.parentId !== undefined ? { parentId: call.parentId } : {}),
    };
    parts.push({
      type: `tool-${call.name}`,
      toolCallId: call.id,
      ...(Object.keys(toolMetadata).length > 0 ? { toolMetadata } : {}),
      ...(result !== undefined
        ? isRefusal(result)
          ? {
              // A declined action is NOT an available output. Reloading a thread used to bring one
              // back as `output-available` carrying `{ rejected: true }`, which a card reads as a
              // result — so the action a person refused was drawn, after a refresh, as one that
              // had been carried out.
              state: 'output-denied',
              input: call.input,
              approval: {
                id: call.id,
                approved: false,
                ...(refusalReason(result) !== undefined
                  ? { reason: refusalReason(result) as string }
                  : {}),
              },
            }
          : typeof result.error === 'string' && result.error !== ''
            ? {
                // A call that FAILED — the tool threw, its input was refused, or its turn died
                // before it was settled — is not an available output either. The live stream says
                // so with `tool-output-error`; a reloaded thread has to say the same, or the card of
                // an action that never ran comes back reading as one that completed.
                state: 'output-error',
                input: call.input,
                errorText: result.error,
              }
            : { state: 'output-available', input: call.input, output: result.output }
        : { state: 'input-available', input: call.input }),
    });
    parts.push(...(pushedByCall.get(call.id) ?? []));
  }

  const metadata: AgentMessageMetadata = {
    // The host's own facts first: the library's keys win on a clash.
    ...message.metadata,
    ...(message.actionProposalOutcome === undefined
      ? {}
      : { actionProposalOutcomeId: message.actionProposalOutcome.id }),
    ...(message.feedback !== undefined ? { feedback: message.feedback } : {}),
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.agentName !== undefined ? { agentName: message.agentName } : {}),
    ...(message.persona !== undefined ? { persona: message.persona } : {}),
    ...(message.usage !== undefined
      ? {
          usage: {
            inputTokens: message.usage.inputTokens,
            outputTokens: message.usage.outputTokens,
            costUsd: message.usage.costUsd ?? null,
          },
        }
      : {}),
  };
  return {
    id: message.id,
    role: message.role,
    parts,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}
