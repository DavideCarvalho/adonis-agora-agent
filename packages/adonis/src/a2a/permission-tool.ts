import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ToolRegistry } from '../tool-registry.js';

/** The role every A2A caller carries — what a tool names to be reachable by personal agents at all. */
export const PERSONAL_AGENT_ROLE = 'personal_agent';

export const REQUEST_PERMISSION_TOOL = 'request_permission';

/** The component the tool pushes into the stream; the A2A turn reads it back as a step-up. */
export const PERMISSION_COMPONENT = 'a2a.permission';

interface RequestPermissionInput {
  scopes: string[];
}

function inputSchema(scopeIds: string[]): StandardSchemaV1<unknown, RequestPermissionInput> {
  const known = new Set(scopeIds);
  return {
    '~standard': {
      version: 1,
      vendor: 'adonis-agora-agent',
      validate: (value: unknown) => {
        const scopes = (value as { scopes?: unknown } | null)?.scopes;
        if (!Array.isArray(scopes) || scopes.length === 0) {
          return { issues: [{ message: 'must be a non-empty array', path: ['scopes'] }] };
        }
        const unknownScope = scopes.find((id) => typeof id !== 'string' || !known.has(id));
        if (unknownScope !== undefined) {
          return {
            issues: [{ message: `unknown scope ${String(unknownScope)}`, path: ['scopes'] }],
          };
        }
        return { value: { scopes: [...new Set(scopes as string[])] } };
      },
      jsonSchema: {
        input: () => ({
          type: 'object',
          properties: {
            scopes: {
              type: 'array',
              items: { type: 'string', enum: scopeIds },
              minItems: 1,
              description: 'The permissions this request needs and the user has not granted yet.',
            },
          },
          required: ['scopes'],
          additionalProperties: false,
        }),
      },
    },
  } as StandardSchemaV1<unknown, RequestPermissionInput>;
}

/**
 * Register `request_permission`: the tool a personal agent's turn calls when what it was asked to do
 * needs a permission the user has not delegated. It pushes the requested scopes into the stream and
 * ENDS the turn; the A2A handler answers with a step-up task (PACT §5.5) carrying a consent link for
 * exactly those scopes. The conversation stays open — the agent re-sends once the user approves.
 *
 * Only personal agents reach it ({@link PERSONAL_AGENT_ROLE}), and only scopes the deployment
 * offers can be asked for.
 */
export function registerRequestPermissionTool(
  registry: ToolRegistry,
  scopes: Record<string, string>,
): void {
  const ids = Object.keys(scopes);
  const catalog = ids.map((id) => `- ${id}: ${scopes[id]}`).join('\n');
  registry.register(
    {
      name: REQUEST_PERMISSION_TOOL,
      kind: 'read',
      terminal: true,
      roles: [PERSONAL_AGENT_ROLE],
      description: `Ask the user to grant permissions you do not have yet. Call it when the request needs one of these and it is not among your current permissions — the user approves on their own account page and you continue afterwards:\n${catalog}`,
      inputSchema: inputSchema(ids),
    },
    {
      async execute(input, ctx) {
        const { scopes: requested } = input as RequestPermissionInput;
        await ctx.emitComponent?.(PERMISSION_COMPONENT, { scopes: requested });
        return { requested, status: 'awaiting_user_approval' };
      },
    },
  );
}
