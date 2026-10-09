# Teste de carga

Diferencial opcional da seção 14. O objetivo não é bater um número de RPS, e sim ver **como o sistema se comporta sob carga**: onde a latência cresce, se aparecem erros ou conflitos, quanto o outbox atrasa e, principalmente, se **saldo e ledger continuam corretos** depois da carga.

## Como rodar

```bash
docker compose up --build -d --scale app=3   # 3 instâncias nas portas 3000, 3001 e 3002
bun run test:load
```

- O script fica em [test/load/run.ts](../test/load/run.ts). Ele imprime as tabelas abaixo em markdown e termina com código 1 se alguma wallet falhar na verificação final.
- Variáveis opcionais:
  - `LOAD_CONCURRENCY` (padrão 64): requisições em voo;
  - `LOAD_SCALE` (padrão 1): multiplica o número de requisições, para execuções mais longas;
  - `LOAD_HOT_CONCURRENCY` (padrão `8,64,256`): níveis do cenário de hot wallet;
  - `LOAD_BASE_URLS`: as instâncias.
- **Para repetir medições, recrie o emulador antes:** `docker compose restart sqs && bun run sqs:setup`. Motivo: na seção "Outbox" abaixo.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Apple M4, 10 núcleos, 16 GB, macOS 26.3 |
| Docker | Docker Desktop 29.1, VM com 10 CPUs e 8 GB |
| Aplicação | 3 instâncias (Bun 1.4.2), cada uma com HTTP, consumer, publisher e worker; configuração padrão (pool de 20 conexões, `lock_timeout` de 2s) |
| Banco | PostgreSQL 17 com configuração padrão, em volume Docker |
| Fila | MiniStack 1.5.22 (emulador de SQS) |
| Gerador de carga | script Bun, **na mesma máquina** |

## Metodologia

- **Modelo fechado:** o gerador mantém N requisições em voo e dispara uma nova quando outra termina. A vazão medida é o que o sistema sustenta com aquela concorrência.
- As requisições são distribuídas em **round-robin pelas 3 instâncias**. A latência é medida no cliente, então inclui HTTP e serialização.
- **Contadores do servidor** (processadas, replays, retries, conflitos de lock): diferença do `/metrics` antes e depois do cenário, **somada nas 3 instâncias**.
- **Outbox:** o gauge `outbox_lag_seconds` (idade do evento não publicado mais antigo) é amostrado a cada 250ms durante o cenário. O "drain" é o tempo, depois da última resposta, até a outbox esvaziar.
- **Verificação final de correção:** depois de cada cenário, o script chama `POST /wallets/:id/reconciliation` para **todas** as wallets usadas e exige duas coisas:
  - `consistent: true`, ou seja, saldo gravado igual ao saldo reconstruído pelo ledger;
  - **exatamente** o número esperado de lançamentos: 1 de abertura, mais 1 para cada resposta 201 que move saldo.
  - Débito duplicado ou perdido falha aqui.

| Cenário | O que exercita | Volume |
|---|---|---|
| wallets distintas | vazão sem disputa de lock; mistura BET, BET, WIN e LOSS | 100 wallets, 4.000 requisições, concorrência 64 |
| hot wallet | todas as requisições na **mesma** wallet (lock pessimista, D7) | 1 wallet, 1.000 BETs, concorrência 8, 64 e 256 |
| duplicatas (x5) | entrega at-least-once: cada transação enviada 5 vezes ao mesmo tempo, para instâncias diferentes | 50 wallets, 600 transações, 3.000 requisições |

## Resultados (execução de referência, emulador recém-criado)

