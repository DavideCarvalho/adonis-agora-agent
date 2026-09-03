import { describe, expect, it } from 'vitest';
import {
  type CurrentModelPrice,
  modelPriceCandidates,
  resolveModelPrice,
} from '../src/spi/pricing-store.js';

/**
 * O ledger guarda o que o PROVIDER responde; a tabela de preço guarda o que o OPERADOR digitou.
 * A OpenAI responde um pedido de `gpt-4o-mini` com `gpt-4o-mini-2024-07-18`, e toda tabela de
 * preço publicada (e todo exemplo desta doc) usa o alias. Casados por igualdade crua, os dois nunca
 * se encontram: o fold erra e o dashboard imprime `$0.00` ao lado de um consumo real de tokens.
 *
 * O que estes testes prendem é a LINHA da resolução — o que ela aceita e, principalmente, o que ela
 * se recusa a aceitar. Precificar errado em silêncio é pior do que não precificar.
 */
function price(modelId: string): CurrentModelPrice {
  return {
    modelId,
    inputPricePer1m: 0.15,
    outputPricePer1m: 0.6,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveModelPrice', () => {
  it('acha o preço do alias a partir do snapshot datado da OpenAI', () => {
    const pricing = new Map([['gpt-4o-mini', price('gpt-4o-mini')]]);
    expect(resolveModelPrice(pricing, 'gpt-4o-mini-2024-07-18')?.modelId).toBe('gpt-4o-mini');
  });

  it('acha o preço do alias a partir do snapshot compacto da Anthropic', () => {
    const pricing = new Map([['claude-3-5-sonnet', price('claude-3-5-sonnet')]]);
    expect(resolveModelPrice(pricing, 'claude-3-5-sonnet-20241022')?.modelId).toBe(
      'claude-3-5-sonnet',
    );
  });

  it('atravessa o prefixo de rota do gateway', () => {
    const pricing = new Map([['gpt-4o', price('gpt-4o')]]);
    expect(resolveModelPrice(pricing, 'openai/gpt-4o')?.modelId).toBe('gpt-4o');
  });

  it('atravessa rota E região do Bedrock', () => {
    const pricing = new Map([['claude-3-5-sonnet', price('claude-3-5-sonnet')]]);
    expect(
      resolveModelPrice(pricing, 'bedrock/us.anthropic.claude-3-5-sonnet-20241022')?.modelId,
    ).toBe('claude-3-5-sonnet');
  });

  it('o EXATO ganha do alias — quem precifica um snapshot de propósito mantém isso', () => {
    // O caso real: um snapshot antigo que ficou mais caro (ou mais barato) que o alias corrente.
    const pricing = new Map([
      ['gpt-4o-mini', price('gpt-4o-mini')],
      ['gpt-4o-mini-2024-07-18', { ...price('gpt-4o-mini-2024-07-18'), inputPricePer1m: 99 }],
    ]);
    const resolved = resolveModelPrice(pricing, 'gpt-4o-mini-2024-07-18');
    expect(resolved?.modelId).toBe('gpt-4o-mini-2024-07-18');
    expect(resolved?.inputPricePer1m).toBe(99);
  });

  it('NÃO casa modelos diferentes que só se parecem', () => {
    const pricing = new Map([['gpt-4o-mini', price('gpt-4o-mini')]]);
    // `gpt-4o` não é `gpt-4o-mini`, e nenhum prefixo comum pode fazer um virar o outro.
    expect(resolveModelPrice(pricing, 'gpt-4o')).toBeUndefined();
    expect(resolveModelPrice(pricing, 'some-other-model')).toBeUndefined();
  });

  it('NÃO descasca sufixo de versão — ele pode ser outro modelo, com outro preço', () => {
    // É a linha conservadora: `-002` pode ser uma revisão com preço próprio, `-2024-07-18` não.
    const pricing = new Map([['gemini-1.5-pro', price('gemini-1.5-pro')]]);
    expect(resolveModelPrice(pricing, 'gemini-1.5-pro-002')).toBeUndefined();
  });

  it('modelo sem preço nenhum continua indefinido, não zero', () => {
    expect(resolveModelPrice(new Map(), 'gpt-4o-mini')).toBeUndefined();
  });

  it('o id exato é sempre o primeiro candidato', () => {
    expect(modelPriceCandidates('gpt-4o-mini-2024-07-18')[0]).toBe('gpt-4o-mini-2024-07-18');
  });
});
