/**
 * `@adonis-agora/agent/channels` — the agent on text channels (WhatsApp, Telegram, …): one webhook
 * route per channel that verifies, deduplicates, acknowledges at once and answers in the background,
 * with the channel's markdown, length limit and reply buttons. See `docs/channels.mdx`.
 */
export { type EvolutionApiOptions, evolutionApi } from './adapters/evolution_api.js';
export { type TelegramOptions, telegram } from './adapters/telegram.js';
export { type WhatsappCloudOptions, whatsappCloud } from './adapters/whatsapp_cloud.js';
export {
  type ChannelAddress,
  type ChannelHandleOptions,
  type ChannelMediaRefusal,
  type ChannelProposal,
  type ChannelRouteHandler,
  type ChannelTexts,
  type ChannelTextsOverrides,
  type ChannelTurnService,
  channels,
  channelTextsFor,
  DEFAULT_CHANNEL_TEXTS,
  handleChannel,
  proposalButtonIds,
  ptBrChannelTexts,
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
export type {
  ChannelAdapter,
  ChannelButton,
  ChannelCapabilities,
  ChannelChallengeResponse,
  ChannelMarkdown,
  ChannelMediaFile,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundMessage,
} from './types.js';
