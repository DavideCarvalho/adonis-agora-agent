import type { Actor } from '../types.js';
import type { ModelProvider, ModelTurnArgs } from './model-provider.js';

/** One model a caller may pick. */
export interface ModelCatalogEntry {
  /** What a client sends as `model` — and what the {@link ModelProvider} receives as `args.model`. */
  id: string;
  label: string;
  description?: string;
  /** Short tags a picker can render as chips — `'fast'`, `'reasoning'`, `'vision'`, `'new'`, … */
  badges?: string[];
  /** `false` → listed but not selectable right now (plan, quota, outage); a send naming it is refused. */
  available: boolean;
  /** Why it is unavailable, in words a picker can show. */
  unavailableReason?: string;
  /** Context window, in tokens, when the host knows it. */
  contextWindow?: number;
}

/** Models grouped under the provider that serves them. */
export interface ModelCatalogProviderGroup {
  id: string;
  label: string;
  models: ModelCatalogEntry[];
}

/** The agent always runs on one model: the picker shows it and offers no choice. */
export interface ModelCatalogLock {
  /** The catalog id every turn runs on. */
  model: string;
  /** Why, in words a picker can show ("This assistant always uses GPT-5"). */
  reason?: string;
}

/** What `GET <base>/models` answers. */
export interface ModelCatalogView {
  providers: ModelCatalogProviderGroup[];
  /**
   * Present when the agent is locked to one model. Every turn runs on `locked.model` — a send's own
   * `model` and a thread's pin included — and a send naming another model is refused (`400`). List
   * the other models as unavailable too, so an older client that ignores the lock cannot pick them.
   */
  locked?: ModelCatalogLock;
  /** The model a turn runs on when nobody picked one; `null` when the provider decides. */
  default: string | null;
}

export interface ModelCatalogQuery {
  actor: Actor;
  /** The agent the picker is for; omitted → the default agent. */
  agent?: string;
  /** The persona the picker is for, when the caller named one (`GET <path>/models?persona=`). */
  persona?: string;
}

/**
 * Which models a caller may run a turn on — the picker's data and the send's gate. The server
 * refuses a `model` (on a send, or pinned on a thread) that this does not list as `available` for
 * the actor and agent, so a client cannot pick a model the host did not offer it.
 *
 * Bind with `models` in `config/agent.ts` — a `ModelCatalog`, or a fixed `ModelCatalogView` for
 * {@link staticModelCatalog}. Without one, `GET <path>/models` answers an empty catalog and a request
 * naming a model is refused. The shape is `@dudousxd/nestjs-agent-core`'s, copied.
 */
export interface ModelCatalog {
  list(query: ModelCatalogQuery): ModelCatalogView | Promise<ModelCatalogView>;
}

/** The fixed view behind each catalog {@link staticModelCatalog} built — what boot validation reads. */
const staticViews = new WeakMap<ModelCatalog, ModelCatalogView>();

/** A catalog that answers the same view to everyone — for a fixed list of models. */
export function staticModelCatalog(view: ModelCatalogView): ModelCatalog {
  const catalog: ModelCatalog = { list: () => view };
  staticViews.set(catalog, view);
  return catalog;
}

/**
 * The view a catalog answers everyone, when it is a fixed one ({@link staticModelCatalog}, a
 * `ModelCatalogView` in `config/agent.ts`, `aiSdkModels().catalog`); `undefined` for a catalog that
 * decides per caller, which can only be checked turn by turn.
 */
export function staticCatalogView(catalog: ModelCatalog | undefined): ModelCatalogView | undefined {
  return catalog === undefined ? undefined : staticViews.get(catalog);
}

/** Every model id `view` lists, available or not. */
export function catalogModelIds(view: ModelCatalogView): string[] {
  return view.providers.flatMap((group) => group.models.map((model) => model.id));
}

/** Accept a catalog or a fixed view (the `config/agent.ts` shorthand). */
export function toModelCatalog(value: ModelCatalog | ModelCatalogView): ModelCatalog {
  return typeof (value as ModelCatalog).list === 'function'
    ? (value as ModelCatalog)
    : staticModelCatalog(value as ModelCatalogView);
}

