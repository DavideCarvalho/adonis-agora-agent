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
