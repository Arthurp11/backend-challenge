# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por HTTP ou SQS. Ele continua correto com mensagens **duplicadas**, **fora de ordem** e processadas por **várias instâncias ao mesmo tempo**.

- Enunciado do desafio: [docs/DESAFIO.md](docs/DESAFIO.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)

**Stack:** Bun 1.4, TypeScript estrito, NestJS 12, MikroORM 7, PostgreSQL 17, SQS (MiniStack) e Docker Compose.

## Garantias em uma frase cada

- **Dinheiro nunca é `number`:** `bigint` em centavos no domínio, `numeric(20,2)` no banco e string decimal nos contratos.
- **Concorrência:** lock pessimista **por wallet** (`SELECT … FOR UPDATE`), nunca global, com lost-update guard por versão.
- **Idempotência persistente:** `Idempotency-Key` única no banco, replay devolvendo o resultado original e 409 para payload diferente.
- **Saldo e ledger nunca divergem:** um trigger diferido no Postgres exige o lançamento de cada mudança de saldo, e o ledger é append-only.
- **Eventos:** outbox na mesma transação SQL, publicada com `SKIP LOCKED` (at-least-once, dedup por `eventId`).
- **SQS:** inbox persistente, ack só depois do commit, retry com backoff, DLQ e shutdown gracioso.

## Subindo tudo

Pré-requisitos: Docker com Compose v2. O [Bun](https://bun.sh) 1.4+ só é necessário para testes e scripts.

```bash
docker compose up --build -d            # Postgres, MiniStack, setup (filas e migrations) e a app
curl localhost:3000/health/ready        # {"status":"ok","checks":{"database":"up","queue":"up"}}
```

Três instâncias da aplicação, todas com HTTP, consumer, publisher e worker:

```bash
docker compose up --build -d --scale app=3   # portas 3000, 3001 e 3002
```

## Usando a API

```bash
# 1. Criar uma wallet (saldo inicial vira uma transação OPENING com lançamento no ledger)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# 2. Apostar (troque WALLET_ID). Repetir o mesmo comando devolve um replay: 200 e idempotentReplay=true
curl -s -i -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# 3. Consultas
curl -s localhost:3000/wallets/WALLET_ID
curl -s 'localhost:3000/wallets/WALLET_ID/ledger?limit=50'           # cursor opaco em nextCursor
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123
curl -s -X POST localhost:3000/wallets/WALLET_ID/reconciliation       # saldo gravado × ledger

# 4. A mesma operação pela fila (o consumer usa o mesmo use case)
bun run sqs:send WALLET_ID 0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1 BET 10.00

# 5. Observabilidade
curl -s localhost:3000/metrics | grep wager_
docker compose logs app | head          # logs JSON com correlationId, walletId, transactionId…
```

Os status HTTP (201, 200, 202, 422, 400, 404, 409, 503) estão na decisão D12 do [ARCHITECTURE.md](ARCHITECTURE.md#d12-status-http).

## Testes

```bash
docker compose up -d postgres sqs     # os testes de integração usam containers reais, sem mocks
bun install
bun run test                # unitários: domínio puro, sem Docker (~0,1s)
bun run test:integration    # integração e concorrência: PostgreSQL e MiniStack reais (~30s)
bun run test:all            # tudo
bun run typecheck
```

- Os testes de integração usam um banco próprio, `wagering_test`, recriado pelas migrations reais a cada execução (o harness se recusa a resetar um banco que não termine em `_test`), e filas SQS exclusivas por arquivo de teste.
- `test/concurrency/multi-instance.test.ts` sobe **processos separados** da aplicação. Ele testa 3 instâncias simultâneas, um `SIGKILL` entre commit e ack, um publisher morto entre publicar e marcar, e um reinício no meio da carga.
- O mapa de cada teste exigido pelo desafio está em [ARCHITECTURE.md §4.1](ARCHITECTURE.md#41-onde-estão-os-testes-obrigatórios-seção-13).

### Teste de carga

```bash
docker compose up --build -d --scale app=3
bun run test:load           # ~30s: wallets distintas, hot wallet e duplicatas, com reconciliação de todas as wallets no fim
```

Ambiente, metodologia, resultados (vazão, p50/p95/p99, erros, conflitos de lock, outbox lag) e análise: [docs/load-test.md](docs/load-test.md).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run migration:up` / `migration:down` / `migration:status` | aplica, reverte uma, mostra o estado (serializado por advisory lock) |
| `bun run sqs:setup` | cria as filas (idempotente) |
| `bun run sqs:send <walletId> <playerId> [kind] [amount] [ref]` | publica uma `WagerTransactionRequested` na fila |
| `bun run dev` | app local com watch (usa Postgres e MiniStack do Compose) |

## Configuração

Os defaults ficam em [src/infrastructure/config/env.ts](src/infrastructure/config/env.ts), validados na subida, e batem com o `docker-compose.yml`. Os mais relevantes:

| Variável | Padrão | Para quê |
|---|---|---|
| `RUN_CONSUMER`, `RUN_OUTBOX_PUBLISHER`, `RUN_PENDING_REFERENCE_WORKER` | `true` | liga e desliga cada papel da instância |
| `DB_LOCK_TIMEOUT_MS` | `2000` | espera máxima pelo lock de uma wallet (depois: erro transitório) |
| `REFERENCE_RETRY_BASE_MS` / `_MAX_MS` / `_MAX_ATTEMPTS` | `1000` / `60000` / `10` | backoff das referências fora de ordem |
| `SQS_MAX_RECEIVE_COUNT` | `5` | tentativas antes da DLQ |
| `LOG_LEVEL` | `info` | nível dos logs JSON |

Se alguma porta já estiver em uso na sua máquina, crie um `.env` (ignorado pelo git; o Compose e o Bun leem automaticamente):

```bash
POSTGRES_HOST_PORT=5435
DATABASE_URL=postgres://wagering:wagering@localhost:5435/wagering
```

## Estrutura

```
src/domain/          regras de negócio em TypeScript puro (Money, Wallet, WagerTransaction, ledger, eventos)
src/application/     use cases e portas (UnitOfWork, Clock, IdGenerator, EventPublisher)
src/infrastructure/  MikroORM (schema, repositórios, migrations), SQS, workers, logs e métricas
src/interfaces/      controllers HTTP e consumer SQS
test/                unit/, integration/, concurrency/ e support/ (harness)
```
