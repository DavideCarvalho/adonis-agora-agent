import type { Actor } from '../types.js';
/** Resolves current server authority; persisted role snapshots are never execution authority. */
export interface BackgroundActorResolver {
  resolve(ref: { actorRef: string; tenantRef: string | null }): Promise<Actor | null>;
}
