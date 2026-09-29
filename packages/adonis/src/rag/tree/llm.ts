import type { ModelProvider } from '../../spi/model-provider.js';
import type { SinkWriter } from '../../spi/token-stream-sink.js';
import { errorMessageOf, HttpModelError } from '../openai-embeddings.js';

/**
 * The structured side of every tree-LLM request: what is being asked, as data. The prompt says the
 * same thing in prose; `task` exists so a deterministic fake (tests, offline dev — see
 * {@link import('./keyword-tree-llm.js').keywordTreeLlm}) can answer without parsing prose, and so a
 * host can log or route requests by kind.
 */
export type TreeLlmTask =
  | {
      kind: 'structure';
      /** The window of pages the LLM is asked to find section starts in. */
      units: { unit: number; page?: number; text: string }[];
    }
  | { kind: 'summarize'; title: string; text: string }
  | { kind: 'describe'; title?: string; outline: { title: string; summary?: string }[] }
  | {
      kind: 'navigate';
      query: string;
      /** `single-pass`: the whole tree is shown; `beam`: one level of candidates at a time. */
      mode: 'single-pass' | 'beam';
      candidates: TreeLlmCandidate[];
      /** Max nodes the answer may name. */
      maxNodes: number;
    }
  | {
      kind: 'select';
      query: string;
      documents: { id: string; title?: string; description?: string }[];
      maxDocuments: number;
    };

/** A node as shown to the navigating LLM. */
export interface TreeLlmCandidate {
  id: string;
  title: string;
  summary?: string;
  pages?: string;
  /** Present on beam candidates: whether the node can be expanded. */
  hasChildren?: boolean;
  /** Present in single-pass mode: depth (0 = top level). */
  depth?: number;
}

export interface TreeLlmRequest {
  task: TreeLlmTask;
  system: string;
  prompt: string;
  /** A cap for the reply. Adapters pass it as `max_tokens` when they can. */
  maxOutputTokens: number;
  /** Aborted when the call's timeout or the build/navigation deadline passes. */
  signal: AbortSignal;
}

export interface TreeLlmResponse {
  text: string;
  /** Provider-reported usage. When absent, the budget estimates ~4 characters per token. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * The only LLM surface tree building and navigation need: one prompt in, one text reply out. Replies
 * are expected to be JSON (for structure / navigate / select) or plain text (summaries); parsing is
 * lenient (code fences, prose around the object). Bring any model:
 * {@link treeLlmFromModelProvider} (the agent's own `ModelProvider`), {@link openAiChatTreeLlm}
 * (any OpenAI-compatible `/chat/completions`), or a function of your own. Use a deterministic
 * setting (temperature 0) — trees are cached by content, so a flaky model makes rebuilds noisy.
 */
export type TreeLlm = (request: TreeLlmRequest) => Promise<TreeLlmResponse>;

/**
 * Hard limits for one document build or one navigation. Every LLM call is checked against them
 * **before** it is made (with the prompt's estimated size), so a budget is never overshot by more
 * than one reply, and nothing retries past it: the failure mode this exists for is an indexer that
 * burned ~1,240 calls on one PDF it could not structure.
 */
export interface TreeBudget {
  /** Max LLM calls. */
  maxCalls?: number;
  /** Max input (prompt) tokens across all calls, estimated at ~4 chars/token before each call. */
  maxInputTokens?: number;
  /** Max output tokens across all calls. */
  maxOutputTokens?: number;
  /** Wall-clock deadline for the whole operation, ms. */
  timeoutMs?: number;
  /** Per-call timeout, ms. Default: whatever is left of `timeoutMs`. */
  callTimeoutMs?: number;
}

/** Thrown internally when a budget or deadline would be exceeded; callers turn it into a fallback. */
export class TreeBudgetExceededError extends Error {
  constructor(readonly limit: 'calls' | 'inputTokens' | 'outputTokens' | 'timeout') {
    super(`tree LLM budget exhausted (${limit})`);
    this.name = 'TreeBudgetExceededError';
  }
}

/** ~4 characters per token: the budget's estimate when a provider reports no usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Tracks spend against a {@link TreeBudget} and runs calls under it. Not exported from the package. */
export class BudgetedLlm {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  exhausted = false;
  private readonly deadline: number;

