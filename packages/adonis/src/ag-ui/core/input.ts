import { readA2uiAction } from '../../a2ui/core.js';
import { readUiAction, type UiAction } from '../../genui/actions.js';
import { type UiCapabilities, validateUiCapabilities } from '../../genui/capabilities.js';
import { decodeInterruptId, type InterruptAddress } from './interrupt-id.js';
import type {
  AgUiContentPart,
  AgUiContext,
  AgUiMessage,
  AgUiResumeEntry,
  AgUiRunInput,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a request body as a `RunAgentInput`, or say why it is not one.
 *
 * Only what this producer acts on is checked, and a KNOWN member with a value the schema rejects is
 * malformed (the run never starts). A member it does not recognise is not an error — the protocol's
 * asymmetry: a newer consumer's input must not bounce off an older producer.
 */
export function parseRunInput(body: unknown): AgUiRunInput | string {
  if (!isRecord(body)) return 'the body must be a RunAgentInput object';
  if (typeof body.threadId !== 'string' || body.threadId.length === 0) {
    return 'threadId must be a non-empty string';
  }
  if (body.threadId.length > 255) return 'threadId must be at most 255 characters';
  if (typeof body.runId !== 'string' || body.runId.length === 0) {
    return 'runId must be a non-empty string';
  }
  if (!Array.isArray(body.messages)) return 'messages must be an array';
  for (const message of body.messages) {
    if (!isRecord(message) || typeof message.role !== 'string') {
      return 'each message must be an object with a role';
    }
  }
  if (body.resume !== undefined) {
    if (!Array.isArray(body.resume)) return 'resume must be an array';
    for (const entry of body.resume) {
      if (
        !isRecord(entry) ||
        typeof entry.interruptId !== 'string' ||
        (entry.status !== 'resolved' && entry.status !== 'cancelled')
      ) {
        return "each resume entry needs an interruptId and a status of 'resolved' or 'cancelled'";
      }
    }
  }
  if (body.context !== undefined && !Array.isArray(body.context)) {
    return 'context must be an array';
  }
  if (isRecord(body.forwardedProps) && Object.hasOwn(body.forwardedProps, 'uiCapabilities')) {
    try {
      validateUiCapabilities(body.forwardedProps.uiCapabilities);
    } catch {
      return 'forwardedProps.uiCapabilities must be valid UI capabilities';
    }
  }
  return body as unknown as AgUiRunInput;
}

/** A media part carried inline, ready to be staged as an attachment. */
export interface InlineMedia {
  kind: 'image' | 'audio' | 'video' | 'document';
  contentType: string;
  data: Buffer;
  filename: string;
}

/**
 * The `provider` of a `file` source naming an upload this agent already staged
 * (`POST <path>/attachments`): `{ type: 'file', provider: 'agora', value: <mediaId> }`.
 */
export const AG_UI_STAGED_MEDIA_PROVIDER = 'agora';

export interface UserTurn {
  /** The text of the message the run answers. */
  text: string;
  media: InlineMedia[];
  /**
   * Uploads this agent staged itself, named by `mediaId` (a `file` source whose `provider` is
   * {@link AG_UI_STAGED_MEDIA_PROVIDER}). Resolved for the caller like the native `attachments`
   * refs: one that is not the caller's refuses the send.
   */
  staged: { mediaId: string }[];
  /** Why a part was not used, one sentence each — reported, never fatal. */
  dropped: string[];
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

function filenameOf(part: AgUiContentPart, index: number, contentType: string): string {
  const metadata = (part as { metadata?: unknown }).metadata;
  if (isRecord(metadata)) {
    for (const key of ['filename', 'name', 'title']) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim().slice(0, 200);
    }
  }
  const extension = EXTENSIONS[contentType];
  return `${part.type}-${index + 1}${extension !== undefined ? `.${extension}` : ''}`;
}

/**
 * The turn a run answers: the LAST user message of the input. The library keeps each thread's
 * history itself, so the earlier messages the consumer restates are not read back in — what the
 * agent resumes from is what it stored.
 *
 * Multimodal parts: text parts are the message's text; a media part carried inline (`data`) becomes
 * an attachment, and so does a `file` handle naming an upload this agent staged
 * ({@link AG_UI_STAGED_MEDIA_PROVIDER}). A part by `url` or by any other provider's `file` handle
 * is dropped and said so — this producer hands the model only bytes it staged itself, never an
 * address a caller supplied.
 */
export function readUserTurn(messages: readonly AgUiMessage[]): UserTurn | null {
  let last: AgUiMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      last = messages[index];
      break;
    }
  }
  if (last === undefined) return null;
  if (typeof last.content === 'string') {
    return { text: last.content, media: [], staged: [], dropped: [] };
  }
  if (!Array.isArray(last.content)) return { text: '', media: [], staged: [], dropped: [] };

  const texts: string[] = [];
  const media: InlineMedia[] = [];
  const staged: { mediaId: string }[] = [];
  const dropped: string[] = [];
  last.content.forEach((part, index) => {
    if (!isRecord(part)) return;
    if (part.type === 'text') {
      if (typeof part.text === 'string') texts.push(part.text);
      return;
    }
    if (
      part.type !== 'image' &&
      part.type !== 'audio' &&
      part.type !== 'video' &&
      part.type !== 'document'
    ) {
      return;
    }
    const source = part.source;
    if (
      isRecord(source) &&
      source.type === 'file' &&
      source.provider === AG_UI_STAGED_MEDIA_PROVIDER &&
      typeof source.value === 'string' &&
      source.value.length > 0
    ) {
      staged.push({ mediaId: source.value });
      return;
    }
    if (!isRecord(source) || source.type !== 'data') {
      const how = isRecord(source) && typeof source.type === 'string' ? source.type : 'unknown';
      dropped.push(
        `The ${part.type} part ${index + 1} was not used: only inline data is accepted, not a ${how} source.`,
      );
      return;
    }
    if (typeof source.value !== 'string' || typeof source.mimeType !== 'string') {
      dropped.push(
        `The ${part.type} part ${index + 1} was not used: its inline data is malformed.`,
      );
      return;
    }
    const data = Buffer.from(source.value, 'base64');
    if (data.length === 0) {
      dropped.push(`The ${part.type} part ${index + 1} was not used: it carries no bytes.`);
      return;
    }
    const contentType = source.mimeType.toLowerCase();
    media.push({
      kind: part.type,
      contentType,
      data,
      filename: filenameOf(part as AgUiContentPart, index, contentType),
    });
  });
  return { text: texts.join('\n'), media, staged, dropped };
}

