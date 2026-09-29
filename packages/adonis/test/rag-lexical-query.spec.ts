import { describe, expect, it } from 'vitest';
import { anyTermTsquery, hasSearchSyntax, keywordTerms } from '../src/rag/lexical-query.js';

describe('keywordTerms', () => {
  it("drops the stop words of the question's language", () => {
    expect(keywordTerms('Which clause of Part 52 governs the material and workmanship?')).toEqual([
      'clause',
      'part',
      '52',
      'governs',
      'material',
      'workmanship',
    ]);
    expect(keywordTerms('Qual é a política de férias da empresa?')).toEqual([
      'política',
      'férias',
      'empresa',
    ]);
    expect(keywordTerms('¿Cuál es el plazo para presentar las facturas?')).toEqual([
      'cuál',
      'plazo',
      'presentar',
      'facturas',
    ]);
  });

  it('keeps words that are stop words only in another language', () => {
    expect(keywordTerms('What is the sea level where her son lives?')).toEqual([
      'sea',
      'level',
      'son',
      'lives',
    ]);
    expect(keywordTerms('Qual o estado do contrato?')).toEqual(['estado', 'contrato']);
  });

  it('keeps a question made only of stop words, dedupes, caps, takes custom lists', () => {
    expect(keywordTerms('who are they')).toEqual(['who', 'are', 'they']);
    expect(keywordTerms('CMMC cmmc level Level')).toEqual(['cmmc', 'level']);
    expect(keywordTerms(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '), 24)).toHaveLength(
      24,
    );
    expect(
      keywordTerms('der Vertrag und die Frist', 24, { german: new Set(['der', 'und', 'die']) }),
    ).toEqual(['vertrag', 'frist']);
  });

  it('builds a safe any-term tsquery and spots explicit search syntax', () => {
    expect(anyTermTsquery(['a1', "o'neil"])).toBe("'a1' | 'oneil'");
    expect(hasSearchSyntax('"net income" 2023')).toBe(true);
    expect(hasSearchSyntax('revenue -forecast')).toBe(true);
    expect(hasSearchSyntax('x-ray-7 runbook')).toBe(false);
  });
});