| Cenário | Concorrência | Requisições | req/s | p50 ms | p95 ms | p99 ms | máx ms | Status | Erros (5xx ou rede) |
|---|---|---|---|---|---|---|---|---|---|
| wallets distintas | 64 | 4.000 | 1.237 | 43,9 | 112,3 | 138,4 | 168,0 | 201: 4.000 | 0% |
| hot wallet | 8 | 1.000 | 365 | 20,8 | 38,6 | 74,0 | 98,6 | 201: 1.000 | 0% |
| hot wallet | 64 | 1.000 | 325 | 152,8 | 570,2 | 751,6 | 1.135,9 | 201: 1.000 | 0% |
| hot wallet | 256 | 1.000 | 452 | 506,4 | 786,2 | 942,7 | 1.069,9 | 201: 1.000 | 0% |
| duplicatas (x5) | 64 | 3.000 | 1.730 | 33,3 | 73,4 | 95,5 | 126,6 | 201: 600, 200: 2.400 | 0% |

| Cenário | Processadas | Replays | Retries | Conflitos de lock | Outbox lag máx (s) | Outbox pendente máx | Drain (s) | Saldo == ledger |
|---|---|---|---|---|---|---|---|---|
| wallets distintas | 4.000 | 0 | 0 | 0 | 2,89 | 6.071 | 4,46 | 100/100 wallets |
| hot wallet (8) | 1.000 | 0 | 0 | 0 | 0,20 | 114 | 0,01 | 1/1 |
| hot wallet (64) | 1.000 | 0 | 0 | 0 | 1,84 | 600 | 0,70 | 1/1 |
| hot wallet (256) | 1.000 | 0 | 0 | 0 | 2,15 | 1.776 | 2,17 | 1/1 |
| duplicatas (x5) | 600 | 2.400 | 0 | 0 | 1,58 | 1.082 | 1,42 | 50/50 |

**Variação entre execuções:** rodei o script cerca de 15 vezes. A vazão variou bastante de uma execução para outra, então os números acima são uma amostra, não uma constante:
- wallets distintas: de 1.040 a 1.318 req/s;
- hot wallet: de 325 a 487 req/s;
- duplicatas: de 1.085 a 1.885 req/s.

## Análise

### Correção sob carga

Nas 5 execuções que já tinham a verificação final, inclusive as de sobrecarga, **todas** as wallets passaram: saldo igual ao ledger e exatamente um lançamento por transação aplicada.

No cenário de duplicatas, cada uma das 600 transações recebeu exatamente um 201 e quatro replays 200, vindos de instâncias diferentes, e o ledger tem um único débito por transação. É a mesma garantia dos testes de concorrência, agora com volume.

### Hot wallet: o trade-off do lock pessimista, em números

- **A vazão fica plana** (325 a 487 req/s), qualquer que seja a concorrência. A wallet se comporta como uma fila com um único atendente: cada transação segura o lock por cerca de 2 a 3ms (1 / 400 req/s).
- **A latência é fila, não lentidão.** Pela lei de Little (latência média ≈ concorrência / vazão):
  - com 64 em voo, 64 / 325 ≈ 197ms de média, para um p50 medido de 153ms;
  - com 256 em voo, 256 / 452 ≈ 566ms de média, para um p50 de 506ms.
- **Nenhum conflito de lock, nem com 256 em voo.** O pool (20 conexões × 3 instâncias = 60) limita quantas transações podem esperar o lock ao mesmo tempo: 60 × ~2,5ms ≈ 150ms, bem abaixo do `lock_timeout` de 2s. O resto da fila espera por uma conexão do pool, dentro da aplicação, não no lock do banco.
- Wallets diferentes não disputam nada: o cenário de wallets distintas teve zero conflitos e vazão cerca de 3 vezes maior.

### Duplicatas

O replay é mais barato que a primeira execução: p50 de 33ms, contra 44ms no cenário de wallets distintas. Isso acontece porque a primeira busca pela `Idempotency-Key` é feita sem lock (D8): uma cópia que chega depois do commit nem entra na fila da wallet.

### Outbox

