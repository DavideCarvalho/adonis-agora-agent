import type {
  StoredMessage as DomainStoredMessage,
  AgentStreamEvent as DomainStreamEvent,
  ToolCallRequest as DomainToolCallRequest,
} from '../../index.js';

/** Optional protocol fields accepted from compatible custom backends; no persistence is implied. */
export interface ToolCallRequest extends DomainToolCallRequest {
  parentId?: string;
}
export interface StoredMessage extends Omit<DomainStoredMessage, 'toolCalls'> {
  toolCalls?: ToolCallRequest[];
  metadata?: Record<string, unknown>;
}
export type AgentStreamEvent =
  | DomainStreamEvent
  | { kind: 'message-metadata'; metadata: Record<string, unknown> };
