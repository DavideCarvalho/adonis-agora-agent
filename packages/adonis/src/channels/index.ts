/**
 * `@adonis-agora/agent/channels` — the agent on text channels (WhatsApp, Telegram, …): one webhook
 * route per channel that verifies, deduplicates, acknowledges at once and answers in the background,
 * with the channel's markdown, length limit and reply buttons. See `docs/channels.mdx`.
 */
export { type EvolutionApiOptions, evolutionApi } from './adapters/evolution_api.js';
export { type TelegramOptions, telegram } from './adapters/telegram.js';
export { type WhatsappCloudOptions, whatsappCloud } from './adapters/whatsapp_cloud.js';
export {
  type ChannelDedupeRedis,
  type ChannelDedupeStore,
  InMemoryChannelDedupe,
  redisChannelDedupe,
} from './dedupe.js';
export {
  type ChannelHandleOptions,
  type ChannelProposal,
  type ChannelRouteHandler,
  type ChannelTexts,
  type ChannelTurnService,
  channels,
  DEFAULT_CHANNEL_TEXTS,
  handleChannel,
  proposalButtonIds,
} from './handler.js';
export { ChannelDeliveryError, type ChannelFetch } from './http.js';
export {
  escapeTelegramMarkdown,
  toChannelMarkdown,
  unescapeTelegramMarkdown,
} from './markdown.js';
export { splitMessage } from './split.js';
export type {
  ChannelAdapter,
  ChannelButton,
  ChannelCapabilities,
  ChannelChallengeResponse,
  ChannelMarkdown,
  ChannelRequest,
  InboundMessage,
  OutboundMessage,
} from './types.js';
