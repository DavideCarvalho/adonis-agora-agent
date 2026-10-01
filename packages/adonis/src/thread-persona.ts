import type { AgentStore } from './spi/agent-store.js';

/**
 * The thread's pinned persona: one column when the store projects it
 * (`AgentStore.personaForThread`), else through the full read. `null` → none pinned (or no thread).
 */
export async function threadPersona(store: AgentStore, threadId: string): Promise<string | null> {
  if (store.personaForThread !== undefined) {
    return store.personaForThread(threadId);
  }
  const persona = (await store.getThread(threadId))?.persona;
  return typeof persona === 'string' && persona.length > 0 ? persona : null;
}