- No cenário de wallets distintas, as 4.000 transações geram cerca de 7.200 eventos: dois por BET e WIN, um por LOSS, mais os das aberturas.
- A outbox chegou a 6.071 pendentes, com lag máximo de cerca de 3s, e esvaziou 4,5s depois da última resposta. Os 3 publishers juntos sustentam cerca de 900 eventos/s.
- **Gargalo identificado:** o publisher faz uma chamada `SendMessage` por evento, em sequência. O próximo passo seria o `SendMessageBatch`, que envia até 10 eventos por chamada.
- **Limitação do emulador** (descoberta durante o experimento): ninguém consome a fila de eventos neste ambiente, então ela acumula a cada execução, e o MiniStack fica mais lento à medida que ela cresce.
  - Medi o `SendMessage`: p50 de 0,6ms numa fila vazia, contra 7,8ms com 143 mil mensagens acumuladas.
  - Com isso, o drain do mesmo cenário passou de cerca de 4s para 46s.
  - O SQS real não se comporta assim. Por isso a execução de referência começa com o emulador recriado.

### Erros

- Zero erros na execução de referência.
- Nas cerca de 15 execuções, houve **um** erro de rede no cliente, em mais de 100 mil requisições.
  - Os contadores do servidor mostram que ele nunca foi processado: 600 processadas + 2.399 replays = 2.999 de 3.000 requisições.
  - A hipótese mais provável é a corrida de keep-alive: o servidor fecha uma conexão ociosa no mesmo instante em que o cliente a reutiliza.
  - O erro não voltou a acontecer. O script passou a registrar a causa de cada erro de rede.
  - Para o provedor, o caminho é reenviar com a mesma `Idempotency-Key`, o que é seguro: é exatamente para isso que a idempotência existe.

### Sobrecarga: o que acontece além do limite

Rodei o cenário de hot wallet com **2.048 requisições em voo**, mais do que o pool comporta. O `fetch` do Bun limita o cliente a 256 em voo por padrão, então usei `BUN_CONFIG_MAX_HTTP_REQUESTS=4096`:

| Concorrência | Requisições | req/s | p50 ms | p95 ms | máx ms | Status | Saldo == ledger |
|---|---|---|---|---|---|---|---|
| 2.048 | 3.000 | 312 | 3.090 | 9.157 | 9.596 | 201: 3.000 | 1/1 |

- **Não houve erro nem corrupção.** A espera por uma conexão do pool estourou o limite de 3s centenas de vezes (686 retries `connection failure` só numa das instâncias). Esses erros são classificados como transitórios e reexecutados até 2 vezes dentro da própria requisição (D7), e todas acabaram aplicadas.
- **O custo é a latência:** no pior caso, 3 tentativas × 3s ≈ 9s. Para um provedor com timeout próprio, uma resposta em 9s pode ser pior que um 503 rápido.
- **Próximo passo:** *load shedding*, ou seja, responder 503 com `Retry-After` logo de cara quando a fila do pool estiver longa, e não fazer retry em processo para timeout de pool. Junto com o particionamento por wallet (ARCHITECTURE, seção 7), isso atacaria a hot wallet pelos dois lados.
- Os números de outbox dessa execução não estão na tabela: o emulador já estava com dezenas de milhares de eventos acumulados.

## Limitações do experimento

- **Tudo na mesma máquina:** gerador, 3 instâncias, Postgres e emulador disputam a mesma CPU, dentro da VM do Docker Desktop. Os números servem para comparar cenários entre si, não para prever produção. Não perfilei a aplicação, então não afirmo qual é o gargalo do cenário de wallets distintas.
- **Execuções curtas** (de 1 a 4s por cenário com `LOAD_SCALE=1`): não há aquecimento separado nem execução longa (memória, autovacuum, crescimento das tabelas). `LOAD_SCALE` serve para alongar.
- **Modelo fechado:** sob saturação, o gerador desacelera junto com o sistema e subestima a latência que um provedor de verdade veria (*coordinated omission*). O próximo passo seria um modelo aberto, com taxa de chegada fixa (por exemplo, `constant-arrival-rate` do k6).
- **Só HTTP:** o caminho pelo consumer SQS não foi testado sob carga. O consumer processa em ordem dentro de cada `MessageGroupId` (a wallet), então a vazão dele por wallet tem o mesmo limite da hot wallet.
- **Mistura simples:** BET, WIN e LOSS. REFUND, ROLLBACK e referências fora de ordem estão cobertos nos testes de integração, mas não neste experimento.
