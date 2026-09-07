---
'@adonis-agora/agent': patch
---

`facetValues`/`countChunks` param de enviar `exact: true` — a contagem exata era o hang que restou

Medido contra o corpus real de produção (572 mil pontos, índices keyword já provisionados): um `facet` **exato** custou **23,5s** no server; o mesmo facet no default aproximado, **0,05s** (470× mais rápido) e o total veio idêntico. Como a agregação de um painel faz um facet por campo × tipo (~10 chamadas), `exact: true` como default somava minutos de request — exatamente o sintoma do painel "carregando para sempre" que a capacidade veio curar.

Agora `exact` é **opt-in** nas duas capacidades ( `{ exact: true } ` quando a contagem exata for o objetivo — reconciliação, diff), e o default herda o default rápido do server. `removeWhere` mantém contagem exata de propósito: lá ela é a afirmação "quantos chunks este delete removeu", atada ao retorno da escrita, não um número de painel.