/** `context` entries as the library's page context carries them, or `undefined` for none. */
export function readContext(
  context: readonly AgUiContext[] | undefined,
): AgUiContext[] | undefined {
  if (context === undefined) return undefined;
  const entries = context.filter(
    (entry) =>
      isRecord(entry) && typeof entry.description === 'string' && typeof entry.value === 'string',
  );
  return entries.length > 0 ? entries : undefined;
}

/**
 * What the library reads from `forwardedProps` — the consumer's channel for what AG-UI does not
 * model: which agent, which model, which persona, the page context the tools see, and whether the
 * run regenerates the last answer.
 */
export interface ForwardedOptions {
  uiCapabilities?: UiCapabilities;
  /** Re-answer the thread's last user message instead of appending this one (`regenerate: true`). */
  regenerate?: boolean;
  agent?: string;
  model?: string;
  persona?: string;
  pageContext?: Record<string, unknown>;
  /**
   * A UI action that IS this turn: `forwardedProps.uiAction` (a `UiAction` — a sandbox's
   * `agent.send`) or `forwardedProps.a2uiAction.userAction` (A2UI's AG-UI binding). A string when
   * one was sent but refused.
   */
  uiAction?: UiAction | string;
}

export function readForwardedProps(forwarded: unknown): ForwardedOptions {
  if (!isRecord(forwarded)) return {};
  const pick = (key: string): string | undefined => {
    const value = forwarded[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const agent = pick('agent');
  const model = pick('model');
  const persona = pick('persona');
  return {
    ...(Object.hasOwn(forwarded, 'uiCapabilities')
      ? { uiCapabilities: validateUiCapabilities(forwarded.uiCapabilities) }
      : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(persona !== undefined ? { persona } : {}),
    ...(forwarded.regenerate === true ? { regenerate: true } : {}),
    ...(isRecord(forwarded.pageContext) ? { pageContext: forwarded.pageContext } : {}),
    ...(forwarded.uiAction !== undefined
      ? { uiAction: readUiAction(forwarded.uiAction) }
      : isRecord(forwarded.a2uiAction)
        ? { uiAction: readA2uiAction(forwarded.a2uiAction) }
        : {}),
  };
}

/** One resume entry this producer can act on. */
export interface ResumeDecision {
  address: InterruptAddress;
  entry: AgUiResumeEntry;
}

export interface ResumePlan {
  decisions: ResumeDecision[];
  /** Entries naming an interrupt this producer did not raise: skipped with a warning, never fatal. */
  unrecognised: string[];
}

/**
 * Sort a resume list into what it answers. Every recognised entry must continue the SAME library
 * run from the SAME point — they are the interrupts of one `RUN_FINISHED` — and a list that does not
 * is malformed (a string says why).
 */
export function planResume(resume: readonly AgUiResumeEntry[]): ResumePlan | string {
  const decisions: ResumeDecision[] = [];
  const unrecognised: string[] = [];
  for (const entry of resume) {
    const address = decodeInterruptId(entry.interruptId);
    if (address === null) {
      unrecognised.push(entry.interruptId);
      continue;
    }
    decisions.push({ address, entry });
  }
  const first = decisions[0];
  if (first === undefined) return { decisions, unrecognised };
  for (const { address } of decisions) {
    if (address.stream !== first.address.stream || address.position !== first.address.position) {
      return 'the resume entries answer interrupts of different runs';
    }
  }
  const seen = new Set<string>();
  for (const { address } of decisions) {
    if (seen.has(address.toolCallId)) return 'an interrupt is answered twice';
    seen.add(address.toolCallId);
  }
  return { decisions, unrecognised };
}

/** `{ approved, reason?, remember? }` out of an approval's resume payload. A bare boolean is accepted. */
export function readApprovalPayload(payload: unknown): {
  approved: boolean;
  reason?: string;
  remember?: boolean;
} | null {
  if (typeof payload === 'boolean') return { approved: payload };
  if (!isRecord(payload) || typeof payload.approved !== 'boolean') return null;
  return {
    approved: payload.approved,
    ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    ...(typeof payload.remember === 'boolean' ? { remember: payload.remember } : {}),
  };
}

/** `questionId → string[]` out of an elicitation's resume payload (`{ answers }` or the map itself). */
export function readAnswersPayload(payload: unknown): Record<string, string[]> | null {
  const source = isRecord(payload) && isRecord(payload.answers) ? payload.answers : payload;
  if (!isRecord(source)) return null;
  const answers: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') answers[key] = [value];
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      answers[key] = value as string[];
    } else return null;
  }
  return answers;
}
