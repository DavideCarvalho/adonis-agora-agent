/**
 * The part of OpenCode 2's server API (`@opencode/client`, the v2 routes `/api/session`,
 * `/api/event`, …) this engine calls — structural, so the engine has no runtime dependency on the
 * client package and a test can hand it a fake. A real `@opencode/client` client (2.0.18) satisfies
 * it: `OpenCode.make({ baseUrl, headers })` from `@opencode/client` is what a host passes.
 */
export interface OpenCodeClient {
  session: {
    create(args: OpenCodeSessionCreate): Promise<{ id: string }>;
    prompt(args: {
      sessionID: string;
      text: string;
      files?: OpenCodePromptFile[];
    }): Promise<unknown>;
    /** Stops the running execution; OpenCode answers with `session.execution.interrupted`. */
    interrupt(args: { sessionID: string }): Promise<unknown>;
    instructions: {
      entry: {
        put(args: { sessionID: string; key: string; value: string }): Promise<unknown>;
      };
    };
    /** The session's info. Optional: finds the thread of a session (its `metadata.threadId`). */
    get?(args: { sessionID: string }): Promise<{
      id: string;
      metadata?: { readonly [key: string]: OpenCodeJson };
      /** What the session spent so far, every model call OpenCode made for it (the title too). */
      cost?: number;
      tokens?: OpenCodeTokens;
    }>;
    /** Resolves when the session goes idle. Optional: a safety net for a missed terminal event. */
    wait?(args: { sessionID: string }): Promise<unknown>;
    /** Rewind the session to before a message (regenerate). Optional. */
    revert?: {
      stage(args: { sessionID: string; messageID: string; files?: boolean }): Promise<unknown>;
      commit(args: { sessionID: string }): Promise<unknown>;
    };
    form: {
      /** The session's open forms. Optional: lets a resumed turn find questions asked while nobody listened. */
      list?(args: { sessionID: string }): Promise<OpenCodeForm[]>;
      reply(args: {
        sessionID: string;
        formID: string;
        answer: Record<string, OpenCodeFormValue>;
      }): Promise<unknown>;
      cancel(args: { sessionID: string; formID: string }): Promise<unknown>;
    };
  };
  permission: {
    /** The session's open permission requests. Optional, like `session.form.list`. */
    list?(args: { sessionID: string }): Promise<OpenCodePermissionRequest[]>;
    reply(args: {
      sessionID: string;
      requestID: string;
      decision: 'once' | 'reject';
      message?: string;
    }): Promise<unknown>;
  };
  /** The session's messages, newest first with `order: 'desc'`. Optional (regenerate). */
  message?: {
    list(args: {
      sessionID: string;
      order?: 'asc' | 'desc';
      limit?: number;
    }): Promise<{ data: Array<{ id: string; type: string }> }>;
  };
  /** Register an MCP server at a location. Optional (exposing the app's tools). */
  mcp?: {
    add(args: {
      server: string;
      location?: { directory: string };
      config: {
        type: 'remote';
        url: string;
        headers?: Record<string, string>;
        /** `false`: never start OAuth for this server (the headers authenticate it). */
        oauth?: false;
      };
    }): Promise<unknown>;
  };
  /** Write a file on the server. Optional (writing the agent's skills where OpenCode finds them). */
  file?: {
    write(args: {
      location?: { directory: string };
      path: string;
      payload: Uint8Array;
    }): Promise<unknown>;
  };
  event: {
    /** Every event of the server, for every session, until `signal` aborts. */
    subscribe(args: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent>;
  };
}

/** A file attached to a prompt: a URI OpenCode can read (`file://…`, `data:…`, `https://…`). */
export interface OpenCodePromptFile {
  uri: string;
  name?: string;
  description?: string;
}

/** A JSON value — what OpenCode stores as metadata. */
export type OpenCodeJson =
  | string
  | number
  | boolean
  | null
  | OpenCodeJson[]
  | { readonly [key: string]: OpenCodeJson };

export interface OpenCodeSessionCreate {
  /** A named OpenCode agent (`.opencode/agents/<name>`), when the location defines one. */
  agent?: string;
  model?: OpenCodeModelRef;
  location?: { directory: string };
  /** OpenCode permission rules (`{ action, resource, effect: 'allow' | 'deny' | 'ask' }`). */
  permissions?: OpenCodePermissionRule[];
  metadata?: { readonly [key: string]: OpenCodeJson };
}

export interface OpenCodeModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

/** What a form reply takes for one field. */
export type OpenCodeFormValue = string | number | boolean | string[];

/** One server event. `data.sessionID` (or `data.form.sessionID` on form events) names its session. */
export interface OpenCodeEvent {
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: OpenCode's event payloads are read defensively, field by field.
  data?: any;
}

/** A permission OpenCode is waiting on (`permission.asked`): an `ask` rule matched a tool call. */
export interface OpenCodePermissionRequest {
  id: string;
  sessionID: string;
  /** The rule's action, e.g. `company.send_email` or `webfetch`. */
  action: string;
  resources?: string[];
  /**
   * About the call. A built-in tool's arguments sit straight here (`webfetch` → `{ url, format }`);
   * calls that wrap others nest them under `input` or `args`.
   */
  metadata?: Record<string, unknown>;
}

/** A form the model put to the user through OpenCode's question tool (`form.created`). */
export interface OpenCodeForm {
  id: string;
  sessionID: string;
  title?: string;
  fields?: OpenCodeFormField[];
}

export interface OpenCodeFormField {
  key: string;
  type?: string;
  title?: string;
  description?: string;
  required?: boolean;
  options?: Array<{ value: string; label?: string; description?: string }>;
  /** The user may type their own answer instead of picking one of `options`. */
  custom?: boolean;
}

/** A token count as OpenCode reports it: `input` is the uncached input, the cache beside it. */
export interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning?: number;
  cache?: { read: number; write: number };
}
