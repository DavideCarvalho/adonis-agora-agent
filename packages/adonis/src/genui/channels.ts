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

/**
 * What a conversion is told about the frame it converts. `version` is the schema version the props
 * were written for (the frame's — a v1 frame persisted before the component moved to v2 still says
 * 1); convert the props by it, as a renderer would.
 */
export interface ChannelConversionContext {
  /** The channel (`whatsapp`, `telegram`, `email`…). */
  channel: string;
  /** The component being converted (inside a tree: the node's). */
  component: string;
  /** The props' schema version: the frame's, or the tree's `componentVersions` entry. Default 1. */
  version: number;
  /** The frame's id, when it has one. */
  id?: string;
  /** The whole frame the component came from (a tree's, for one of its nodes), as given. */
  frame?: ChannelComponentInput;
}

/** What `describe` is told: the channel, and the version the component is at now. */
export interface ChannelDescribeContext {
  channel: string;
  component: string;
  /** The component definition's current version (default 1). */
  version: number;
}

/** `defineComponent(…, { channels: { whatsapp: (props, { version }) => ({ text, buttons }) } })`. */
export type ChannelConversion<P = Record<string, unknown>> = {
  // Method syntax: bivariant in `props`, so a typed definition stays a `ComponentDefinition<unknown>`.
  convert(
    props: P,
    context: ChannelConversionContext,
  ):
    | ChannelNativeMessage
    | ChannelNativeMessage[]
    | null
    | undefined
    | Promise<ChannelNativeMessage | ChannelNativeMessage[] | null | undefined>;
}['convert'];

/**
 * A conversion with words for the model: `describe` says how the component reaches the user on that
 * channel — `'a pick-list of the orders; no Refund buttons: to refund, the user picks an order and
 * replies'` — and goes into the channel's prompt (`channelPrompt`), so the model does not describe the
 * web view there. A bare conversion is described from what it can send.
 */
export interface ChannelConversionSpec<P = Record<string, unknown>> {
  convert: ChannelConversion<P>;
  /** Words for the model, or a function of the channel and the component's current version. */
  describe?: string | ((context: ChannelDescribeContext) => string | undefined);
}

/**
 * A component's conversions, by channel name — a function, or `{ convert, describe }`. `false` →
 * the component is never offered on that channel (it has nothing to say there).
 */
export type ComponentChannels<P = Record<string, unknown>> = {
  [channel: string]: ChannelConversion<P> | ChannelConversionSpec<P> | false | undefined;
};

/** Renders chart components as images, for a channel that takes them. */
export interface ChartImageRenderer {
  /** The components it draws (default for `chartImages()`: `['Chart']`). */
  readonly components: readonly string[];
  render(component: string, props: Record<string, unknown>): Promise<ChannelNativeImage | null>;
}

function conversionEntry(
  definition: ComponentDefinition<unknown> | undefined,
  channel: string,
): ChannelConversion<unknown> | ChannelConversionSpec<unknown> | false | undefined {
  const channels = (definition as { channels?: ComponentChannels<unknown> } | undefined)?.channels;
  return channels === undefined || !Object.hasOwn(channels, channel)
    ? undefined
    : channels[channel];
}

/** The component's conversion function for `channel` (`false`: opted out; `undefined`: none). */
function conversionOf(
  definition: ComponentDefinition<unknown> | undefined,
  channel: string,
): ChannelConversion<unknown> | false | undefined {
  const entry = conversionEntry(definition, channel);
  if (entry === false || entry === undefined || typeof entry === 'function') return entry;
  return typeof entry === 'object' && typeof entry.convert === 'function'
    ? entry.convert
    : undefined;
}

