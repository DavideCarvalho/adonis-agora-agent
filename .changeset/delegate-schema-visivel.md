---
'@adonis-agora/agent': patch
---

As ferramentas de delegação (`ask_<agente>`) falhavam 100% das vezes.

O `delegateInputSchema` é um Standard Schema escrito à mão, sem a extensão
`jsonSchema`. O bridge do SDK só deriva a forma dos parâmetros de um Zod ou dessa
extensão — qualquer outra coisa degrada para `{ type: 'object', properties: {} }`, que
diz ao modelo que **a ferramenta não tem argumentos**.

O laço era imperdível: o modelo via uma ferramenta sem parâmetros, mandava `{}`
(corretamente, dado o que lhe informaram) e a chamada era recusada contra um `validate`
que exige `{ task: string }`. Numa instalação real, quatro ferramentas de delegação com
**121 chamadas e 121 falhas cada** — queimando a cota diária inteira do usuário em
retentativas de algo que ele não tinha como acertar. O `QuotaExceededError` que aparecia
no fim era a consequência, não a causa.

Agora o schema publica `jsonSchema.input` com `task` obrigatório. O `validate` segue sendo
a autoridade; a extensão é o mesmo contrato na única forma que o modelo enxerga.
