---
'@adonis-agora/agent': minor
---

Um turno lê a JANELA que ele vai mandar, não a transcrição da thread.

Um turno precisa das últimas mensagens, do título, e de saber se a thread já foi respondida alguma
vez. O `getThread` entregava a transcrição inteira — toda linha de mensagem, todo anexo e toda saída
de tool que a thread já gravou — e o `load:thread` então journalava o que carregou. Numa thread de 50
turnos em que cada turno rodou uma tool de 50 KB isso é ~2,6 MB lidos e gravados para mandar quatro
mensagens, 99% deles saída de tool que nenhuma chamada ao modelo ia ver. E o preço é pago de novo em
todo replay, porque o payload do checkpoint é relido e reparseado por todo processo que retoma o run.

Entra `ThreadTurnReader.loadThreadForTurn({ threadId, messageLimit })` no SPI, implementado pelo
`LucidAgentStore`: as `messageLimit` linhas mais novas, com o limite sendo o do BANCO
(`order by created_at desc limit ?`), projetadas nas colunas que um turno de modelo lê — `usage`,
`follow_ups` e `run_id` ficam na tabela.

**O probe é estrutural**, então um store que não oferece a janela continua respondendo pelo
`getThread`, com o mesmo limite aplicado em processo. E ele mora DENTRO do `load:thread`, não em
volta: não acrescenta posição nenhuma, e o payload gravado é idêntico nos dois caminhos — a escolha
de store de um deployment não pode decidir os checkpoints de um run. Nenhum marcador de patch,
nenhuma posição mexida.

**Dois tetos de propósito não nomeiam limite.** Um que RESUME, porque o `summarize` recebe o que o
`select` DESCARTOU: uma leitura limitada ao que o `select` guarda não descarta nada, e o turno
dobraria um resumo vazio dentro de um prompt que está sem as mensagens que ele substitui — calado.
E um teto que não é contagem de linhas, porque de um orçamento de tokens não sai contagem alguma: uma
mensagem pode custar quatro tokens ou quarenta mil. `HistoryWindow.maxMessages` é o campo que declara
o limite, e declarar é uma PROMESSA sobre o `select` — que ele guarda no máximo essa quantidade, e que
são as mais NOVAS.

**`hasAssistantMessage` é respondido sobre a thread INTEIRA, nunca sobre a página.** Ele decide um
intake `thread-start`, e uma janela que por acaso só tem as últimas perguntas do usuário pertence a
uma conversa que já foi respondida — lido da página, um thread longo se reapresentaria a cada turno.
