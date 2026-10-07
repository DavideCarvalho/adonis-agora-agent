import type { RolesPolicy } from './spi/roles-policy.js';
import type {
  Actor,
  AgentDefinition,
  Persona,
  PersonaCatalogEntry,
  ToolSpec,
  TurnPersona,
} from './types.js';

/** First filter layer: drop tools the actor's role may not invoke. `can` may be async (authz). */
export async function filterToolsByRole(
  tools: ToolSpec[],
  actor: Actor,
  policy: RolesPolicy,
): Promise<ToolSpec[]> {
  const checked = await Promise.all(
    tools.map(async (tool) => ({
      tool,
      allowed: await (policy.canOffer ? policy.canOffer(actor, tool) : policy.can(actor, tool)),
    })),
  );
  return checked.filter((entry) => entry.allowed).map((entry) => entry.tool);
}

/** Second filter layer: if the persona pins an allow-list, keep only those tool names. */
export function personaFilterTools(
  tools: ToolSpec[],
  allowedTools: string[] | undefined,
): ToolSpec[] {
  if (allowedTools === undefined) {
    return tools;
  }
  const allowed = new Set(allowedTools);
  return tools.filter((tool) => allowed.has(tool.name));
}

/**
 * The narrower of two tool allow-lists. `undefined` is "no restriction", so it yields the other; two
 * lists yield the names on both, in the order of the first.
 */
export function intersectAllowLists(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] | undefined {
  if (first === undefined) {
    return second === undefined ? undefined : [...second];
  }
  if (second === undefined) {
    return [...first];
  }
  const allowed = new Set(second);
  return first.filter((name) => allowed.has(name));
}

/** The persona `id` of `definition`, or `undefined` when it declares none by that id. */
export function findPersona(
  definition: Pick<AgentDefinition, 'personas'> | undefined,
  id: string | undefined,
): Persona | undefined {
  if (id === undefined) {
    return undefined;
  }
  return definition?.personas?.find((persona) => persona.id === id);
}

/**
 * The persona an agent runs under when nothing names one: its `defaultPersona`, else the persona
 * whose id is `'default'` when it declares one. Undefined → none.
 */
export function defaultPersonaOf(
  definition: Pick<AgentDefinition, 'personas' | 'defaultPersona'> | undefined,
): string | undefined {
  if (definition?.defaultPersona !== undefined) {
    return definition.defaultPersona;
  }
  return findPersona(definition, 'default')?.id;
}

/** A persona as a picker reads it — never its prompt or its allow-list. */
export function personaCatalogEntry(persona: Persona): PersonaCatalogEntry {
  return {
    id: persona.id,
    label: persona.label,
    ...(persona.description !== undefined ? { description: persona.description } : {}),
  };
}

/** Where a former agent name now lives: an agent, and the persona of it the name stands for. */
export interface PersonaAlias {
  agent: string;
  persona: string;
}

/**
 * Resolve `name` through the {@link Persona.aliases} of `definitions`: the agent and persona that
 * answer for it, or `undefined` when no persona claims it. A name that IS a registered agent is never
 * an alias — the caller checks that first, so a real agent always wins.
 */
export function resolvePersonaAlias(
  definitions: readonly AgentDefinition[],
  name: string,
): PersonaAlias | undefined {
  for (const definition of definitions) {
    for (const persona of definition.personas ?? []) {
      if (persona.aliases?.includes(name) === true) {
        return { agent: definition.name, persona: persona.id };
      }
    }
  }
  return undefined;
}

/**
 * The persona as the turn's prompt builders and tools see it: the frozen definition, never the
 * config's — its prompt is the resolved text, so a reader of `ctx.persona.systemPrompt` sees what the
 * turn actually ran on.
 */
export function personaFromTurn(turn: TurnPersona): Persona {
  return {
    id: turn.id,
    label: turn.label,
    ...(turn.allowedTools !== undefined ? { allowedTools: [...turn.allowedTools] } : {}),
    ...(turn.prompt !== undefined ? { systemPrompt: turn.prompt } : {}),
  };
}

/**
 * A send named a persona its agent does not declare. The routes answer `400` with
 * `code: 'persona_not_found'` — before a thread or a run is created.
 */
export class PersonaNotFoundError extends Error {
  readonly status = 400 as const;
  readonly code = 'persona_not_found' as const;
  constructor(
    readonly agentName: string,
    readonly persona: string,
  ) {
    super(`agent "${agentName}" has no persona "${persona}"`);
    this.name = 'PersonaNotFoundError';
  }
}
