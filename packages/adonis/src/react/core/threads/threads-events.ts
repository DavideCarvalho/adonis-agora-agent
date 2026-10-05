import type { AgentBackend } from '../backend.js';

/**
 * What changed about a backend's thread list. `changed` → refetch (a thread was created, or a run
 * settled and the server wrote its title); `title` → the stream announced a title, patch in place.
 */
export type ThreadsEvent =
  | { type: 'changed' }
  | { type: 'title'; threadId: string; title: string }
  | { type: 'removed'; threadId: string };

type Listener = (event: ThreadsEvent) => void;

// Keyed by backend so two chats on two servers never refresh each other's sidebars.
const listeners = new WeakMap<AgentBackend, Set<Listener>>();

/** Tell every {@link useThreads} on `backend` that its list moved. */
export function notifyThreads(backend: AgentBackend, event: ThreadsEvent): void {
  for (const listener of listeners.get(backend) ?? []) {
    listener(event);
  }
}

/** Subscribe to {@link notifyThreads} for `backend`; returns the unsubscribe. */
export function onThreadsEvent(backend: AgentBackend, listener: Listener): () => void {
  let set = listeners.get(backend);
  if (set === undefined) {
    set = new Set();
    listeners.set(backend, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
