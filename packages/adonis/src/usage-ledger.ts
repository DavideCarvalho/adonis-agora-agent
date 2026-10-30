import { publishAgentUsageRecorded } from './diagnostics.js';
import type { AgentStore, RecordUsageInput } from './spi/agent-store.js';

/**
 * Write one usage-ledger row and publish it as `agora:agent:usage.recorded` — the single path every
 * AI cost takes (the loop's model calls and `AgentService.recordUsage`), so a subscriber sees all of
 * it through one event. The loop calls this INSIDE a step body: a durable replay skips the body, so a
 * row is neither written nor published twice. Published only once the write succeeded.
 */
export async function recordUsageRow(store: AgentStore, input: RecordUsageInput): Promise<void> {
  await store.recordUsage(input);
  publishAgentUsageRecorded({
    actorRef: input.actorRef,
    feature: input.feature ?? 'agent',
    purpose: input.purpose,
    modelId: input.modelId,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: input.usage.cacheReadTokens }
      : {}),
    ...(input.usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: input.usage.cacheWriteTokens }
      : {}),
    ...(input.audioSeconds !== undefined ? { audioSeconds: input.audioSeconds } : {}),
    ...(input.characters !== undefined ? { characters: input.characters } : {}),
    ...(input.requests !== undefined ? { requests: input.requests } : {}),
    ...(input.costUsd !== undefined
      ? { costUsd: input.costUsd, costSource: input.costSource ?? 'provider' }
      : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.tenantRef !== undefined ? { tenantRef: input.tenantRef } : {}),
    ...(input.countsTowardsQuota === false ? { countsTowardsQuota: false as const } : {}),
  });
}