  constructor(
    private readonly llm: TreeLlm,
    private readonly budget: Required<
      Pick<TreeBudget, 'maxCalls' | 'maxInputTokens' | 'maxOutputTokens'>
    > &
      TreeBudget,
    private readonly outerSignal?: AbortSignal,
  ) {
    this.deadline =
      budget.timeoutMs !== undefined ? Date.now() + budget.timeoutMs : Number.POSITIVE_INFINITY;
  }

  /** Time left before the deadline, ms (`Infinity` without one). */
  remainingMs(): number {
    return this.deadline - Date.now();
  }

  /** Would a call with this prompt fit? Does not reserve anything; a `false` marks the budget exhausted. */
  fits(prompt: string, maxOutputTokens: number): boolean {
    const fits = this.limitHit(prompt, maxOutputTokens) === undefined;
    if (!fits) {
      this.exhausted = true;
    }
    return fits;
  }

  private limitHit(
    prompt: string,
    maxOutputTokens: number,
  ): TreeBudgetExceededError['limit'] | undefined {
    if (this.calls >= this.budget.maxCalls) {
      return 'calls';
    }
    if (this.inputTokens + estimateTokens(prompt) > this.budget.maxInputTokens) {
      return 'inputTokens';
    }
    // A reply may be shorter than its cap; only refuse when nothing at all is left.
    if (this.outputTokens + Math.min(maxOutputTokens, 16) > this.budget.maxOutputTokens) {
      return 'outputTokens';
    }
    if (this.remainingMs() <= 0 || this.outerSignal?.aborted) {
      return 'timeout';
    }
    return undefined;
  }

