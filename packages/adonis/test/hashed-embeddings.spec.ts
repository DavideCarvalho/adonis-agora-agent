import { describe, expect, it } from 'vitest';
import { embedCountingUsage } from '../src/index.js';
import { hashedEmbeddings } from '../src/testing/index.js';

const dot = (a: number[], b: number[]) =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

describe('hashedEmbeddings', () => {
  it('is deterministic, L2-normalized and as wide as asked', async () => {
    const [first] = await hashedEmbeddings(32).embed(['Solar panel warranty']);
    const [again] = await hashedEmbeddings(32).embed(['Solar panel warranty']);
    expect(first).toHaveLength(32);
    expect(first).toEqual(again);
    expect(Math.hypot(...first!)).toBeCloseTo(1);
  });

  it('keeps accented words whole, so they match themselves and not their ASCII fragments', async () => {
    const [query, same, fragment] = await hashedEmbeddings(256).embed([
      'coração',
      'meu coração',
      'meu cora',
    ]);
    expect(dot(query!, same!)).toBeGreaterThan(dot(query!, fragment!));
  });

  it('reports one token per word under a hashed-<n> model', async () => {
    const result = await embedCountingUsage(hashedEmbeddings(8), ['two words', 'três']);
    expect(result.usage).toEqual({ inputTokens: 3, modelId: 'hashed-8' });
  });
});
