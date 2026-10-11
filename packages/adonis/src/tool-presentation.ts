import type { ToolKind } from './types.js';

/*
 * A COPY of `@dudousxd/nestjs-agent-core/src/tool-presentation.ts`, field for field: `GET <path>/tools`
 * is read by that library's React package (`useToolCatalog`), so the shape is the contract.
 */

/**
 * How a person-facing surface talks about a tool WITHOUT ever naming it. Declared on the server,
 * beside the tool's input schema, because whoever changes the input is the one who has to re-word
 * the sentence that mentions it — and a client that shipped its own name-to-sentence map would go
 * stale the moment a tool was renamed. A tool name is an identifier, never copy.
 *
 * `running` / `done` (and `confirm.title`, `confirm.detail`, `result.text`) are templates:
 * `{dotted.path}` placeholders are filled from the call's INPUT (or, for `result`, its OUTPUT), so one
 * declaration covers every call the tool will ever receive and replays identically from history.
 * A placeholder with nothing behind it collapses along with the space before it.
 */
export interface ToolPresentation {
  /** Noun phrase, for counts and headings: "Database query", "Knowledge base". */
  label: string;
  /** Present progressive, while the call is in flight: "Reading {bucket}". */
  running: string;
  /** Settled, once the output is in: "Read {bucket}". */
  done: string;
  /** A key into the client's own glyph map (`database`, `search`, …). Unknown keys fall back to a generic glyph there. */
  icon?: string;
  /** One line naming what the tool reaches, for when the activity line is opened. */
  detail?: string;
  /** `destructive` earns the warning treatment on an approval prompt. */
  tone?: ToolPresentationTone;
  /** What a person is being asked to allow when an `action` call parks for approval. */
  confirm?: ToolConfirmation;
  /** How the call's OUTPUT reads as content. */
  result?: ToolResultView;
}

export type ToolPresentationTone = 'neutral' | 'destructive';

export interface ToolConfirmation {
  /** "Delete {count} files?" */
  title: string;
  /** The button: "Delete". */
  verb: string;
  /** A sentence under the title, when the title alone does not say what changes. */
  detail?: string;
  /**
   * The card's action is OPENING this link (a sign-in at another service, say), not a Confirm:
   * finishing there decides it. A text channel sends the card with the link and no buttons or
   * reply instructions; a screen shows the link as the card's main button.
   */
  link?: string;
}

/** A value read out of a tool's output by dotted path, with the words to put next to it. */
export interface ToolResultField {
  path: string;
  label: string;
  unit?: string;
}

/**
 * How a tool's output reads as content. Every variant names dotted paths into the output rather
 * than shapes, so a renderer never has to recognise which tool it is drawing: it receives
 * `{ view, output }` and draws it.
 */
export type ToolResultView =
  /** A row of labelled readings — one result, several facets. */
  | { kind: 'metrics'; fields: ToolResultField[] }
  /** `rows` is a path to an array; each column's `path` is read WITHIN a row. */
  | { kind: 'table'; columns: ToolResultField[]; rows: string; empty?: string }
  /** `lines` is a path to an array of strings, drawn as a log tail. */
  | { kind: 'log'; lines: string }
  /** One sentence, templated over the output. */
  | { kind: 'note'; text: string }
  /** The output is drawn somewhere else on the screen already (a pushed component, a side panel). */
  | { kind: 'elsewhere' };

/**
 * `GET <base>/tools?agent=*`: every tool the actor reaches through ANY agent, each once — for a
 * surface that shows several agents' conversations.
 */
export const ALL_AGENTS = '*';

/**
 * One tool as `GET <base>/tools` reports it: the tools THIS actor may be offered by the chosen agent,
 * with how each is spoken about. `presentation` is absent for a tool that declared none — a client
 * then narrates it generically rather than falling back to its name.
 */
export interface ToolCatalogEntry {
  /** The wire name tool parts carry (`tool-<name>`) — the key a client looks a call up by. */
  name: string;
  kind: ToolKind;
  presentation?: ToolPresentation;
}

/** Dotted-path read. `undefined` rather than a throw, so a template can outlive a field. */
export function readPresentationPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function renderPresentationValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(renderPresentationValue).filter(Boolean).join(', ');
  return '';
}

/**
 * Fill `{dotted.path}` placeholders from `context`. A placeholder with nothing behind it collapses
 * along with the whitespace in front of it, so "Reading {key}" degrades to "Reading" rather than
 * printing braces at a person; a filled one keeps the whitespace the author wrote ("({n} files)").
 * The one filler the server (approval prompts) and the React layer (activity lines) share.
 */
export function fillPresentationTemplate(template: string, context: unknown): string {
  return template
    .replace(/(\s*)\{([\w.]+)\}/g, (_match, space: string, path: string) => {
      const rendered = renderPresentationValue(readPresentationPath(context, path));
      return rendered === '' ? '' : `${space}${rendered}`;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * A tool's `confirm` templates filled from one call's input — the approval prompt a client shows
 * ("Refund order #1002?"), resolved on the server so every transport (native, AG-UI, A2UI, A2A)
 * carries the same words, not only a client that has the tool catalog.
 */
export function fillToolConfirmation(confirm: ToolConfirmation, input: unknown): ToolConfirmation {
  return {
    title: fillPresentationTemplate(confirm.title, input),
    verb: fillPresentationTemplate(confirm.verb, input),
    ...(confirm.detail !== undefined
      ? { detail: fillPresentationTemplate(confirm.detail, input) }
      : {}),
    ...(confirm.link !== undefined ? { link: confirm.link } : {}),
  };
}

/**
 * The approve button's words when a tool declared no `confirm.verb`. English, like every other
 * library default: a localized surface (a text channel's `texts.approve`) shows its own word
 * instead whenever a confirmation carries exactly this one.
 */
export const DEFAULT_CONFIRM_VERB = 'Approve';

/**
 * A tool identifier as words a person can read: `refund_order`, `refundOrder` and `refund-order`
 * all become "Refund order". For the rare surface that has nothing better — a tool's own
 * `presentation.label` (or its `confirm` templates) always wins, see {@link resolveToolConfirmation}.
 */
export function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.:/\s]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.length === 0 ? '' : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * The approval prompt for one call of `toolName`, as every adapter (native stream, AG-UI, A2UI,
 * text channels, OpenCode, A2A) shows it: the tool's `confirm` templates filled from `input` when it
 * declared them; otherwise "<label>?" from its `presentation.label`, else "<humanized name>?" with
 * {@link DEFAULT_CONFIRM_VERB} — never the raw identifier. The one place that fallback is worded.
 */
export function resolveToolConfirmation(
  toolName: string,
  input: unknown,
  presentation?: Partial<Pick<ToolPresentation, 'label' | 'confirm'>> | undefined,
): ToolConfirmation {
  const label = presentation?.label?.trim();
  const subject = label !== undefined && label !== '' ? label : humanizeToolName(toolName);
  const fallbackTitle = subject === '' ? `${DEFAULT_CONFIRM_VERB}?` : `${subject}?`;
  const declared = presentation?.confirm;
  if (declared === undefined) return { title: fallbackTitle, verb: DEFAULT_CONFIRM_VERB };
  const filled = fillToolConfirmation(declared, input);
  return {
    ...filled,
    title: filled.title === '' ? fallbackTitle : filled.title,
    verb: filled.verb === '' ? DEFAULT_CONFIRM_VERB : filled.verb,
  };
}
