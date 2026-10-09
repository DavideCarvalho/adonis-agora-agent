/**
 * Per-channel generative UI: what a turn may draw depends on where it is read. A web page draws the
 * catalog's components (and the sandbox); WhatsApp and Telegram draw text, reply buttons, lists and
 * images; an email draws HTML. `genui({ channels: { … } })` sets, per channel, which tools the model
 * is offered and how what it pushes is delivered — and the model is told only what that channel can
 * draw.
 *
 * Framework-free and isomorphic, like the rest of `genui`.
 */
import type { UiAction } from './actions.js';
import {
  type Catalog,
  type ComponentDefinition,
  defineCatalog,
  type GenuiStreaming,
} from './catalog.js';
import { type DefineSandboxOptions, defineSandbox, sandboxPolicyOf } from './sandbox.js';
import { componentToText } from './text.js';
import { GENUI_TREE_COMPONENT, type GenuiElement } from './tree.js';

/** The channel a turn runs on when nothing says otherwise: a browser (AG-UI, the HTTP chat, A2UI). */
export const WEB_CHANNEL = 'web';
/** The `channels` entry that serves every channel without one of its own. */
export const DEFAULT_CHANNEL = 'default';
/** Channels a person reads in a messaging app or a mailbox: the server draws for them. */
export const MESSAGING_CHANNELS: readonly string[] = Object.freeze([
  'whatsapp',
  'telegram',
  'email',
]);

/**
 * What the model is offered on a channel: `tree` — one `ui__render` tool composing the catalog (and
 * the sandbox, when on); `per-component` — one `ui__show_<component>` tool per component that can be
 * drawn there; `text` — no UI tools, the model answers in text.
 */
export type GenuiChannelMode = 'tree' | 'per-component' | 'text';

/**
 * How what the model pushed reaches a channel the server draws for (WhatsApp, Telegram, email):
 * `native` — each component's channel conversion (`defineComponent(…, { channels })`: text, reply
 * buttons, a list, an image), its text summary otherwise; `text` — always the text summary; `html` —
 * HTML (email). A web channel draws in the browser and ignores it.
 */
export type GenuiChannelRender = 'native' | 'text' | 'html';

/** One channel's generative UI — every field falls back to the `default` entry, then to the top level. */
export interface GenuiChannelOptions {
  /** Default: the top-level `mode` on a web channel; `per-component` on a messaging channel. */
  mode?: GenuiChannelMode;
  /** Tree mode: draw the layout while the model writes it (`partial`) or once it is whole. */
  streaming?: GenuiStreaming;
  /**
   * The sandbox on this channel: `false` for none, `true` / a config for the sandbox with those
   * options (a web channel may use the app's kit while a mobile one does not). Default: the
   * top-level `sandbox` on a web channel; never on a messaging channel (it cannot run there).
   */
  sandbox?: boolean | DefineSandboxOptions;
  /** Default `native` (`html` for `email`). */
  render?: GenuiChannelRender;
  /** Charts as PNG images on a channel that takes images ({@link ChartImageRenderer}, `chartImages()`). */
  chartImages?: ChartImageRenderer;
  /** Extra words for the model on this channel, added to the UI tools' descriptions. */
  instructions?: string;
}

/** `genui({ channels })`: an entry per channel name, plus `default` for every other one. */
export interface GenuiChannels {
  web?: GenuiChannelOptions;
  mobile?: GenuiChannelOptions;
  whatsapp?: GenuiChannelOptions;
  telegram?: GenuiChannelOptions;
  email?: GenuiChannelOptions;
  default?: GenuiChannelOptions;
  [channel: string]: GenuiChannelOptions | undefined;
}

/** The top-level genui options a channel falls back to. */
export interface GenuiChannelBase {
  mode?: 'per-component' | 'tree';
  streaming?: GenuiStreaming;
  sandbox?: boolean | DefineSandboxOptions;
}

