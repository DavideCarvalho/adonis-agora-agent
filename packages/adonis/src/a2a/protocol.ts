/**
 * The slice of A2A 1.0 (HTTP+JSON binding) this surface speaks: the message shapes, the AIP-193 error
 * envelope, and the request validation PACT §4.1 asks for. Hand-rolled rather than schema-validated —
 * `zod` is an optional peer, and the rules are few and exact.
 */

export const A2A_CONTENT_TYPE = 'application/a2a+json';

export type A2aRole = 'ROLE_USER' | 'ROLE_AGENT';

export interface A2aTextPart {
  text: string;
  metadata?: Record<string, unknown>;
}

/** A structured part (A2A `DataPart`): what an action did, for the personal agent to relay. */
export interface A2aDataPart {
  data: unknown;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

export interface A2aMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: A2aRole;
  parts: (A2aTextPart | A2aDataPart)[];
  metadata?: Record<string, unknown>;
}

export interface A2aTask {
  id: string;
  contextId: string;
  status: { state: 'TASK_STATE_AUTH_REQUIRED'; message: A2aMessage };
  metadata?: Record<string, unknown>;
}

/** What `message:send` answers: a message (an ordinary turn) or a task (step-up). */
export type A2aSendResult = { message: A2aMessage } | { task: A2aTask };

/** The A2A error reasons PACT §6 uses, with their HTTP status and google.rpc status. */
const REASONS = {
  INVALID_PARAMS: { httpStatus: 400, status: 'INVALID_ARGUMENT' },
  CONTENT_TYPE_NOT_SUPPORTED: { httpStatus: 400, status: 'INVALID_ARGUMENT' },
  UNSUPPORTED_OPERATION: { httpStatus: 400, status: 'FAILED_PRECONDITION' },
  PUSH_NOTIFICATION_NOT_SUPPORTED: { httpStatus: 400, status: 'FAILED_PRECONDITION' },
  TASK_NOT_FOUND: { httpStatus: 404, status: 'NOT_FOUND' },
  INTERNAL: { httpStatus: 500, status: 'INTERNAL' },
} as const;

export type A2aErrorReason = keyof typeof REASONS;

/** An A2A error — answered as the AIP-193 envelope, never as a bare status. */
export class A2aError extends Error {
  constructor(
    readonly reason: A2aErrorReason,
    message: string,
  ) {
    super(message);
  }

  get httpStatus(): number {
    return REASONS[this.reason].httpStatus;
  }

  toJSON() {
    const { httpStatus, status } = REASONS[this.reason];
    return {
      error: {
        code: httpStatus,
        status,
        message: this.message,
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: this.reason,
            domain: 'a2a-protocol.org',
          },
        ],
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A validated `message:send` request: the user's text and the ids the turn is addressed by. */
export interface SendMessageInput {
  messageId: string;
  contextId?: string;
  text: string;
}

/**
 * Parse and validate a `SendMessageRequest` body (PACT §4.1). `configuration` and `metadata` are
 * accepted and ignored. Order matters where the conformance suite pins it: a `taskId` is
 * `TASK_NOT_FOUND` even on an otherwise valid message.
 */
export function parseSendMessage(raw: string): SendMessageInput {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new A2aError('INVALID_PARAMS', 'Request body is not valid JSON');
  }
  if (!isRecord(body) || !isRecord(body.message)) {
    throw new A2aError('INVALID_PARAMS', 'Missing message');
  }
  const message = body.message;
  if (message.taskId !== undefined) {
    throw new A2aError('TASK_NOT_FOUND', 'Task not found');
  }
  if (typeof message.messageId !== 'string' || message.messageId === '') {
    throw new A2aError('INVALID_PARAMS', 'messageId is required');
  }
  if (message.contextId !== undefined && typeof message.contextId !== 'string') {
    throw new A2aError('INVALID_PARAMS', 'contextId must be a string');
  }
  if (message.role !== 'ROLE_USER') {
    throw new A2aError('INVALID_PARAMS', 'role must be ROLE_USER');
  }
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw new A2aError('INVALID_PARAMS', 'parts must not be empty');
  }

  const texts: string[] = [];
  for (const part of message.parts) {
    if (!isRecord(part)) {
      throw new A2aError('INVALID_PARAMS', 'Invalid part');
    }
    if (typeof part.text === 'string') {
      texts.push(part.text);
    } else if ('raw' in part || 'url' in part || 'data' in part) {
      throw new A2aError('CONTENT_TYPE_NOT_SUPPORTED', 'Only text parts are supported');
    } else {
      throw new A2aError('INVALID_PARAMS', 'Invalid part');
    }
  }
  const text = texts.join('\n').trim();
  if (text === '') {
    throw new A2aError('INVALID_PARAMS', 'Message text is blank');
  }

  return {
    messageId: message.messageId,
    ...(message.contextId !== undefined && message.contextId !== ''
      ? { contextId: message.contextId }
      : {}),
    text,
  };
}
