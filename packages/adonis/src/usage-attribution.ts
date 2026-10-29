import type { AgentRunInput } from './types.js';

/**
 * What an agent turn's usage rows say about themselves beyond tokens: the feature (`agent:<agent name>`,
 * or `agent` for a run that names none — what a cost-by-feature report groups agent spend under) and the actor's tenant.
 */
export function usageAttribution(input: Pick<AgentRunInput, 'agentName' | 'actor'>): {
  feature: string;
  tenantRef?: string;
} {
  const tenantRef = input.actor.tenantRef;
  return {
    feature: input.agentName === undefined ? 'agent' : `agent:${input.agentName}`,
    ...(typeof tenantRef === 'string' ? { tenantRef } : {}),
  };
}
