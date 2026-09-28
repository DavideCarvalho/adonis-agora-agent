/**
 * Reversible tokenization for one request: each distinct sensitive value gets a stable placeholder
 * (`[EMAIL_1]`, `[CREDIT_CARD_2]`…) in order of first appearance, so a conversation re-sent turn
 * after turn maps to the same placeholders. The model only sees placeholders; `restore` puts the
 * values back into what the caller receives.
 *
 * Values stay in this object. {@link toJSON} / {@link fromJSON} exist for a caller that must carry a
 * vault across processes (a durable run resumed elsewhere); wherever that snapshot is stored holds
 * the raw values, so treat it like the data it came from.
 */
export class Vault {
  private readonly byValue = new Map<string, string>();
  private readonly byToken = new Map<string, { value: string; restorable: boolean }>();
  private readonly counters = new Map<string, number>();

  /**
   * Placeholder for `value` under `label` (e.g. `CREDIT_CARD`). Reversible placeholders look like
   * `[CREDIT_CARD_1]`; one-way ones (tool results, answers, rules with `restore: false`) like
   * `[REDACTED_CREDIT_CARD_1]`, so they can never be mistaken for a reversible one.
   */
  tokenFor(label: string, value: string, restorable: boolean): string {
    const ns = restorable ? label : `REDACTED_${label}`;
    const key = `${ns}\u0000${value}`;
    const existing = this.byValue.get(key);
    if (existing) return existing;
    const n = (this.counters.get(ns) ?? 0) + 1;
    this.counters.set(ns, n);
    const token = `[${ns}_${n}]`;
    this.byValue.set(key, token);
    this.byToken.set(token, { value, restorable });
    return token;
  }

  get size(): number {
    return this.byToken.size;
  }

  get restorableCount(): number {
    let n = 0;
    for (const e of this.byToken.values()) if (e.restorable) n++;
    return n;
  }

  /** Longest placeholder, for stream hold-back windows. */
  get maxTokenLength(): number {
    let n = 0;
    for (const t of this.byToken.keys()) n = Math.max(n, t.length);
    return n;
  }

  /** Puts restorable values back. `jsonString`: the text is inside a JSON string literal. */
  restore(text: string, jsonString = false): string {
    if (this.byToken.size === 0 || !text.includes('[')) return text;
    return text.replace(/\[([A-Z][A-Z0-9_]*_\d+)\]/g, (whole) => {
      const entry = this.byToken.get(whole);
      if (!entry?.restorable) return whole;
      return jsonString ? JSON.stringify(entry.value).slice(1, -1) : entry.value;
    });
  }

  /** Whether `text` ends with what could be the beginning of a placeholder (streaming). */
  pendingPrefix(text: string): number {
    const i = text.lastIndexOf('[');
    if (i === -1) return 0;
    const tail = text.slice(i);
    if (tail.length > this.maxTokenLength) return 0;
    return /^\[[A-Z0-9_]*$/.test(tail) ? tail.length : 0;
  }

  /** Every entry, in the order the placeholders were minted. */
  toJSON(): VaultSnapshot {
    return {
      entries: [...this.byToken].map(([token, e]) => ({
        token,
        value: e.value,
        restorable: e.restorable,
      })),
    };
  }

  /** Rebuilds a vault from {@link toJSON}; placeholders keep their numbers and counters resume. */
  static fromJSON(snapshot: VaultSnapshot): Vault {
    const vault = new Vault();
    for (const { token, value, restorable } of snapshot.entries) {
      const m = /^\[([A-Z][A-Z0-9_]*)_(\d+)\]$/.exec(token);
      if (!m) continue;
      const ns = m[1] ?? '';
      const n = Number(m[2]);
      vault.byValue.set(`${ns}\u0000${value}`, token);
      vault.byToken.set(token, { value, restorable });
      vault.counters.set(ns, Math.max(vault.counters.get(ns) ?? 0, n));
    }
    return vault;
  }
}

/** A serializable {@link Vault}. */
export interface VaultSnapshot {
  entries: Array<{ token: string; value: string; restorable: boolean }>;
}

/** `pii.credit_card` -> `CREDIT_CARD`, `secret.openai_key` -> `OPENAI_KEY`, `ner.person` -> `PERSON`. */
export function labelFor(category: string): string {
  const tail = category.includes('.') ? category.slice(category.indexOf('.') + 1) : category;
  const label = tail.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return label || 'REDACTED';
}