  /**
   * Make one call, or throw {@link TreeBudgetExceededError} without calling. Provider errors
   * propagate (after being counted). Never retries.
   */
  async call(
    task: TreeLlmTask,
    system: string,
    prompt: string,
    maxOutputTokens: number,
  ): Promise<string> {
    const limit = this.limitHit(system + prompt, maxOutputTokens);
    if (limit !== undefined) {
      this.exhausted = true;
      throw new TreeBudgetExceededError(limit);
    }
    const outputCap = Math.max(
      16,
      Math.min(maxOutputTokens, this.budget.maxOutputTokens - this.outputTokens),
    );
    const timeoutMs = Math.min(
      this.budget.callTimeoutMs ?? Number.POSITIVE_INFINITY,
      this.remainingMs(),
    );
    // Reserve the estimate now so concurrent calls cannot all pass the check on the same headroom;
    // it is corrected to the reported usage when the reply arrives.
    const reservedInput = estimateTokens(system + prompt);
    this.inputTokens += reservedInput;
    this.outputTokens += outputCap;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(this.outerSignal?.reason);
    this.outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.calls += 1;
    try {
      const response = await Promise.race([
        this.llm({ task, system, prompt, maxOutputTokens: outputCap, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          if (Number.isFinite(timeoutMs)) {
            timer = setTimeout(
              () => {
                controller.abort(new TreeBudgetExceededError('timeout'));
                reject(new TreeBudgetExceededError('timeout'));
              },
              Math.max(0, timeoutMs),
            );
          }
        }),
      ]);
      this.inputTokens += (response.usage?.inputTokens ?? reservedInput) - reservedInput;
      this.outputTokens +=
        (response.usage?.outputTokens ?? estimateTokens(response.text)) - outputCap;
      return response.text;
    } catch (error) {
      // A failed call keeps its input estimate (the provider may have billed it) but no output.
      this.outputTokens -= outputCap;
      if (error instanceof TreeBudgetExceededError) {
        this.exhausted = true;
      }
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/**
 * Pull the JSON object out of a model reply: bare, fenced in ```json, or surrounded by prose.
 * Returns `undefined` when there is none (never throws).
 */
export function parseJsonReply(text: string): Record<string, unknown> | undefined {
  const tryParse = (candidate: string): Record<string, unknown> | undefined => {
    try {
      const value = JSON.parse(candidate) as unknown;
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) {
    return direct;
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    const inner = tryParse(fenced[1].trim());
    if (inner !== undefined) {
      return inner;
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return tryParse(trimmed.slice(start, end + 1));
  }
  return undefined;
}

/** The strings in a JSON array value (numbers stringified); anything else yields `[]`. */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'number' ? String(item) : item))
    .filter((item): item is string => typeof item === 'string');
}

const NOOP_SINK: SinkWriter = {
  write() {},
  end() {},
};

/**
 * A {@link TreeLlm} over the agent's own {@link ModelProvider}: one `runTurn` with no tools and a
 * discarding sink. Usage comes from the provider's report.
 */
export function treeLlmFromModelProvider(provider: ModelProvider): TreeLlm {
  return async (request) => {
    const result = await provider.runTurn({
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
      tools: [],
      sink: NOOP_SINK,
      abortSignal: request.signal,
    });
    return {
      text: result.text,
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    };
  };
}

export interface OpenAiChatTreeLlmOptions {
  model: string;
  /** Base URL up to and including `/v1`. Default `https://api.openai.com/v1`. */
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Default 0 — trees are cached by content, determinism keeps rebuilds quiet. */
  temperature?: number;
  /**
   * Send `response_format: { type: 'json_object' }` on JSON tasks. Default `false`: not every
   * OpenAI-compatible server accepts it, and replies are parsed leniently anyway.
   */
  jsonMode?: boolean;
  /** Extra body fields (a reasoning switch, provider routing). */
  body?: Record<string, unknown>;
  fetch?: typeof fetch;
}

/**
 * A {@link TreeLlm} over any OpenAI-compatible `POST /v1/chat/completions` — OpenAI, a gateway,
 * vLLM, Ollama, DeepSeek, Qwen… — with no SDK dependency. Throws `HttpModelError` on a non-2xx.
 */
export function openAiChatTreeLlm(options: OpenAiChatTreeLlmOptions): TreeLlm {
  const url = `${(options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
  const doFetch = options.fetch ?? fetch;
  return async (request) => {
    const json = request.task.kind !== 'summarize';
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...options.headers,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
        temperature: options.temperature ?? 0,
        max_tokens: request.maxOutputTokens,
        ...(options.jsonMode && json ? { response_format: { type: 'json_object' } } : {}),
        ...options.body,
      }),
      signal: request.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new HttpModelError(
        response.status,
        `Chat completion failed (${response.status}): ${errorMessageOf(body)}`,
      );
    }
    const parsed = parseJsonReply(body) as
      | {
          choices?: { message?: { content?: unknown } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        }
      | undefined;
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new HttpModelError(502, 'Chat completion returned no message content');
    }
    const usage: NonNullable<TreeLlmResponse['usage']> = {};
    if (typeof parsed?.usage?.prompt_tokens === 'number') {
      usage.inputTokens = parsed.usage.prompt_tokens;
    }
    if (typeof parsed?.usage?.completion_tokens === 'number') {
      usage.outputTokens = parsed.usage.completion_tokens;
    }
    return { text: content, usage };
  };
}

/** A get/set cache — a `Map`, an LRU, a Redis wrapper. Values are whole replies. */
export interface TreeLlmCache {
  get(key: string): TreeLlmResponse | undefined | Promise<TreeLlmResponse | undefined>;
  set(key: string, value: TreeLlmResponse): unknown;
}

/**
 * Memoize a {@link TreeLlm} by the exact request (task kind, system prompt, prompt, output cap).
 * With a deterministic model that makes a rebuild of an unchanged section, or a repeated question,
 * free. Cached replies report zero usage, so they cost nothing against a budget but a call slot.
 */
export function cachedTreeLlm(llm: TreeLlm, cache: TreeLlmCache = new Map()): TreeLlm {
  return async (request) => {
    const key = stableHash(
      `${request.task.kind}\u0000${request.maxOutputTokens}\u0000${request.system}\u0000${request.prompt}`,
    );
    const hit = await cache.get(key);
    if (hit !== undefined) {
      return { text: hit.text, usage: { inputTokens: 0, outputTokens: 0 } };
    }
    const response = await llm(request);
    await cache.set(key, response);
    return response;
  };
}

/**
 * A fast, deterministic, non-cryptographic 64-bit hash (two independent 32-bit FNV-1a/murmur-mixed
 * lanes) as 16 hex chars — content fingerprints and cache keys, not security.
 */
export function stableHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 13;
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
  h2 = Math.imul(h2 ^ (h2 >>> 15), 0xc2b2ae35);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