/** The conversion's own words for the model (`{ convert, describe }`), if it has them. */
function conversionDescription(
  definition: ComponentDefinition<unknown> | undefined,
  channel: string,
): string | undefined {
  const entry = conversionEntry(definition, channel);
  if (typeof entry !== 'object' || entry === null || definition === undefined) return undefined;
  const words =
    typeof entry.describe === 'function'
      ? entry.describe({ channel, component: definition.name, version: definition.version ?? 1 })
      : entry.describe;
  return typeof words === 'string' && words.trim() !== '' ? words.trim() : undefined;
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
  /** The schema version the props were written for (the frame's `version`). Default 1. */
  version?: number;
  /** A tree frame's per-component versions (`componentVersions`), for its nodes. */
  componentVersions?: Record<string, number>;
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
  context: Omit<ChannelConversionContext, 'channel' | 'component'>,
): Promise<ChannelNativeMessage[] | undefined> {
  if (channel.render === 'text') return undefined;
  const definition = catalog.get(name);
  const conversion = conversionOf(definition, channel.name);
  if (typeof conversion === 'function') {
    try {
      const converted = await conversion(props, {
        channel: channel.name,
        component: name,
        ...context,
      });
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
    // The props' version: the frame's own, or — for a tree's node — the tree's entry for it.
    const tree = component.name === GENUI_TREE_COMPONENT;
    const version = tree ? (component.componentVersions?.[name] ?? 1) : (component.version ?? 1);
    const native = await nodeMessages(catalog, name, props, channel, {
      version,
      ...(id !== undefined ? { id } : {}),
      frame: component,
    });
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

// ── What the model is told on a channel ───────────────────────────────────────────────────────

/** What a messaging channel can show at all, in the words the model reads. */
const CHANNEL_FORMS: Record<string, string> = {
  whatsapp:
    'text, up to 3 reply buttons, a pick-list (a list the user opens and picks one entry from) and images',
  telegram: 'text, buttons under a message and images',
  email: 'formatted text (an email): nothing in it is interactive',
};

function channelLabel(channel: ResolvedGenuiChannel): string {
  return CHANNEL_LABELS[channel.name] ?? channel.name;
}

/**
 * The system-prompt block for a turn on a messaging channel (WhatsApp, Telegram, email): that the
 * user is not on a web page, what the channel can show, and — component by component — how each one
 * reaches the user there, from its channel conversion (its `describe`, else what a conversion can
 * send), a chart image, or its text summary. Tool and component descriptions are written for the web
 * ("a table with a Refund button per row"); this is what keeps the model from describing that view
 * on WhatsApp. `undefined` on a web-like channel, or without `channels`.
 */
export function channelPrompt(catalog: Catalog, channel: ResolvedGenuiChannel): string | undefined {
  if (!channel.configured || !channel.messaging) return undefined;
  const label = channelLabel(channel);
  const forms = CHANNEL_FORMS[channel.name] ?? 'text messages';
  const own: string[] = [];
  const asText: string[] = [];
  const layouts: string[] = [];
  const allText = channel.mode === 'text' || channel.render === 'text';
  for (const definition of catalog.components) {
    if (isSandbox(definition)) continue;
    const conversion = conversionOf(definition, channel.name);
    if (conversion === false) continue;
    const named =
      definition.title === definition.name
        ? definition.name
        : `${definition.title} (${definition.name})`;
    if (definition.children === true) {
      layouts.push(named);
      continue;
    }
    if (allText) {
      asText.push(named);
      continue;
    }
    const described = conversionDescription(definition, channel.name);
    if (described !== undefined) {
      own.push(`- ${named}: ${described}`);
    } else if (typeof conversion === 'function') {
      own.push(
        channel.render === 'html'
          ? `- ${named}: a formatted section of the email — not the web view.`
          : `- ${named}: a ${label} message of its own (text, maybe with reply buttons, a pick-list or an image) — not the web view; the tool result's \`delivered\` says exactly what was sent.`,
      );
    } else if (channel.chartImages?.components.includes(definition.name) === true) {
      own.push(
        `- ${named}: a picture of the chart (an image, its title as the caption) — nothing in it can be hovered, clicked or filtered.`,
      );
    } else {
      asText.push(named);
    }
  }
  const lines = [
    `## Channel: ${label}`,
    `This conversation happens in ${label}, not on a web page. What tools and components show reaches the user as ${label} messages, and ${label} can only show ${forms}. There are no tables, cards, dashboards, charts to interact with, interactive views, or buttons inside a component.`,
    'Tool and component descriptions may describe the web view (a table, a button per row, a chart to hover). The user does not get that view here. How each component reaches the user here:',
    ...own,
    ...(asText.length > 0
      ? [
          `- As plain text (its summary), with no table, no buttons and nothing to click: ${asText.join(', ')}.`,
        ]
      : []),
    ...(layouts.length > 0
      ? [`- Layouts, sent as their contents one after another: ${layouts.join(', ')}.`]
      : []),
    `When a tool shows something, its result's \`delivered\` says exactly what the user received on ${label}. Describe only that: never mention a table, a button, a link or a view the user did not get, and never point "above"/"below" at one. To act on something, the user picks it from a list or buttons that were sent, or replies with what they want.`,
  ];
  if (channel.instructions !== undefined) lines.push(channel.instructions);
  return lines.join('\n');
}

function excerpt(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function quoted(labels: string[], max = 10): string {
  const shown = labels.slice(0, max).map((label) => `"${excerpt(label, 40)}"`);
  return labels.length > max
    ? `${shown.join(', ')} and ${labels.length - max} more`
    : shown.join(', ');
}

/**
 * How many reply buttons and list rows a channel shows — the adapter's `capabilities.buttons` /
 * `capabilities.lists`, which the channel handler stamps on the turn (`pageContext.channel.choices`).
 */
export interface ChannelChoiceLimits {
  buttons: number;
  lists: number;
}

/** What a channel's own adapters show, for a turn that did not say (WhatsApp Cloud, Telegram). */
const DEFAULT_CHOICE_LIMITS: Record<string, ChannelChoiceLimits> = {
  whatsapp: { buttons: 3, lists: 10 },
  telegram: { buttons: 8, lists: 30 },
};

/**
 * What a channel actually delivered, in words for the model: each message (text, a pick-list and its
 * entries, reply buttons, numbered choices, an image, an email section), and what the user did NOT
 * get. This is what a tool's result carries as `delivered` on a messaging channel, so the model talks
 * about the list the user can pick from — not the table with Refund buttons it would have on the web.
 *
 * Choices follow the channel handler's rule, within `limits` (default: the channel's own adapter's):
 * reply buttons when there is no list (or no lists) and they fit, else a list of at most `lists`
 * rows, else numbered text the user answers by replying.
 */
export function describeChannelDelivery(
  messages: readonly ChannelRenderedMessage[],
  channel: ResolvedGenuiChannel,
  limits?: ChannelChoiceLimits,
): string {
  const label = channelLabel(channel);
  if (messages.length === 0) return `Nothing was shown on ${label} for this.`;
  const { buttons: maxButtons, lists: maxRows } = limits ??
    DEFAULT_CHOICE_LIMITS[channel.name] ?? { buttons: 0, lists: 0 };
  let interactive = false;
  let numbered = false;
  const parts: string[] = [];
  for (const message of messages) {
    const text =
      message.text !== undefined && message.text.trim() !== '' ? message.text : undefined;
    if (message.image !== undefined)
      parts.push(`an image${text !== undefined ? ` captioned "${excerpt(text)}"` : ''}`);
    const choices: ChannelNativeButton[] = message.list?.items ?? message.buttons ?? [];
    // With an image, the text was its caption: the choices follow it on their own.
    const body = message.image === undefined ? text : undefined;
    const lead = body !== undefined ? `a message "${excerpt(body)}"` : 'a message';
    if (choices.length === 0) {
      if (message.image !== undefined) continue;
      parts.push(
        message.html !== undefined && channel.render === 'html'
          ? `a formatted email section${text !== undefined ? ` ("${excerpt(text)}")` : ''}`
          : `a text message "${excerpt(text ?? '')}"`,
      );
      continue;
    }
    const labels = choices.map((choice) => choice.label);
    const asButtons = message.list === undefined || maxRows === 0;
    if (asButtons && choices.length <= maxButtons) {
      interactive = true;
      parts.push(
        `${lead} with ${choices.length} reply ${choices.length === 1 ? 'button' : 'buttons'}: ${quoted(labels)} — pressing one comes back as the user's next message`,
      );
    } else if (maxRows > 0) {
      interactive = true;
      const rows = labels.slice(0, maxRows);
      const cut =
        labels.length > rows.length ? ` (only the first ${rows.length} of ${labels.length})` : '';
      const button = message.list?.button ?? 'Options';
      parts.push(
        `${lead} with a pick-list${message.list?.title !== undefined ? ` "${excerpt(message.list.title, 40)}"` : ''} (opened with "${excerpt(button, 30)}") of ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}${cut}: ${quoted(rows)} — picking one comes back as the user's next message`,
      );
    } else {
      numbered = true;
      parts.push(
        `${lead} with ${labels.length} numbered ${labels.length === 1 ? 'choice' : 'choices'} as text: ${quoted(labels)} — the user answers by replying with one`,
      );
    }
  }
  if (parts.length === 0) return `Nothing was shown on ${label} for this.`;
  const listed =
    parts.length === 1 ? parts[0] : parts.map((part, index) => `${index + 1}) ${part}`).join('; ');
  return [
    `Shown on ${label} as ${listed}.`,
    interactive
      ? 'That is all the user got: no table, no web view, and no buttons other than the ones listed.'
      : numbered
        ? 'That is all the user got: no table, no web view, no buttons and nothing to click — they answer by replying with a message.'
        : 'That is all the user got: no table, no web view, no buttons and nothing to click — they can only reply with a message.',
  ].join(' ');
}

/**
 * {@link describeChannelDelivery} of the components a tool pushed (last props per id, previews left
 * out), rendered the way the channel draws them. `undefined` on a channel the server does not draw
 * for, or without `channels`.
 */
export async function describeChannelComponents(
  catalog: Catalog,
  components: readonly (ChannelComponentInput & { partial?: boolean })[],
  channel: ResolvedGenuiChannel,
  limits?: ChannelChoiceLimits,
): Promise<string | undefined> {
  if (!channel.configured || !channel.messaging) return undefined;
  const messages: ChannelRenderedMessage[] = [];
  for (const component of components) {
    if (component.partial === true) continue;
    messages.push(...(await renderChannelMessages(catalog, component, channel)));
  }
  return components.length === 0 ? undefined : describeChannelDelivery(messages, channel, limits);
}
