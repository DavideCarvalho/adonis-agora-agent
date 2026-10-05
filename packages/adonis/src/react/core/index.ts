export type { UiCapabilities } from '../../genui/index.js';
// The queue's wire shapes, so a renderer needs no second import for them.
export type {
  ChatQueueState,
  QueuedMessageView,
  QueuePause,
  QueuePauseReason,
} from '../../index.js';
export {
  type AgUiChatStreamOptions,
  type AgUiContentPart,
  agUiChatStream,
  reframeAgUiStream,
} from './ag-ui-backend.js';
export {
  AgentChatTransport,
  type AgentChatTransportOptions,
  type AgentStreamMeta,
  type ReconnectOptions,
  type StreamConnectionState,
} from './agent-chat-transport.js';
export {
  type ApprovalCountdown,
  approvalCountdown,
  type UseApprovalCountdownOptions,
  useApprovalCountdown,
} from './approvals/countdown.js';
export {
  type ApprovalTarget,
  proposalNeedsPolling,
  reconcileProposalMessages,
} from './approvals/proposals.js';
export { type ActionProposalsState, useActionProposals } from './approvals/use-action-proposals.js';
export {
  acceptsFile,
  attachmentFile,
  dragHasFiles,
  fileKind,
  filesFromClipboard,
  type MessageFile,
  type MessageFileKind,
  messageFiles,
} from './attachments/files.js';
export {
  type AttachmentRejection,
  type AttachmentsState,
  type ClipboardLikeEvent,
  type DragLikeEvent,
  type StagedAttachment,
  type StagedAttachmentStatus,
  type UseAttachmentsOptions,
  useAttachments,
} from './attachments/use-attachments.js';
export {
  type AgentBackend,
  AgentBackendUnsupportedError,
  type AgentConnection,
  type AttachmentUploadStrategy,
  type ChatStreamRequest,
  type ChatStreamResponse,
  type MessageFeedbackInput,
  type QueuedMessageUpdate,
  type QueuedSendResult,
  type ResumeStreamRequest,
  requireBackendMethod,
  type UploadAttachmentOptions,
} from './backend.js';
export { type BackgroundRun, backgroundRunsFromThread } from './background-runs.js';
export { type AgentsState, type UseAgentsOptions, useAgents } from './catalog/use-agents.js';
export {
  type ModelOption,
  type ModelsState,
  type UseModelsOptions,
  useModels,
} from './catalog/use-models.js';
export {
  AgentClient,
  type AgentClientOptions,
  AgentHttpError,
  type AgentRequestError,
  type CancelResult,
  type HttpErrorListener,
  type ThreadPatch,
} from './client.js';
// Named, never `export *`: a wildcard re-export from a barrel defeats a bundler's ability to see
// which names a consumer actually uses, and has broken a downstream build in this ecosystem before.
export {
  type AmbientRenderUi,
  AmbientRenderUiContext,
  type AnyToolUIPart,
  ChatInput,
  type ChatInputProps,
  type ChatStatus,
  DEFAULT_SPEECH_LANG,
  formatRelativeTime,
  loadStoredSpeechLang,
  MessageItem,
  type MessageItemClassNames,
  type MessageItemProps,
  MessageItemView,
  type MessageItemViewProps,
  MessageList,
  type MessageListClassNames,
  type MessageListProps,
  type MessageUsageInfo,
  persistSpeechLang,
  type RenderFilesFn,
  type RenderReasoningFn,
  type RenderTextFn,
  type RenderToolGroupFn,
  type RenderToolPartFn,
  type RenderUiFn,
  SPEECH_LANGUAGES,
  type SpeechLanguage,
  type SpeechRecognitionHook,
  type UseSpeechRecognitionOptions,
  useAmbientRenderUi,
  useSpeechRecognition,
} from './components/index.js';
export {
  type AutocompleteInputProps,
  type AutocompleteItem,
  type AutocompleteListboxProps,
  type AutocompleteOptionProps,
  type AutocompleteSource,
  applyCompletion,
  type CompletionEdit,
  type ComposerAutocomplete,
  createSkillsSource,
  filterAutocompleteItems,
  findActiveTrigger,
  type SkillSuggestionData,
  type SkillsSourceOptions,
  type TriggerMatch,
  type TriggerPosition,
  type UseComposerAutocompleteOptions,
  useComposerAutocomplete,
} from './composer/index.js';
export {
  type AgentConfigState,
  type UseAgentConfigOptions,
  useAgentConfig,
} from './config/use-agent-config.js';
export {
  type CoercibleQuestion,
  coerceAnswer,
  type ElicitationInput,
  type ElicitationInputType,
  type RawAnswer,
  validateAnswer,
  validateAnswerValue,
} from './elicitation/answers.js';
export {
  type MessageFeedbackState,
  type UseMessageFeedbackOptions,
  useMessageFeedback,
} from './feedback/use-message-feedback.js';
export {
  fillTemplate,
  phraseFor,
  readPath,
  type ToolCatalog,
  toolCatalogFrom,
} from './presentation/phrasing.js';
export {
  inferResultView,
  type ResolvedReading,
  type ResolvedResultView,
  resolveResultView,
} from './presentation/result-view.js';
export {
  correctedCallIds,
  type DescribeToolCallOptions,
  describeToolCall,
  type GroupToolActivityOptions,
  groupToolActivity,
  isActionCall,
  type ToolActivityGroup,
  type ToolCallDescription,
  type ToolCallState,
  type ToolCallStatus,
  toolCallState,
} from './presentation/tool-activity.js';
export {
  ALL_AGENTS,
  type ToolCatalogState,
  type UseToolCatalogOptions,
  useToolCatalog,
} from './presentation/use-tool-catalog.js';
export { AgentProvider, type AgentProviderProps, useAgentBackend } from './provider.js';
export type {
  ChatQueue,
  QueuedChatMessage,
  SendWhileRunning,
  WhileRunning,
} from './queue/model.js';
export { type QuotaState, type UseQuotaOptions, useQuota } from './quota/use-quota.js';
export {
  formatElapsed,
  readReasoningMs,
  type UseElapsedOptions,
  useElapsed,
} from './reasoning/timing.js';
export {
  AGENT_RUN_ERROR_CODES,
  type AgentRunErrorCode,
  type AgentRunFailure,
  isRunNotActiveError,
  RUN_NOT_ACTIVE_CODE,
} from './run-errors.js';
export { storedMessageToUiMessage } from './stored-message-to-ui-message.js';
export {
  type AgentMessageMetadata,
  type AggregatedTurnUsage,
  type StoredTurnMetadata,
  storedThreadToUiMessages,
} from './stored-thread-to-ui-messages.js';
export {
  notifyThreads,
  onThreadsEvent,
  type ThreadsEvent,
} from './threads/threads-events.js';
export { type ThreadsState, type UseThreadsOptions, useThreads } from './threads/use-threads.js';
export {
  type AnswerInput,
  type ApprovalBlockOptions,
  type ApproveInput,
  type ApproveOptions,
  type BuildBlocksOptions,
  buildTranscriptBlocks,
  type ChatTranscript,
  describeTimestamp,
  describeUsage,
  type EditSubmitInput,
  type ElicitationBlockOptions,
  extractMessageText,
  type MessageActionInput,
  type RejectInput,
  type RetrievedPassage,
  type SettleAction,
  type SkipInput,
  type StickToBottom,
  type StickToBottomOptions,
  type TimestampInfo,
  type TranscriptActionState,
  type TranscriptApproval,
  type TranscriptApprovalStatus,
  type TranscriptBlock,
  type TranscriptCopyState,
  type TranscriptEditState,
  type TranscriptElicitationBlock,
  type TranscriptElicitationOutcome,
  type TranscriptFile,
  type TranscriptFilesBlock,
  type TranscriptItem,
  type TranscriptItemOptions,
  type TranscriptQuestion,
  type TranscriptQuestionOption,
  type TranscriptQueuedFile,
  type TranscriptQueuedItem,
  type TranscriptReasoningBlock,
  type TranscriptSettleState,
  type TranscriptSource,
  type TranscriptSourcesBlock,
  type TranscriptStopState,
  type TranscriptTextBlock,
  type TranscriptToolBlock,
  type TranscriptToolCall,
  type TranscriptUiBlock,
  type TranscriptWindow,
  type UsageSummary,
  type UseChatTranscriptOptions,
  type UseTranscriptItemOptions,
  useChatTranscript,
  useStickToBottom,
  useTranscriptItem,
} from './transcript/index.js';
export {
  type ChatBackground,
  QuotaBlockedError,
  type UseAgentChatOptions,
  useAgentChat,
} from './use-agent-chat.js';