/** A channel's options with every default applied — what the tools and the channel handler follow. */
export interface ResolvedGenuiChannel {
  /** The channel's name (`web`, `whatsapp`, `mobile`, …). */
  name: string;
  /** The server draws for it (WhatsApp, Telegram, email): it never runs a sandbox or a React renderer. */
  messaging: boolean;
  /** `channels` has an entry for it (its own or `default`). `false` → it behaves as it always did. */
  configured: boolean;
  mode: GenuiChannelMode;
  streaming?: GenuiStreaming;
  /** `undefined` → the catalog's own sandbox (if it has one) is left as it is. */
  sandbox?: boolean | DefineSandboxOptions;
  render: GenuiChannelRender;
  chartImages?: ChartImageRenderer;
  instructions?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * THE rule for which channel a turn runs on, read from its page context:
 *
 * - `pageContext.channel` is a string → that channel (an explicit override: `send({ channel })`, a
 *   mobile client posting `pageContext: { channel: 'mobile' }`);
 * - `pageContext.channel` is the address a text-channel adapter stamps (`{ name, conversation,
 *   kind? }`) → its `kind` (`whatsapp`, `telegram`), else its `name`;
 * - nothing → `web`: what AG-UI, the HTTP chat and A2UI serve (they stamp nothing, so a tool that
 *   skips skeletons when `pageContext.channel` is set keeps working).
 */
export function turnChannel(pageContext: { [key: string]: unknown } | undefined): string {
  const value = pageContext?.channel;
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecord(value)) {
    if (typeof value.kind === 'string' && value.kind.length > 0) return value.kind;
    if (typeof value.name === 'string' && value.name.length > 0) return value.name;
  }
  return WEB_CHANNEL;
}

/** WhatsApp, Telegram and email are drawn by the server; every other channel by a client. */
export function isMessagingChannel(channel: string): boolean {
  return MESSAGING_CHANNELS.includes(channel);
}

