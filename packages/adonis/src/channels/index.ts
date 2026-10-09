/**
 * `@adonis-agora/agent/channels` — the agent on text channels (WhatsApp, Telegram, …): one webhook
 * route per channel that verifies, deduplicates, acknowledges at once and answers in the background
 * (durably, one message at a time per conversation, when the agent runs on `@adonis-agora/durable`),
 * with the channel's markdown, length limit, reply buttons and files. See `docs/channels.mdx`.
 */
export { type EvolutionApiOptions, evolutionApi } from './adapters/evolution_api.js';
export { type TelegramOptions, telegram } from './adapters/telegram.js';
export { type WhatsappCloudOptions, whatsappCloud } from './adapters/whatsapp_cloud.js';
export { type WhatsmiauOptions, whatsmiau } from './adapters/whatsmiau.js';
export {
  type ChannelExecutor,
  type ChannelJob,
  type ChannelRetryOptions,
  type ChannelWorkflowCtx,
  type ChannelWorkflowEngine,
  retryableByDefault,
} from './executor.js';
export {
  type ChannelAddress,
  type ChannelDelivery,
  type ChannelGate,
  type ChannelGenui,
  type ChannelHandleOptions,
  type ChannelHookContext,
  type ChannelInbound,
  type ChannelPreparedMedia,
  type ChannelReply,
  type ChannelRouteHandler,
  type ChannelTurnEnded,
  type ChannelTurnOutcome,
  type ChannelTurnService,
  type ChannelTurnStarted,
  type ChannelWebhookEvent,
  channels,
  handleChannel,
  proposalButtonIds,
  relayChannelOutcome,
} from './handler.js';
export { ChannelDeliveryError, type ChannelFetch, ChannelMediaTooLargeError } from './http.js';
export {
  escapeTelegramMarkdown,
  toChannelMarkdown,
  unescapeTelegramMarkdown,
} from './markdown.js';
export {
  type ChannelAnswer,
  type ChannelQuestionTexts,
  DEFAULT_CHANNEL_QUESTION_TEXTS,
  formatChannelQuestion,
  parseChannelAnswer,
  ptBrChannelQuestionTexts,
} from './questions.js';
export { splitMessage } from './split.js';
export {
  type ChannelStore,
  type ChannelStoreRedis,
  InMemoryChannelStore,
  type LucidChannelStoreDatabase,
  type LucidChannelStoreOptions,
  lucidChannelStore,
  redisChannelStore,
} from './store.js';
export {
  type ChannelComponent,
  type ChannelMediaRefusal,
  type ChannelProposal,
  type ChannelTexts,
  type ChannelTextsOverrides,
  channelTextsFor,
  DEFAULT_CHANNEL_TEXTS,
  ptBrChannelTexts,
} from './texts.js';
export type {
  ChannelAdapter,
  ChannelButton,
  ChannelCapabilities,
  ChannelChallengeResponse,
  ChannelIgnored,
  ChannelListRow,
  ChannelMarkdown,
  ChannelMediaFile,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundList,
  OutboundMedia,
  OutboundMessage,
} from './types.js';
