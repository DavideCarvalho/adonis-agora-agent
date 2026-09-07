---
'@adonis-agora/agent': patch
---

Corrige `AuthzActorResolver` para ler `userRef`/`tenantId` do `@agora/context` como MÉTODOS, não como valores — bug que derrubava com 401 toda rota do agente atrás de authz

`@adonis-agora/context@0.6.1` publica no slot global `Symbol.for('@agora/context:accessor')` um accessor cujos campos são funções (`packages/core/src/accessor.ts`): `{ traceId(), tenantId(), userRef(), get() }`. `packages/adonis/src/authz/agora-context.ts` declarava `userRef`/`tenantId` como propriedades diretas, e `AuthzActorResolver.resolve()` lia `accessor?.userRef` como VALOR — contra o accessor real, isso é a própria função, `ref.id` é sempre `undefined`, e o resolver caía no ramo fail-closed ("no authenticated identity in @agora/context") em toda chamada. `tenantId` errava do outro lado, mais silenciosamente: uma função é truthy, então o escopo passado ao authz virava `{ tenantId: <function> }`.

Isso passou despercebido porque o spec do resolver montava um dublê com `userRef`/`tenantId` como valor — a forma que o resolver assumia, não a que `@adonis-agora/context` produz. Um dublê que não respeita o contrato do original testa uma fantasia.

**O que muda:**

- `AgoraContextAccessor` (em `agora-context.ts`) agora tipa `tenantId`/`userRef` como métodos (`() => T | undefined`), espelhando o contrato real do accessor.
- Duas novas funções, `userRefFromContext()` e `tenantIdFromContext()`, chamam esses métodos com segurança: toleram o campo não ser uma função (accessor parcial/mockado) e toleram o método lançar (fora de um contexto ativo) — em qualquer um dos dois casos degradam para `undefined` em vez de propagar, mantendo a postura fail-closed do chamador (`AuthzActorResolver` nunca fabrica identidade).
- `AuthzActorResolver.resolve()` passa a usar essas duas funções em vez de ler `accessor.userRef`/`accessor.tenantId` como propriedade.
- Specs de `authz-actor-resolver.spec.ts` e `agora-context.spec.ts` reescritos para mockar o accessor na forma real (métodos), com casos novos cobrindo: método ausente, método que lança, e `userRef()`/`tenantId()` retornando `undefined` fora de um contexto ativo.

Não há mudança de assinatura pública — `AuthzActorResolverConfig`, `authzActorResolver()` e o formato do `Actor` resolvido continuam os mesmos. Consumidores que hoje contornam este bug manualmente (lendo o accessor tolerando as duas formas) podem remover o contorno depois de atualizar.