/** One channel's options, its own entry over `default` over the top level. */
export function resolveGenuiChannel(
  base: GenuiChannelBase,
  channels: GenuiChannels | undefined,
  channel: string | undefined,
): ResolvedGenuiChannel {
  const name = channel ?? WEB_CHANNEL;
  const messaging = isMessagingChannel(name);
  const entry = channels === undefined ? undefined : (channels[name] ?? channels.default);
  if (entry === undefined) {
    return {
      name,
      messaging,
      configured: false,
      mode: base.mode ?? 'tree',
      ...(base.streaming !== undefined ? { streaming: base.streaming } : {}),
      ...(base.sandbox !== undefined ? { sandbox: base.sandbox } : {}),
      render: name === 'email' ? 'html' : 'native',
    };
  }
  const sandbox = messaging ? false : (entry.sandbox ?? base.sandbox);
  const streaming = entry.streaming ?? base.streaming;
  return {
    name,
    messaging,
    configured: true,
    mode: entry.mode ?? (messaging ? 'per-component' : (base.mode ?? 'tree')),
    ...(streaming !== undefined ? { streaming } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    render: entry.render ?? (name === 'email' ? 'html' : 'native'),
    ...(entry.chartImages !== undefined ? { chartImages: entry.chartImages } : {}),
    ...(entry.instructions !== undefined ? { instructions: entry.instructions } : {}),
  };
}

/** Throws on a `channels` entry that names an unknown mode or render. */
export function assertGenuiChannels(channels: GenuiChannels | undefined): void {
  if (channels === undefined) return;
  if (!isRecord(channels)) throw new TypeError('genui: channels must be an object');
  for (const [name, entry] of Object.entries(channels)) {
    if (entry === undefined) continue;
    if (!isRecord(entry)) throw new TypeError(`genui: channels.${name} must be an object`);
    if (entry.mode !== undefined && !['tree', 'per-component', 'text'].includes(String(entry.mode)))
      throw new TypeError(`genui: channels.${name}.mode must be 'tree', 'per-component' or 'text'`);
    if (entry.render !== undefined && !['native', 'text', 'html'].includes(String(entry.render)))
      throw new TypeError(`genui: channels.${name}.render must be 'native', 'text' or 'html'`);
    if (
      entry.streaming !== undefined &&
      entry.streaming !== 'partial' &&
      entry.streaming !== 'complete'
    )
      throw new TypeError(`genui: channels.${name}.streaming must be 'partial' or 'complete'`);
  }
}

// ── Native conversions ─────────────────────────────────────────────────────────────────────────

/**
 * A reply button. Pressed, it becomes the user's next turn — a {@link UiAction} whose text is the
 * label and whose context is `value`, exactly like a sandbox's `agent.send`.
 */
export interface ChannelNativeButton {
  label: string;
  /** The action's name. Default `select`. */
  action?: string;
  /** The values that go with the press (JSON). */
  value?: Record<string, unknown>;
}

export interface ChannelNativeListItem extends ChannelNativeButton {
  /** A second line under the label. */
  description?: string;
}

/** A list to pick one entry from (a WhatsApp list message, a Telegram keyboard of one row each). */
export interface ChannelNativeList {
  /** The label of the button that opens the list (WhatsApp). */
  button: string;
  /** A heading over the entries. */
  title?: string;
  items: ChannelNativeListItem[];
}

/** An image: by an `https` url the provider fetches, or its bytes. */
export interface ChannelNativeImage {
  url?: string;
  data?: Uint8Array;
  /** Default `image/png`. */
  contentType?: string;
}

/**
 * What a component is on a channel the server draws for. Each field is optional; a message with an
 * image sends `text` as its caption, one with buttons or a list sends `text` as its body.
 */
export interface ChannelNativeMessage {
  /** In the model's markdown — converted to the channel's. */
  text?: string;
  /** For `render: 'html'` (email). Trusted markup: build it from props, escaping what you insert. */
  html?: string;
  /** Reply buttons — at most 3 on WhatsApp; more become a list. */
  buttons?: ChannelNativeButton[];
  list?: ChannelNativeList;
  image?: ChannelNativeImage;
}

/** `defineComponent(…, { channels: { whatsapp: (props) => ({ text, buttons }) } })`. */
export type ChannelConversion<P = Record<string, unknown>> = {
  // Method syntax: bivariant in `props`, so a typed definition stays a `ComponentDefinition<unknown>`.
  convert(
    props: P,
    context: { channel: string },
  ):
    | ChannelNativeMessage
    | ChannelNativeMessage[]
    | null
    | undefined
    | Promise<ChannelNativeMessage | ChannelNativeMessage[] | null | undefined>;
}['convert'];

/**
 * A component's conversions, by channel name. `false` → the component is never offered on that
 * channel (it has nothing to say there).
 */
export type ComponentChannels<P = Record<string, unknown>> = {
  [channel: string]: ChannelConversion<P> | false | undefined;
};

/** Renders chart components as images, for a channel that takes them. */
export interface ChartImageRenderer {
  /** The components it draws (default for `chartImages()`: `['Chart']`). */
  readonly components: readonly string[];
  render(component: string, props: Record<string, unknown>): Promise<ChannelNativeImage | null>;
}

function conversionOf(
  definition: ComponentDefinition<unknown> | undefined,
  channel: string,
): ChannelConversion<unknown> | false | undefined {
  const channels = (definition as { channels?: ComponentChannels<unknown> } | undefined)?.channels;
  return channels === undefined || !Object.hasOwn(channels, channel)
    ? undefined
    : channels[channel];
}

/** A sandbox component (it carries a sandbox policy). */
function isSandbox(definition: ComponentDefinition<unknown>): boolean {
  return sandboxPolicyOf(definition) !== undefined;
}

/**
 * Whether `definition` can be drawn on `channel`. On a web channel every component can (the client's
 * `uiCapabilities` narrow it); on a messaging channel a component can when it has a conversion for
 * it, a chart renderer draws it, or it has a text summary (`fallbackText`) — a component without one
 * would arrive as a JSON dump, so it is not offered. A sandbox never can, and `channels: { x: false }`
 * opts a component out.
 */
export function canRenderOnChannel(
  definition: ComponentDefinition<unknown>,
  channel: ResolvedGenuiChannel,
): boolean {
  if (definition.internal === true) return false;
  if (isSandbox(definition)) return !channel.messaging && channel.sandbox !== false;
  if (!channel.messaging) return conversionOf(definition, channel.name) !== false;
  const conversion = conversionOf(definition, channel.name);
  if (conversion === false) return false;
  if (definition.fallbackText !== undefined) return true;
  if (channel.render === 'text') return false;
  if (typeof conversion === 'function') return true;
  return channel.chartImages?.components.includes(definition.name) === true;
}

/**
 * The catalog as `channel` may draw it: only what it can render, and its own sandbox (or none). With
 * no `channels` configured the catalog is returned as it is.
 */
export function channelCatalog(catalog: Catalog, channel: ResolvedGenuiChannel): Catalog {
  if (!channel.configured) return catalog;
  if (channel.mode === 'text') return defineCatalog([], { jsonSchemaValidator: catalog.validator });
  const existing = catalog.components.find(isSandbox);
  const kept = catalog.components.filter(
    (definition) => !isSandbox(definition) && canRenderOnChannel(definition, channel),
  );
  const sandbox =
    channel.messaging || channel.sandbox === false
      ? undefined
      : channel.sandbox === undefined || channel.sandbox === true
        ? (existing ?? (channel.sandbox === true ? defineSandbox() : undefined))
        : defineSandbox({
            ...(existing !== undefined ? { name: existing.name } : {}),
            ...channel.sandbox,
          });
  return defineCatalog(sandbox === undefined ? kept : [...kept, sandbox], {
    jsonSchemaValidator: catalog.validator,
  });
}

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  email: 'email',
};

