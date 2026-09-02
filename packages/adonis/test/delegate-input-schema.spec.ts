import { describe, expect, it } from 'vitest';
import { registerDelegateTools } from '../src/agent-deps-factory.js';

/** O schema que a ferramenta de delegação publica, como o SDK o veria. */
function delegateSpec() {
  const registered: Array<{
    inputSchema: {
      '~standard': {
        validate: (v: unknown) => unknown;
        jsonSchema?: { input?: () => unknown };
      };
    };
  }> = [];
  const registry = {
    has: () => false,
    register: (spec: (typeof registered)[number]) => void registered.push(spec),
  };
  const agents = {
    list: () => [{ name: 'coordenador', delegatesTo: [{ agent: 'revisor', ability: 'x' }] }],
    get: () => ({ name: 'revisor', systemPrompt: 'especialista' }),
  };

  registerDelegateTools(registry as never, agents as never);
  const spec = registered[0];
  if (spec === undefined) throw new Error('nenhuma ferramenta de delegação registrada');
  return spec;
}

/**
 * O modelo só enxerga os parâmetros de uma ferramenta se o schema souber virar JSON
 * Schema. O bridge do SDK deriva isso de um Zod OU da extensão Standard JSON Schema;
 * qualquer outra coisa vira `{ properties: {} }` -- ou seja, "esta ferramenta não tem
 * argumentos".
 *
 * Sem a extensão, o laço era imperdível para o modelo: ele via uma ferramenta sem
 * parâmetros, mandava `{}` (corretamente, dado o que lhe disseram) e a chamada era
 * recusada contra um `validate` que exige `{ task: string }`. Uma instalação real
 * mostrou quatro ferramentas de delegação com 121 chamadas e 121 falhas cada — 100%,
 * queimando a cota diária inteira do usuário em retentativas de algo que ele não
 * tinha como acertar.
 */
describe('delegateInputSchema — o modelo precisa VER o parâmetro', () => {
  it('publica a extensão Standard JSON Schema', () => {
    const converter = delegateSpec().inputSchema['~standard'].jsonSchema;
    expect(typeof converter?.input).toBe('function');
  });

  it('declara `task` como obrigatório', () => {
    const schema = delegateSpec().inputSchema['~standard'].jsonSchema?.input?.() as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties.task).toBeDefined();
    expect(schema.required).toContain('task');
  });

  it('o validate segue sendo a autoridade e continua recusando `{}`', () => {
    // O JSON Schema é o que o modelo lê; o validate é o que decide de fato.
    const validate = delegateSpec().inputSchema['~standard'].validate;
    expect(validate({})).toHaveProperty('issues');
    expect(validate({ task: 'analisar o trecho' })).toEqual({
      value: { task: 'analisar o trecho' },
    });
  });
});
