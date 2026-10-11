import { snapshotActionProposal } from './action-proposal-transitions.js';
import type { ChannelChoiceLimits, GenuiChannelBase, GenuiChannels } from './genui/channels.js';
import type { Catalog } from './genui/index.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { ToolDescribeScope } from './spi/tool.js';
import type { AgentUiComponent } from './stream-events.js';

import { createUiCollector, type UiCollector } from './tool-ui.js';
export type ResolveToolUiCatalog = (scope: ToolDescribeScope) => Catalog | Promise<Catalog>;

/**
 * Per-channel words for the model, from genui's `channels`: the turn's prompt block on a channel the
 * server draws for (WhatsApp, Telegram, email — `channelPrompt`), and what a tool's pushes were
 * delivered there as (`describeChannelComponents`), which the tool's result carries as `delivered`.
 * Both answer `undefined` on a web-like channel.
 */
export interface ToolUiChannelGuide {
  prompt(scope: ToolDescribeScope): Promise<string | undefined>;
  /** `limits`: the turn's adapter's buttons and list rows (`pageContext.channel.choices`). */
  delivered(
    scope: ToolDescribeScope,
    components: readonly AgentUiComponent[],
    limits?: ChannelChoiceLimits,
  ): Promise<string | undefined>;
}

/** The adapter's choice limits a text channel stamped on the turn (`pageContext.channel.choices`). */
export function channelChoiceLimits(pageContext: unknown): ChannelChoiceLimits | undefined {
  const channel = (pageContext as { channel?: unknown } | undefined)?.channel;
  const choices = (channel as { choices?: unknown } | undefined)?.choices as
    | { buttons?: unknown; lists?: unknown }
    | undefined;
  return typeof choices === 'object' &&
    choices !== null &&
    typeof choices.buttons === 'number' &&
    typeof choices.lists === 'number'
    ? { buttons: choices.buttons, lists: choices.lists }
    : undefined;
}

/** The {@link ToolUiChannelGuide} of a genui setup with `channels`. */
export function createToolUiChannelGuide(options: {
  channels: GenuiChannels;
  base?: GenuiChannelBase;
  resolveCatalog: ResolveToolUiCatalog;
}): ToolUiChannelGuide {
  const resolved = async (scope: ToolDescribeScope) => {
    const channels = await import('./genui/channels.js');
    const channel = channels.resolveGenuiChannel(
      options.base ?? {},
      options.channels,
      scope.channel,
    );
    return { channels, channel };
  };
  return {
    async prompt(scope) {
      const { channels, channel } = await resolved(scope);
      if (!channel.configured || !channel.messaging) return undefined;
      return channels.channelPrompt(await options.resolveCatalog(scope), channel);
    },
    async delivered(scope, components, limits) {
      const { channels, channel } = await resolved(scope);
      if (!channel.configured || !channel.messaging || components.length === 0) return undefined;
      return channels.describeChannelComponents(
        await options.resolveCatalog(scope),
        components.map((component) => ({
          id: component.id,
          name: component.component,
          props: component.props,
          ...(component.partial === true ? { partial: true } : {}),
        })),
        channel,
        limits,
      );
    },
  };
}

/**
 * A tool's output with what its pushes were delivered as on a messaging channel: `{ …output,
 * delivered }` for an object output, `{ result: output, delivered }` for anything else (or an object
 * that already has a `delivered` of its own).
 */
export function withDelivered(output: unknown, delivered: string): unknown {
  if (
    typeof output === 'object' &&
    output !== null &&
    !Array.isArray(output) &&
    !Object.hasOwn(output, 'delivered')
  ) {
    return { ...(output as Record<string, unknown>), delivered };
  }
  return { result: output === undefined ? null : output, delivered };
}
export interface NegotiatedUiCollector extends UiCollector {
  text(): string;
}
export function createNegotiatedUiCollector(
  toolCallId: string,
  scope: ToolDescribeScope,
  resolveCatalog?: ResolveToolUiCatalog,
  writer?: SinkWriter,
): NegotiatedUiCollector {
  const collector = createUiCollector(toolCallId, writer);
  const texts = new Map<string, string>();
  let next = 0;
  return {
    components: collector.components,
    text: () => [...texts.values()].join('\n'),
    restart: () => {
      next = 0;
      texts.clear();
      collector.restart();
    },
    emit: async (component, props, options = {}) => {
      if (!resolveCatalog) {
        // No server catalog to negotiate against: the client's declaration can only narrow what is
        // drawn. A component it does not declare degrades to its fallback text, else is left out.
        const declared =
          scope.uiCapabilities === undefined ||
          scope.uiCapabilities.components.some(
            (entry) => entry.name === component && entry.version === (options.version ?? 1),
          );
        if (declared) return collector.emit(component, props, options);
        const id = options.id ?? `${toolCallId}:ui:${next++}`;
        if (options.fallbackText !== undefined && options.fallbackText.length > 0) {
          texts.set(id, options.fallbackText);
          await writer?.write({ t: 'text', v: options.fallbackText });
        }
        return { id };
      }
      props = snapshotActionProposal(props);
      options = { ...options };
      const { prepareUiEmission } = await import('./genui/index.js');
      const catalog = await resolveCatalog(scope);
      const prepared = await prepareUiEmission(
        catalog,
        scope.uiCapabilities,
        component,
        props,
        options.version,
      );
      const id = options.id ?? `${toolCallId}:ui:${next++}`;
      if (prepared.kind === 'text') {
        texts.set(id, prepared.text);
        await writer?.write({ t: 'text', v: prepared.text });
        return { id };
      }
      const fallbackText =
        'fallbackText' in prepared && typeof prepared.fallbackText === 'string'
          ? prepared.fallbackText
          : undefined;
      const versions = 'componentVersions' in prepared ? prepared.componentVersions : undefined;
      const componentVersions =
        versions !== null && typeof versions === 'object' && !Array.isArray(versions)
          ? (snapshotActionProposal(versions) as Record<string, number>)
          : undefined;
      return collector.emit(prepared.component, prepared.props, {
        id,
        version: prepared.version,
        ...(fallbackText !== undefined ? { fallbackText } : {}),
        ...(componentVersions !== undefined ? { componentVersions } : {}),
      });
    },
  };
}
