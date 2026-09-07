---
'@adonis-agora/agent': minor
---

Alarga o peer `@adonisjs/redis` para aceitar `^11.0.0`

`@adonisjs/redis` era um peer opcional em `^9.2.0 || ^10.0.0`. O sink Redis (`tokenSinks.redis()`) nunca importou tipos do driver — ele resolve `redis` pelo container do Adonis e duck-tipa a conexão (`RedisManagerLike`/`IoRedisLike`), então não há superfície de tipos ou API própria deste pacote presa à versão do driver.

**Nota**: `@adonis-agora/durable` e `@adonis-agora/diagnostics` (peers próprios deste pacote, usados quando o durable/telescope estão habilitados) ainda declaram `^9.2.0 || ^10.0.0` nas suas versões publicadas atuais — um consumidor rodando `@adonisjs/redis@11` com esses dois habilitados verá um aviso de peer não satisfeito do gerenciador de pacotes até esses pacotes alargarem o próprio range. É só aviso; não é erro de instalação nem quebra em runtime.