/** What a UI tool's description says about the channel the conversation is on. */
export function channelInstructions(channel: ResolvedGenuiChannel): string | undefined {
  if (!channel.configured) return undefined;
  const lines: string[] = [];
  if (channel.messaging) {
    const label = CHANNEL_LABELS[channel.name] ?? channel.name;
    lines.push(
      channel.render === 'html'
        ? `This conversation is read by ${label}: components arrive as formatted messages.`
        : channel.render === 'text'
          ? `This conversation is on ${label}: components arrive as their text summary.`
          : `This conversation is on ${label}: components arrive as ${label} messages (text, reply buttons, lists, images) — no interactive views, no custom layouts.`,
    );
  }
  if (channel.instructions !== undefined) lines.push(channel.instructions);
  return lines.length > 0 ? lines.join(' ') : undefined;
}

/** A pushed component, as a channel delivers it. */
export interface ChannelComponentInput {
  /** The frame's id — what a button press reports as its `componentId`. */
  id?: string;
  name: string;
  props: Record<string, unknown>;
}

/** {@link ChannelNativeMessage} plus the component it came from (so a press can name it). */
export interface ChannelRenderedMessage extends ChannelNativeMessage {
  component: string;
  componentId?: string;
  title?: string;
}

function titleOf(props: Record<string, unknown>): string | undefined {
  return typeof props.title === 'string' && props.title.length > 0 ? props.title : undefined;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text as minimal HTML: paragraphs, line breaks, `*bold*`. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter((block) => block.trim() !== '')
    .map(
      (block) =>
        `<p>${escapeHtml(block)
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br>')}</p>`,
    )
    .join('\n');
}