/** The entry `id` names in `view`, or `undefined`. */
export function findCatalogModel(
  view: ModelCatalogView,
  id: string,
): ModelCatalogEntry | undefined {
  for (const group of view.providers) {
    const found = group.models.find((model) => model.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * `model` when `view` offers it as available, else a {@link ModelNotAllowedError} naming why.
 * `subject` names who chose it in the message (`model "x"` for a caller's pick, `agent "a" runs on
 * model "x"` for a configured one).
 */
export function assertCatalogModel(
  view: ModelCatalogView,
  model: string,
  subject = `model "${model}"`,
): string {
  const entry = findCatalogModel(view, model);
  if (entry === undefined) {
    throw new ModelNotAllowedError(`${subject} is not offered`);
  }
  if (!entry.available) {
    throw new ModelNotAllowedError(
      `${subject} is not available${entry.unavailableReason ? `: ${entry.unavailableReason}` : ''}`,
    );
  }
  return entry.id;
}

/** Where a turn's configured model came from — an agent's `model`, or one of its personas'. */
export interface ConfiguredModel {
  model: string;
  agent: string;
  /** Set when the persona's own `model` is what applies. */
  persona?: string;
}

/** The words a refusal of a configured model uses for who configured it. */
function configuredSubject(configured: ConfiguredModel): string {
  return configured.persona !== undefined
    ? `persona "${configured.persona}" of agent "${configured.agent}" runs on model "${configured.model}", which`
    : `agent "${configured.agent}" runs on model "${configured.model}", which`;
}

export interface TurnModelArgs {
  /** The configured catalog; `undefined` → none. */
  catalog: ModelCatalog | undefined;
  actor: Actor;
  /** The agent the turn runs as (a persona alias already resolved to its agent). */
  agent: string;
  /** The send's own `model`, for this turn only. */
  requested?: string;
  /** The thread's pinned model — read only when the send names none. */
  pinned?: () => Promise<string | null | undefined>;
  /** The persona's `model`, else the agent's — see {@link ConfiguredModel}. */
  configured?: ConfiguredModel;
}

/**
 * The model a turn runs on: the send's own, else the thread's pinned one, else the persona's
 * configured `model`, else the agent's, else none (the provider's default — the catalog's
 * `default`). A catalog `locked` model wins over all of them, and a send naming another model is
 * refused.
 *
 * Every choice passes the catalog gate for this actor and agent ({@link ModelNotAllowedError},
 * answered `400 model_not_allowed`) — a configured model included: it is refused, not swapped for
 * another one, so a turn never quietly runs on a model nobody chose. Without a catalog a caller's
 * pick is refused, while a configured model goes to the provider as written (no catalog, nothing to
 * check it against).
 */
export async function resolveTurnModel(args: TurnModelArgs): Promise<string | undefined> {
  const { catalog, actor, agent, requested, configured } = args;
  const view = catalog === undefined ? undefined : await catalog.list({ actor, agent });
  const locked = view?.locked;
  if (locked !== undefined) {
    if (requested !== undefined && requested !== locked.model) {
      throw new ModelNotAllowedError(
        `model "${requested}" cannot be selected: ${locked.reason ?? `this agent always uses "${locked.model}"`}`,
      );
    }
    return locked.model;
  }
  const picked = requested ?? (await args.pinned?.()) ?? undefined;
  if (picked !== undefined) {
    if (view === undefined) {
      throw new ModelNotAllowedError(
        `model "${picked}" cannot be selected: no model catalog is configured (models in config/agent.ts)`,
      );
    }
    return assertCatalogModel(view, picked);
  }
  if (configured === undefined) {
    return undefined;
  }
  return view === undefined
    ? configured.model
    : assertCatalogModel(view, configured.model, configuredSubject(configured));
}

/**
 * A provider that runs every turn on `model` — what the loop wraps the bound provider in when a
 * turn has a selected model, so every call it makes (the answer, a structured-output pass, the
 * follow-up suggestions) goes to the same one. A provider that does not read `args.model` runs its
 * own default, unchanged.
 */
export function withSelectedModel(provider: ModelProvider, model: string): ModelProvider {
  return {
    runTurn: (args: ModelTurnArgs) => provider.runTurn({ ...args, model }),
  };
}

/**
 * A request named a model the catalog does not offer to this caller right now — or there is no
 * catalog to offer one. The routes answer `400` with its message.
 */
export class ModelNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelNotAllowedError';
  }
}
