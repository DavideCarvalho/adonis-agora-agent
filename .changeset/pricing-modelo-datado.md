---
'@adonis-agora/agent': minor
---

O custo volta a aparecer quando o provider reporta um snapshot datado, e os preços podem vir do models.dev

O ledger guarda o modelo que o PROVIDER reporta e a tabela de preço guarda o que o OPERADOR digitou. A OpenAI responde um pedido de `gpt-4o-mini` com `gpt-4o-mini-2024-07-18`, e toda tabela de preço publicada — e todo exemplo desta doc — usa o alias. Casados por igualdade crua num `Map.get`, os dois nunca se encontravam: o fold errava nos DOIS lados (`agent-loop` gravando `costUsd: null`, e o read-model devolvendo `0`), e o dashboard imprimia `$0.00` ao lado de um consumo real de tokens.

Pior num deploy sem gateway: `agent_token_usage.cost_usd` só é preenchido a partir de custo reportado por gateway, então quem fala direto com a OpenAI não tinha nenhum valor persistido de reserva — o casamento em tempo de leitura era a resposta inteira, e ele falhava para zero.

`resolveModelPrice` resolve o id reportado até o alias: id exato primeiro, depois sem o prefixo de rota (`openai/`, `bedrock/us.anthropic.`), depois sem o sufixo de data (`-2024-07-18`, `-20241022`). Só sufixos com FORMA DE DATA são descascados — um `-002` pode ser outro modelo com outro preço, e precificar errado em silêncio é pior do que não precificar. O id exato sempre ganha, então quem precifica um snapshot de propósito mantém isso.

`seedPricesFromModelsDev(store, ['openai/gpt-4o-mini'])` preenche a tabela a partir do catálogo aberto do [models.dev](https://models.dev), em vez de números copiados à mão de uma tabela de preços. O prefixo `<provider>/` é obrigatório: o mesmo nome de modelo existe em provedores diferentes com preços diferentes, e adivinhar ali seria adivinhar uma conta. Modelo ausente do catálogo, ou sem preço publicado, é ERRO — nada é gravado se algum não resolveu, porque um seed parcial deixaria metade da conta certa e metade zerada.

Nenhuma mudança de comportamento para quem já casava exato.