async function nodeMessages(
  catalog: Catalog,
  name: string,
  props: Record<string, unknown>,
  channel: ResolvedGenuiChannel,
): Promise<ChannelNativeMessage[] | undefined> {
  if (channel.render === 'text') return undefined;
  const definition = catalog.get(name);
  const conversion = conversionOf(definition, channel.name);
  if (typeof conversion === 'function') {
    try {
      const converted = await conversion(props, { channel: channel.name });
      if (converted !== null && converted !== undefined)
        return Array.isArray(converted) ? converted : [converted];
    } catch {
      /* a failing conversion falls back to the text summary */
    }
  }
  if (channel.chartImages?.components.includes(name) === true) {
    try {
      const image = await channel.chartImages.render(name, props);
      if (image !== null) {
        const title = titleOf(props);
        return [{ image, ...(title !== undefined ? { text: `*${title}*` } : {}) }];
      }
    } catch {
      /* no image: the text summary */
    }
  }
  return undefined;
}

/**
 * What a pushed component (a tree included) is on a channel the server draws for: one or more
 * messages — its conversions, chart images, and the text summary of everything else, in order.
 * Consecutive text is joined. Never throws: a conversion that fails sends the summary.
 */
export async function renderChannelMessages(
  catalog: Catalog,
  component: ChannelComponentInput,
  channel: ResolvedGenuiChannel,
): Promise<ChannelRenderedMessage[]> {
  const out: ChannelRenderedMessage[] = [];
  const pushText = (text: string, from: { name: string; id?: string; title?: string }) => {
    // (`from` names where the text came from: the first component of a run of text.)
    if (text.trim() === '') return;
    const last = out.at(-1);
    if (
      last !== undefined &&
      last.buttons === undefined &&
      last.list === undefined &&
      last.image === undefined &&
      last.html === undefined &&
      last.text !== undefined
    ) {
      last.text = `${last.text}\n\n${text}`;
      return;
    }
    out.push({
      text,
      component: from.name,
      ...(from.id !== undefined ? { componentId: from.id } : {}),
      ...(from.title !== undefined ? { title: from.title } : {}),
    });
  };
  const visit = async (
    name: string,
    props: Record<string, unknown>,
    id: string | undefined,
    children: GenuiElement[] | undefined,
    depth: number,
  ) => {
    if (depth > 32) return;
    const title = titleOf(props);
    const from = {
      name,
      ...(id !== undefined ? { id } : {}),
      ...(title !== undefined ? { title } : {}),
    };
    const native = await nodeMessages(catalog, name, props, channel);
    if (native !== undefined) {
      for (const message of native) {
        if (
          message.image === undefined &&
          message.buttons === undefined &&
          message.list === undefined &&
          message.html === undefined &&
          typeof message.text === 'string'
        ) {
          pushText(message.text, from);
          continue;
        }
        out.push({
          ...message,
          component: name,
          ...(id !== undefined ? { componentId: id } : {}),
          ...(title !== undefined ? { title } : {}),
        });
      }
    } else {
      const definition = catalog.get(name);
      const own =
        definition?.children === true && definition.fallbackText === undefined
          ? ''
          : componentToText(catalog, name, props);
      pushText(own, from);
    }
    for (const child of children ?? [])
      await visit(child.type, child.props, id, child.children, depth + 1);
  };
  if (component.name === GENUI_TREE_COMPONENT) {
    const root = component.props.root as GenuiElement | undefined;
    if (root !== undefined) {
      await visit(root.type, root.props, component.id, root.children, 0);
    }
  } else {
    await visit(component.name, component.props, component.id, undefined, 0);
  }
  if (channel.render === 'html') {
    for (const message of out) {
      if (message.html === undefined && message.text !== undefined)
        message.html = textToHtml(message.text);
    }
  }
  return out;
}

/** The UI action a pressed button (or picked list entry) stands for — the user's next turn. */
export function channelButtonAction(
  button: ChannelNativeButton,
  from: { componentId?: string; title?: string },
): UiAction {
  return {
    source: 'component',
    name:
      button.action !== undefined && /^[A-Za-z0-9_.:-]{1,64}$/.test(button.action)
        ? button.action
        : 'select',
    context: isRecord(button.value) ? button.value : {},
    text: button.label,
    ...(from.componentId !== undefined ? { componentId: from.componentId } : {}),
    ...(from.title !== undefined ? { title: from.title } : {}),
    timestamp: new Date().toISOString(),
  };
}
