import type { Segment, SegmentSource } from './types.js';

/**
 * Text slots of structured values (tool arguments, tool results): each slot is a piece of text to
 * scan plus a setter that writes the (redacted / restored) text back in place.
 */
export interface Slot {
  segment: Segment;
  set(text: string): void;
  /** The text lives inside a JSON document (tool-call arguments): restored values are escaped. */
  json?: boolean;
}

const MAX_SLOTS = 2_000;

/** String leaves of a JSON value (tool arguments, structured results). */
export function jsonSlots(
  root: unknown,
  source: SegmentSource,
  fresh: boolean,
  replaceRoot?: (v: string) => void,
): Slot[] {
  const out: Slot[] = [];
  const walk = (value: unknown, set: (v: string) => void, depth: number) => {
    if (out.length >= MAX_SLOTS || depth > 10) return;
    if (typeof value === 'string') {
      if (value) out.push({ segment: { text: value, source, fresh }, set });
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(
          value[i],
          (t) => {
            value[i] = t;
          },
          depth + 1,
        );
      }
      return;
    }
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      for (const k of Object.keys(o))
        walk(
          o[k],
          (t) => {
            o[k] = t;
          },
          depth + 1,
        );
    }
  };
  walk(root, replaceRoot ?? (() => undefined), 0);
  return out;
}
