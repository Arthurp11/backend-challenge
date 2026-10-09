# Arquitetura — Distributed Wagering Processor

Este documento registra **as decisões, os trade-offs e as limitações** da solução. Setup e comandos ficam no [README.md](README.md).

## 1. Visão geral

O provedor manda transações por HTTP ou pela fila wager-transactions.fifo. Os dois caminhos chamam o mesmo use case, que grava tudo numa única transação no Postgres: saldo, ledger, inbox e o evento na outbox. Depois, um worker publica os eventos da outbox na fila de eventos, e outro reprocessa as transações que chegaram antes da referência.

Princípio central: **o PostgreSQL é a fonte da verdade para todas as invariantes.** Os recursos do SQS (FIFO, deduplicação) são otimização, nunca garantia.

Camadas (as setas indicam quem depende de quem):

```
interfaces (HTTP, consumer SQS) ──► application (use cases, portas) ──► domain (regras, TypeScript puro)
                                              ▲
infrastructure (MikroORM, SQS, workers, logs, métricas) ── implementa as portas
```

O domínio não conhece Nest, MikroORM nem SQS. Os use cases conhecem apenas interfaces (`UnitOfWork`, `Clock`, `IdGenerator`, `EventPublisher`), que o `AppModule` liga às implementações.

---

## 2. Decisões

Formato de cada decisão: **contexto → decisão → alternativas descartadas → trade-off**.

### D1. Emulador de SQS: MiniStack

- **Contexto:** o desafio aceita LocalStack ou MiniStack. Desde a versão 2026.03, a imagem do LocalStack exige um auth token de uma conta.
- **Decisão:** MiniStack (MIT, porta 4566, compatível com o SDK da AWS).
- **Alternativa descartada:** LocalStack com token gratuito. Quem avalia precisaria criar uma conta só para rodar o projeto.
- **Trade-off:** o MiniStack é menos usado que o LocalStack. Os comportamentos de que dependemos (FIFO, redrive para a DLQ, visibility timeout) são cobertos pelos testes de integração.
- **Limitação descoberta:** o MiniStack guarda as filas em memória. Se o container do SQS reiniciar, as filas somem e o readiness fica `down` até alguém rodar `bun run sqs:setup` de novo. No SQS real isso não acontece. Por isso os testes de reinício derrubam as instâncias da aplicação, nunca o emulador.

### D2. Provisionamento separado do boot da aplicação

- **Contexto:** filas e schema precisam existir antes de o app processar qualquer coisa, e o desafio exige várias instâncias rodando ao mesmo tempo.
- **Decisão:** um serviço `setup` no Docker Compose roda uma vez, cria as filas e aplica as migrations. O app só sobe depois que ele termina com sucesso.
- **Por que não no boot do app:**
  - **Migrations:** várias instâncias subindo juntas disputariam a mesma migration pendente.
  - **Filas:** em produção, fila é infraestrutura, não responsabilidade da aplicação. Com a criação das filas fora da aplicação, como seria num Terraform, o app só precisa de permissão para escrever e ler mensagens. Se ele for comprometido, não consegue apagar filas nem mexer na DLQ.
- **Idempotência:** rodar o `setup` de novo é seguro. O `CreateQueue` com atributos idênticos devolve a fila existente, e o migrator só aplica as migrations pendentes.
- **Trade-off:** é um passo a mais no ambiente local, mas automatizado pelo Compose.

### D3. Migrations serializadas com advisory lock

- **Contexto:** o migrator do MikroORM 7 não usa nenhum lock. Duas execuções simultâneas (dois pipelines de deploy, por exemplo) veriam a mesma migration como pendente.
- **Decisão:** `pg_advisory_lock` numa conexão dedicada durante `up` e `down`. A segunda execução espera o lock e depois não encontra nada pendente.
- **Alternativa descartada:** tabela de lock com uma flag `locked = true`. Se o processo morrer, a flag fica presa até alguém removê-la à mão. O advisory lock é liberado pelo Postgres quando a sessão cai.
- **Garantia complementar:** cada migration roda numa transação. Como DDL no Postgres é transacional, uma falha no meio faz rollback completo.

### D4. Health checks: liveness e readiness separados

- **Decisão:** `/health/live` não checa dependências. `/health/ready` executa `select 1` no Postgres e `GetQueueUrl` no SQS, com timeout de 2s cada; se algum falhar, responde 503.
- **Por quê:** se o liveness dependesse do banco, uma queda do Postgres faria o orquestrador reiniciar todas as instâncias em loop, e reiniciar não conserta o banco. O readiness só tira a instância do tráfego.
- **Detalhe:** o primeiro readiness respondia `database: down` com o banco no ar. Investigando, vi que o MikroORM 7 só conecta na primeira query e que o `checkConnection()` não abre conexão. Por isso o readiness executa um `select 1` real.
- **Trade-off consciente:** o README pede que o readiness dependa do SQS, e segui isso. Em produção, eu faria a API depender só do Postgres: graças ao outbox, transações continuam sendo processadas com o SQS fora, e os eventos acumulam até ele voltar. SQS fora seria um estado *degradado*, sinalizado por métrica e alerta de outbox lag, sem tirar a instância do tráfego.

### D5. Dinheiro: `bigint` em centavos no domínio, string decimal nos contratos

- **Contexto:** `number` não representa valores como 0,10 de forma exata (`0.1 + 0.2 === 0.30000000000000004`), e a primeira restrição do desafio proíbe `number` para dinheiro.
- **Decisão:**
  - `Money` guarda um `bigint` de centavos, com escala fixa de 2 casas. Toda conta é soma ou subtração de inteiros, então não existe arredondamento.
  - Entrada e saída são sempre strings decimais (`"25.00"`). O `toJSON()` garante que um `bigint` nunca chega a resposta, evento ou log.
  - No banco, `numeric(20,2)` e `currency char(3)`. O driver `pg` devolve `numeric` como string, que volta ao domínio por `Money.from`, então o valor nunca passa por `number`.
- **Validação da entrada:**
  - Aceita até 2 casas e normaliza (`"25"` vira `"25.00"`).
  - Rejeita o que exigiria arredondamento (`"10.005"`), notação científica, sinal, zeros à esquerda, espaços, vírgula, `NaN`, `Infinity` e mais de 18 dígitos inteiros, que não caberiam em `numeric(20,2)`.
  - Todo `Money` nasce por uma factory que confere esse limite, então nunca existe um valor que o banco não consiga gravar.
- **Alternativas descartadas:**
  - `decimal.js` ou `big.js`: uma dependência a mais para algo que, com escala fixa, é aritmética de inteiros.
  - `number` em centavos: é seguro só até 2^53 e aceita frações acidentais (meio centavo).
  - Tipo monetário do ORM no domínio: acoplaria o domínio ao MikroORM, o que a seção 6.1 do desafio proíbe.
- **Trade-off:** a escala fixa de 2 casas não atende moedas com 3 casas (KWD, BHD) nem cripto. Mudar isso exigiria migration e uma nova versão do contrato. Aceito porque o desafio fixa 2 casas.
- **Multi-moeda:**
  - Validei só o formato ISO-4217 (3 letras maiúsculas), não a lista oficial de moedas.
  - `add`, `subtract` e `isLessThan` entre moedas diferentes lançam `CurrencyMismatchError`.
  - `equals` só responde `false`, porque perguntar se dois valores são iguais é uma pergunta legítima, enquanto somar BRL com USD não faz sentido.

### D6. ORM e mapeamento domínio ↔ persistência

- **Contexto:** o desafio prefere o MikroORM, proíbe que o domínio dependa do ORM e avalia a estratégia transacional. No caminho do dinheiro, a ordem dos statements e o ponto exato de cada erro de constraint importam.
- **Decisão:**
  - **Records separados do domínio:** o MikroORM 7 mapeia "records" (o formato da linha) com `EntitySchema` em `infrastructure/persistence/schemas.ts`. Mappers convertem record ↔ domínio sempre via `rehydrate`. O domínio não tem decorator nem tipo do ORM.
  - **Dinheiro:** colunas `numeric(20,2)` lidas como string (`DecimalType('string')`) e convertidas com `Money.from`, com a moeda em coluna separada. Uma transação rejeitada por `CURRENCY_MISMATCH` guarda o saldo observado em outra moeda, por isso `result_balance` tem a sua própria coluna de moeda.
  - **Transação:** uma porta `UnitOfWork`, implementada com `orm.em.fork().transactional(...)` e `READ COMMITTED` explícito. Uso um fork por unidade de trabalho porque workers e consumer não têm request context, e forks não compartilham identity map.
  - **Sem escrita implícita:** no caminho do dinheiro, só uso operações imediatas (`insert`, `nativeUpdate`, `findOne` com `LockMode.PESSIMISTIC_WRITE`), na ordem em que o use case chama. As leituras usam `disableIdentityMap`, e nada fica para o flush implícito do Unit of Work.
  - **Erros:** os códigos SQLSTATE viram erros da aplicação. `23505` vira `UniqueViolationError`, com o nome da constraint. Lock timeout, deadlock, serialização, timeouts e conexão viram `TransientInfrastructureError`.
  - **Timeouts por sessão** (via `driverOptions`): `lock_timeout` de 2s, `statement_timeout` de 5s e `idle_in_transaction_session_timeout` de 10s. As migrations rodam sem eles, porque um índice numa tabela grande pode demorar mais do que uma requisição deveria.
- **Alternativas descartadas:**
  - Decorators nas classes de domínio: acoplariam o domínio ao ORM, e o construtor privado brigaria com a hidratação do ORM.
  - `persist` + `flush` (Unit of Work clássico): ordena os statements pelas foreign keys e só executa no flush. Eu quero a ordem explícita (lock → regras → insert → update) e cada erro de constraint no ponto onde aconteceu.
  - SQL cru em todo lugar: perderia a tipagem, o `LockMode` e o `transactional()`.
- **Trade-off:** o Unit of Work e o Identity Map do MikroORM ficam subutilizados. Troquei essa conveniência por previsibilidade no caminho financeiro. Os mappers são código manual a mais, mas tudo fica explícito.
- **Testes de integração:** rodam num banco próprio (`wagering_test`), recriado a partir das migrations reais a cada execução. O harness se recusa a resetar qualquer banco cujo nome não termine em `_test`.

### D7. Concorrência: lock pessimista por wallet

- **Contexto:** a unidade de concorrência é a `walletId` (seção 8). Três ou mais instâncias, HTTP e SQS ao mesmo tempo, e uma "hot wallet" pode receber dezenas de operações simultâneas.
- **Decisão:** toda escrita numa wallet começa com `SELECT … FOR UPDATE` na linha dela (`LockMode.PESSIMISTIC_WRITE`), dentro da transação SQL. Requests HTTP, consumer e worker de referências passam pelo mesmo lock, então operações da mesma wallet rodam uma de cada vez, e wallets diferentes rodam em paralelo. Não existe lock global.
- **Camadas de reserva:**
  - o `UPDATE` do saldo leva `WHERE version = <versão lida>`, e se nada for atualizado, lança `ConcurrentModificationError` (lost update impossível mesmo se alguém esquecer o lock);
  - `CHECK (balance_amount >= 0)`;
  - o trigger diferido que exige o lançamento de cada versão.
- **Ordem dos locks, sempre a mesma:** chave da inbox (só SQS) → linha da wallet. O worker trava a wallet antes de reler a transação pendente. Com uma ordem única, não há ciclo e, portanto, não há deadlock entre request, consumer e worker.
- **Espera limitada:** `lock_timeout` de 2s. Estourou: erro transitório, nova tentativa em processo (2 vezes, com backoff e jitter) e, se ainda falhar, 503 no HTTP ou nova entrega com backoff no SQS.
- **Alternativas descartadas:**
  - Optimistic locking com retry: numa hot wallet, 50 requests simultâneos geram 49 conflitos por rodada e uma tempestade de retries.
  - `UPDATE … SET balance = balance - x WHERE balance >= x` (atômico condicionado): resolve a BET, mas reversões e o ledger precisam ler o estado (referência, saldo antes) antes de escrever, então o lock volta de qualquer jeito.
  - Advisory lock por wallet: equivalente, mas fora da linha e fácil de esquecer de liberar.
- **Trade-off:** uma wallet muito disputada tem a vazão limitada pela duração da transação (milissegundos). O pool de conexões limita a concorrência total por instância.
- **Provas:** `test/concurrency/same-wallet.test.ts` (50 apostas idênticas, cenário 100 menos 80 mais 80 repetido 10 vezes, 40 apostas contra 100), `parallel-wallets.test.ts` e `multi-instance.test.ts` (3 processos).

### D8. Idempotência e `payloadHash`

- **Fonte da verdade:** o header `Idempotency-Key`, obrigatório. No banco: `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. Nada fica em cache de memória.
- **`payloadHash`:** sha256 (hex) do JSON canônico dos campos de negócio, com as chaves ordenadas em todos os níveis e sem espaços:
  - os campos são `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (valor normalizado para 2 casas) e `referenceExternalTransactionId` (`null` quando ausente);
  - a key, o `messageId` e os headers ficam de fora, então a mesma operação por HTTP ou SQS gera o mesmo hash.
- **Fluxo:**
  1. Busca pela key sem lock: se existe, é replay.
  2. Lock da wallet.
  3. Nova busca pela key (em `READ COMMITTED`, cada statement vê o que quem segurava o lock commitou).
  4. Se o `externalTransactionId` já existe com outra key: conflito.
  5. Aplica as regras e grava.
- **Corrida entre wallets diferentes:** se dois pedidos com a mesma key apontam para wallets diferentes, os locks não se cruzam e o segundo `INSERT` viola o `UNIQUE`. O Postgres aborta a transação. Eu faço rollback e rodo o use case de novo **uma vez**: agora a linha commitada é visível, e o resultado é replay ou 409.
- **Replay devolve o que foi gravado** (status, `failureCode`, `resultBalance`), nunca o saldo atual: é o "saldo observado naquele momento". Rejeições são persistidas, então o replay de uma rejeição devolve a mesma rejeição.
- **Conflitos:** mesma key com payload diferente → 409 `IDEMPOTENCY_KEY_CONFLICT`. Mesmo id do provedor com outra key → 409 `EXTERNAL_ID_CONFLICT`.
- **HTTP e SQS compartilham a idempotência:** a mesma operação enviada pelos dois caminhos é aplicada uma vez (teste em `consumer.test.ts`).

### D9. Referências fora de ordem

- **Decisão:** a transação fica gravada como `PENDING_REFERENCE`, com `reference_attempts` e `next_reference_attempt_at`, e emite `WagerTransactionPendingReference`.
  - Um worker agendado busca as que estão vencidas (índice parcial).
  - Cada uma é tentada de novo na sua própria transação: trava a wallet, relê a transação e aplica **as mesmas regras** da primeira chegada.
- **Backoff e limite:** 1s, 2s, 4s… com teto de 60s, em até 10 esperas (cerca de 6 minutos), e depois `REJECTED` com `REFERENCE_NOT_FOUND`, mais o evento. Tudo configurável por env.
  - Por que 6 minutos: cobre redeliveries do SQS (visibility de 30s com retries) e quedas curtas. Ao mesmo tempo, o provedor recebe uma resposta definitiva em minutos, e não fica dias sem saber se a reversão vai acontecer.
- **Várias instâncias:** dois workers podem examinar o mesmo candidato. O lock da wallet e a releitura do status garantem que só um aplica (o outro vê que já não está pendente). O custo é trabalho desperdiçado, nunca efeito duplicado.
- **Corrente:** se a referência existe mas ela mesma ainda espera a sua referência, a transação continua esperando. Se a referência terminou `REJECTED` ou `FAILED`, a rejeição é imediata (`REFERENCE_NOT_PROCESSED`).
- **Provas:** `test/integration/pending-references.test.ts` (REFUND antes da BET, ROLLBACK antes do WIN, referência que nunca chega, dois REFUNDs da mesma BET atrasada) e `multi-instance.test.ts`.

### D10. Transactional outbox

- **Escrita:** o evento vai para `outbox_messages` na **mesma transação SQL** da mudança financeira. Um evento existe se, e somente se, a mudança foi commitada. Nada é publicado antes do commit, porque o publisher só enxerga linhas commitadas.
- **Publicação:**
  - O worker pega linhas vencidas com `FOR UPDATE SKIP LOCKED`, ordenadas por `id` (uuidv7, aproximadamente a ordem de criação), em lotes de 10.
  - Publica cada uma com timeout de 3s e marca `published_at` na mesma transação.
  - Publicadores concorrentes pegam fatias disjuntas e nunca esperam um pelo outro.
- **Falha ao publicar:** `attempts` sobe, `next_attempt_at` recebe backoff (de 0,5s a 30s) e `last_error` registra o motivo. O publisher **nunca desiste**, porque evento confirmado não pode se perder. O alerta vem da métrica de outbox lag.
- **Crash entre publicar e commitar:** a linha continua não publicada e o lock cai com a sessão. Outra instância publica de novo, então a entrega é at-least-once.
  - O `eventId` vai como `MessageDeduplicationId` (o FIFO descarta a repetição dentro de 5 minutos).
  - Os consumidores deduplicam por `eventId`.
- **Ordem:** `MessageGroupId = walletId` mantém a ordem por wallet dentro de um publisher. Entre publishers concorrentes, a ordem é best-effort. Para ordenar ou ignorar eventos atrasados, os consumidores usam o `walletVersion` do `WalletBalanceChanged`.
- **Trade-off:** as linhas ficam travadas durante a chamada ao SQS. O tempo é limitado pelo timeout de 3s por mensagem, menor que o `idle_in_transaction_session_timeout` (10s).
- **Provas:** `test/integration/outbox.test.ts` (dois publishers sem perda nem duplicata, falha e reentrega) e `multi-instance.test.ts` (publisher morto com SIGKILL entre publicar e marcar; outra instância assume).

### D11. Consumer SQS: inbox e classificação de erros

- **Mesmo use case do HTTP.** O registro na inbox `(consumer_name, message_id)` é gravado na **mesma transação** da mudança financeira, e o `DeleteMessage` (ack) só acontece **depois do commit**.
- **Classificação:**

  | Situação | Classe | O que acontece |
  |---|---|---|
  | `REJECTED`, `PENDING_REFERENCE`, replay | negócio | ack (o resultado está persistido) |
  | lock timeout, deadlock, conexão, erro desconhecido | transitório | nova entrega com backoff na visibilidade (2s, 4s, 8s…, teto de 60s). Depois de `maxReceiveCount` (5), a redrive policy move para a DLQ |
  | mensagem malformada, conflito de idempotência, mesmo `messageId` com outro payload, wallet inexistente | permanente | envio explícito para a DLQ, com o atributo `failureReason`, e ack |

- **Ordem:** mensagens do mesmo `MessageGroupId` (a wallet) são processadas em sequência, e grupos diferentes em paralelo.
- **SIGTERM:** para de buscar mensagens (aborta o long poll), deixa terminar o que está em andamento (até 10s) e devolve a visibilidade (0) das mensagens recebidas que não começaram.
- **Crash depois do commit e antes do ack:** a mensagem volta depois da visibility, a inbox reconhece o `messageId` e a resposta é um replay sem efeito. O teste mata o processo com SIGKILL exatamente nesse ponto (`FAULT_INJECTION=crash_after_commit_before_ack`, um ponto de injeção desligado por padrão).
- **Provas:** `test/integration/consumer.test.ts` (redelivery, HTTP mais SQS, rejeição com ack, DLQ explícita, retry com backoff e redrive para a DLQ) e `multi-instance.test.ts`.

### D12. Status HTTP

O mesmo mapeamento vale em todos os endpoints. O provedor decide pelo status e pelo `code`, nunca lendo mensagens. O corpo de erro é sempre `{ code, message, retryable, issues? }`.

| Status | Quando | `code` |
|---|---|---|
| 201 | transação nova aplicada; wallet criada | — |
| 200 | replay idempotente; consultas | — |
| 202 | aceita, aguardando a referência (`PENDING_REFERENCE`) | — |
| 422 | rejeição de negócio (`REJECTED`, ou `FAILED`), persistida e com `failureCode` | — |
| 400 | payload, header ou parâmetro inválido | `INVALID_REQUEST`, `INVALID_MONEY`, `INVALID_WAGER_TRANSACTION`, `INVALID_CURSOR` |
| 404 | wallet ou transação inexistente | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| 409 | conflito | `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| 503 | falha transitória, com `Retry-After: 1`. Reenviar com a mesma key é seguro | `SERVICE_UNAVAILABLE` |
| 500 | erro inesperado. Reenviar com a mesma key também é seguro | `INTERNAL_ERROR` |

### D13. Observabilidade e modo de execução

- **Logs:**
  - JSON (pino), com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, injetados em toda linha por `AsyncLocalStorage`;
  - `redact` mascara `money`, `balance`, `amount`, `payload` e `body`, mesmo se alguém logar por engano;
  - o `X-Correlation-Id` é lido do request (ou criado) e devolvido na resposta.
- **Métricas** (`GET /metrics`, Prometheus):

  | Exigência da seção 12 | Métrica |
  |---|---|
  | transações por status | `wager_transactions_total{status,kind,source}` |
  | duplicatas detectadas | `wager_duplicates_detected_total{source}` |
  | retries | `wager_retries_total{reason}` |
  | mensagens em DLQ | `wager_dead_letter_messages_total{reason}` |
  | conflitos de lock | `wager_lock_conflicts_total` |
  | outbox lag | `outbox_lag_seconds`, `outbox_pending_messages` (medidos no scrape) |
  | latência | `wager_processing_duration_seconds{source}` (histograma) |
  | extras | `reconciliation_divergences_total`, `pending_reference_resolutions_total`, `outbox_published_total`, `outbox_publish_failures_total` |

- **Modo de execução:** cada instância roda HTTP, consumer, publisher da outbox e worker de referências, cada um ligável por flag (`RUN_CONSUMER`, `RUN_OUTBOX_PUBLISHER`, `RUN_PENDING_REFERENCE_WORKER`). Em produção eu separaria os papéis em deployments diferentes; aqui a mesma imagem escala com `docker compose up --scale app=3`. No SIGTERM, os workers drenam primeiro e só depois o servidor HTTP e o pool fecham.

---

## 3. Modelo de domínio

O domínio (`src/domain`) é TypeScript puro: sem Nest, sem ORM e sem relógio. Ids e horários chegam como parâmetro, o que deixa todas as regras testáveis sem banco. Toda classe tem construtor privado. A factory `create`/`from`/`open` valida a entrada de um dado novo. A `rehydrate` só reconstrói o que já está no banco, sem revalidar, porque o que foi gravado é um fato, e uma corrupção precisa ser carregada para ser detectada.

As regras de negócio da seção 7 ficam numa função de domínio, `applyWagerTransaction`, chamada igualmente na primeira chegada da transação (HTTP ou SQS) e em cada nova tentativa do worker de referências.

### 3.1 Máquina de estados da `WagerTransaction`

```
PENDING ──► PROCESSED | REJECTED | FAILED
   │
   └──► PENDING_REFERENCE ──► PENDING_REFERENCE (nova espera) | PROCESSED | REJECTED | FAILED
```

- `PROCESSED`, `REJECTED` e `FAILED` são terminais. Qualquer transição a partir deles lança `InvalidTransactionStateError`, porque é erro de programação, não caminho de negócio.
- `PENDING` só existe em memória, dentro da transação SQL que processa o pedido. No banco aparecem apenas `PENDING_REFERENCE` e os estados terminais.
- Cada ida para `PENDING_REFERENCE` conta uma tentativa e agenda a próxima com backoff exponencial. Esgotado o limite, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND`.
- Toda transição grava o saldo observado naquele momento (`resultBalance`). É ele que um replay idempotente devolve, nunca o saldo atual.

### 3.2 Códigos de falha

O provedor decide pelo código, nunca pela mensagem. Os códigos fazem parte do contrato público: posso acrescentar novos, mas nunca renomear.

| Código | Quando | O que o provedor deve fazer |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | desistir da aposta; pode tentar outra, com novo id |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de um crédito (WIN ou REFUND) que o jogador já gastou | tratamento manual: o dinheiro já saiu |
| `CURRENCY_MISMATCH` | moeda da operação diferente da moeda da wallet | corrigir o payload |
| `PLAYER_WALLET_MISMATCH` | `playerId` diferente do dono da wallet | corrigir o payload |
| `REFERENCE_NOT_FOUND` | a referência não chegou dentro da janela de tentativas | reenviar a referência e depois a reversão, com novo id |
| `REFERENCE_MISMATCH` | a referência é de outro provider, player, wallet, moeda ou rodada | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | REFUND que não aponta para BET; ROLLBACK que não aponta para BET, WIN ou REFUND; WIN ou LOSS que não aponta para BET | corrigir o payload |
| `REFERENCE_AMOUNT_MISMATCH` | REFUND ou ROLLBACK com valor diferente da referência (reversão parcial está fora de escopo) | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | a referência terminou `REJECTED` ou `FAILED`: não há o que reverter | desistir |
| `ALREADY_REVERSED` | a referência já foi revertida por um REFUND ou ROLLBACK | desistir: a reversão já aconteceu |
| `PERMANENT_PROCESSING_ERROR` | `FAILED`: erro permanente de infraestrutura, mantido para auditoria | acionar suporte |

Erros de **entrada** (payload malformado, OPENING enviado por provedor, REFUND sem referência) não viram transação `REJECTED`. Eles são rejeitados antes, como payload inválido, e nada é gravado.

### 3.3 Regras de referência

- Uma referência é procurada por `(providerId, referenceExternalTransactionId)` e precisa ser do mesmo provider, player, wallet, moeda e rodada.
- Direção no ledger: BET debita; OPENING, WIN e REFUND creditam; ROLLBACK faz o inverso da referência (de uma BET credita, de um WIN ou REFUND debita); LOSS não move saldo.
- Se a referência ainda não chegou, ou se ela mesma ainda está esperando a sua referência (uma corrente), a transação espera em `PENDING_REFERENCE`.

---

## 4. Invariantes: onde cada uma é garantida

Cada invariante é garantida **em duas camadas** (domínio e banco) e **provada por um teste**.

| Invariante | Domínio | Banco (schema) | Teste |
|---|---|---|---|
| Dinheiro nunca é `number` | `Money` com `bigint` de centavos | `numeric(20,2)`, lido como string (`DecimalType('string')`) | `test/unit/domain/money.test.ts` |
| Saldo nunca negativo | `Wallet.debit` lança `InsufficientFundsError`; `WalletLedgerEntry` recusa saldo final negativo | `CHECK wallets_balance_non_negative` e `CHECK` nos saldos do ledger | `test/unit/domain/wallet.test.ts`, `test/integration/schema-constraints.test.ts` |
| Uma wallet por `playerId` + `currency` | — (só o banco enxerga todas as wallets) | `UNIQUE wallets_player_currency_key` | `test/integration/schema-constraints.test.ts` |
| Toda alteração de saldo tem um lançamento no ledger | `debit` e `credit` são o único jeito de mudar o saldo, e ambos devolvem o lançamento | constraint trigger diferido `wallets_balance_change_is_ledgered`: no commit, cada versão da wallet precisa do lançamento com aquele saldo | `test/unit/domain/wallet.test.ts`, `test/integration/schema-constraints.test.ts` |
| Ledger imutável (sem UPDATE/DELETE) | `WalletLedgerEntry`: campos `readonly` e `Object.freeze`, sem métodos de transição | triggers append-only contra `UPDATE`, `DELETE` e `TRUNCATE` | `test/unit/domain/wallet-ledger-entry.test.ts`, `test/integration/schema-constraints.test.ts` |
| No máximo um lançamento por transação por wallet | `applyWagerTransaction` recusa uma transação que já está em estado terminal | `UNIQUE (wallet_id, transaction_id)` e `UNIQUE (wallet_id, wallet_version)` | `test/unit/domain/apply-wager-transaction.test.ts`, `test/integration/schema-constraints.test.ts` |
| Operação idempotente (sem débito ou crédito duplicado) | nova busca pela key depois do lock da wallet; replay devolve o resultado gravado | `UNIQUE idempotency_key` e `UNIQUE (provider_id, external_transaction_id)`; inbox `PK (consumer_name, message_id)` | `test/concurrency/same-wallet.test.ts` (50 em paralelo), `test/integration/consumer.test.ts`, `schema-constraints.test.ts` |
| Mesma key com payload diferente gera conflito | `payloadHash` canônico e `matchesPayload` | `payload_hash` gravado com a transação | `test/unit/domain/payload-hash.test.ts` |
| Referência revertida no máximo uma vez | `ALREADY_REVERSED` quando a referência já tem uma reversão processada | índice único parcial `wager_transactions_single_reversal` | `test/unit/domain/apply-wager-transaction.test.ts`, `test/integration/schema-constraints.test.ts` |
| Transação terminal não muda de estado | `InvalidTransactionStateError` | trigger `wager_transactions_terminal_is_final` (e transações nunca são apagadas) | `test/unit/domain/wager-transaction.test.ts`, `test/integration/schema-constraints.test.ts` |
| Sem lost update entre instâncias | todo use case de escrita trava a wallet antes de ler o saldo | `SELECT … FOR UPDATE` por wallet e `UPDATE … WHERE version = ?` | `test/integration/persistence.test.ts`, `test/concurrency/*.test.ts` (inclusive 3 processos) |
| Evento publicado só depois do commit | eventos viram `OutboxMessage` na mesma unidade de trabalho | `outbox_messages` gravada na mesma transação SQL; o publisher só lê linhas commitadas | `test/integration/persistence.test.ts` (atomicidade), `outbox.test.ts`, `multi-instance.test.ts` |
| `wallet.balance == saldo reconstruído pelo ledger` | cada lançamento guarda saldo antes e depois e a versão da wallet | trigger diferido acima, mais a corrente `balance_before = balance_after` anterior | `test/unit/domain/wallet.test.ts`, `test/support/ledger-invariant.ts` (usado em todo teste de integração) |

### 4.1 Onde estão os testes obrigatórios (seção 13)

| Exigência | Teste |
|---|---|
| `Money`: escala, arredondamento, entradas inválidas, conflito de moeda | `test/unit/domain/money.test.ts` |
| invariantes da `Wallet` | `test/unit/domain/wallet.test.ts` |
| regras de BET, WIN, LOSS, REFUND, ROLLBACK | `test/unit/domain/apply-wager-transaction.test.ts`, `wager-transaction.test.ts` |
| idempotency key com payload divergente | `test/unit/domain/payload-hash.test.ts`, `test/integration/http-api.test.ts` |
| migrations e constraints | `test/integration/migrations.test.ts`, `schema-constraints.test.ts` |
| atomicidade entre wallet, ledger, inbox e outbox | `test/integration/persistence.test.ts` |
| inbox e redelivery; retry e DLQ | `test/integration/consumer.test.ts` |
| publishers concorrentes na mesma outbox | `test/integration/outbox.test.ts` |
| 1. a mesma aposta 50 vezes em paralelo | `test/concurrency/same-wallet.test.ts` |
| 2. operações disputando o saldo (cenário da seção 8) | `test/concurrency/same-wallet.test.ts` |
| 3. wallets distintas em paralelo | `test/concurrency/parallel-wallets.test.ts` |
| 4. ≥ 3 processos simultâneos | `test/concurrency/multi-instance.test.ts` (processos `bun run src/main.ts` separados) |
| 5. worker morto depois do commit e antes do ack | `test/concurrency/multi-instance.test.ts` (SIGKILL real) |
| 6. dois publishers na mesma outbox | `test/integration/outbox.test.ts`, mais o publisher morto em `multi-instance.test.ts` |
| 7. REFUND ou ROLLBACK antes da referência | `test/integration/pending-references.test.ts` |
| 8. reinício com consistência final | `test/concurrency/multi-instance.test.ts` (SIGKILL no meio da carga, SIGTERM gracioso) |
| invariante final `wallet.balance == ledger` | `test/support/ledger-invariant.ts`, chamado em todos os testes de integração e concorrência |

Nenhum teste de integração usa mock de PostgreSQL ou SQS: todos rodam contra os containers reais.

---

## 5. Interpretações adotadas

Pontos em que o enunciado admite mais de uma leitura, e a leitura escolhida:

- **Escala do `amount` na entrada:** o desafio diz "escala fixa de 2 casas" e também manda rejeitar "mais de 2 casas decimais", o que sugere que menos casas são aceitáveis. Aceitamos de 0 a 2 casas e normalizamos para 2 (`"25.5"` vira `"25.50"`). A resposta sempre sai com 2 casas, e o `payloadHash` usa o valor normalizado, então `"25.5"` e `"25.50"` são o mesmo pedido.
- **Uma única reversão por referência, de qualquer tipo:** a regra 4 da seção 7 diz "uma referência não pode ser revertida duas vezes **pelo mesmo tipo** de operação". Lida ao pé da letra, ela permite um REFUND **e** um ROLLBACK da mesma BET, o que devolveria o valor duas vezes e quebraria o invariante global "não duplicar créditos". Adotei a leitura mais restrita: depois de qualquer reversão processada, uma nova tentativa recebe `ALREADY_REVERSED`. Fazer o ROLLBACK de um REFUND também não torna a BET reversível de novo.
- **WIN e LOSS podem referenciar a BET:** o enunciado diz que o WIN "pode referenciar" a BET. Quando a referência vem, ela é validada como qualquer outra (precisa ser uma BET da mesma rodada) e, se ainda não chegou, a transação espera em `PENDING_REFERENCE`. Apliquei a mesma regra ao LOSS. Uma BET com referência é payload inválido.
- **Valores por tipo:** BET, WIN, REFUND e ROLLBACK exigem valor maior que zero. Um "WIN de zero" deve ser enviado como LOSS, que aceita valor maior ou igual a zero e nunca move saldo.
- **Referência que falhou:** se a referência terminou `REJECTED` ou `FAILED`, a transação dependente é rejeitada na hora com `REFERENCE_NOT_PROCESSED`, sem esperar: a referência nunca vai mudar de estado.
- **`aggregateId` dos eventos:** todos os eventos usam a `walletId` como `aggregateId`, inclusive os de transação. A wallet é a unidade de consistência (seção 8), então os consumidores podem particionar e ordenar por ela. O `transactionId` vai dentro de `data`.

- **Replay de uma transação que estava pendente:** o replay devolve o estado gravado *agora*. Antes da resolução, ele repete o 202 `PENDING_REFERENCE`; depois que o worker resolve, devolve o estado final (`PROCESSED` ou `REJECTED`), com o saldo observado na resolução.
- **Wallet inexistente:** 404 `WALLET_NOT_FOUND`, sem gravar nada. A transação não pode existir sem a sua wallet (FK). Pela fila, vai direto para a DLQ como erro permanente.
- **`FAILED` no HTTP:** 422 com `PERMANENT_PROCESSING_ERROR`. É terminal e não adianta reenviar.
- **OPENING emite eventos:** `WalletBalanceChanged` e `WagerTransactionProcessed`, porque é uma transação aplicada que muda o saldo.
- **Mensagem SQS:** a deduplicação usa o `messageId` do envelope (seção 10), não o `MessageId` técnico do SQS, que muda a cada reenvio do produtor.

---

## 6. Autenticação

Não implementada, como o desafio permite (seção 2). A autenticação não vale pontos e competiria em tempo com correção financeira, concorrência e idempotência, então preferi deixar o ponto de extensão no código e o desenho documentado.

- **Ponto de extensão:** `ProviderAuthGuard` (`src/interfaces/http/provider-auth.guard.ts`), aplicado aos controllers de wallet e de transação. Hoje deixa tudo passar. Os endpoints de health e `/metrics` não usam o guard.
- **Desenho que eu adotaria:**
  - Keycloak no Docker Compose, com um client por provedor no fluxo *client credentials* (máquina para máquina, sem usuário).
  - O guard valida o JWT (assinatura pela JWKS do IdP, `exp`, `aud`) e lê o `providerId` de um claim.
  - Se o `providerId` do corpo for diferente do token, a resposta é 403. Isso impede um provedor de operar transações em nome de outro.
- **Fila:** é um canal interno confiável, sem token. Mesmo assim, o `providerId` da mensagem passa pelas mesmas validações de domínio (referência do mesmo provedor, unicidade por provedor).

---

## 7. Limitações e próximos passos

O que eu sei que não está ideal, e o que faria em seguida:

- **Hot wallet:** o lock por wallet serializa as operações de uma mesma wallet. Para wallets disputadíssimas, o próximo passo seria particionar o processamento por `walletId` (por exemplo, um consumer por partição) para reduzir a espera no lock.
- **Worker de referências sem "claim":** várias instâncias podem examinar o mesmo candidato. É correto (lock e releitura), mas desperdiça trabalho. Próximo passo: reservar candidatos com `FOR UPDATE SKIP LOCKED` ou com um lease.
- **Ordem dos eventos entre publishers é best-effort**, e os consumidores devem usar o `walletVersion` (D10).
- **Eventos emitidos pelo worker** usam o id da transação como `correlationId`, porque o `correlationId` original não é persistido. Próximo passo: guardar a coluna.
- **Reconciliação carrega todos os lançamentos da wallet em memória.** Para wallets enormes: agregação em SQL ou checkpoints de saldo periódicos.
- **Queda longa do banco:** cada entrega falha conta no `maxReceiveCount`, e as mensagens acabam na DLQ. Próximo passo: pausar o consumo enquanto o readiness estiver `down`, e ter um procedimento de redrive da DLQ.
- **Readiness depende do SQS**, porque o enunciado pede (D4).
- **MiniStack guarda as filas em memória** (D1).
- **Requisição para wallet inexistente** responde 404 e não é persistida (a FK impede), então não é "replayável" como uma rejeição.
- **Ponto de injeção de falha** (`FAULT_INJECTION`) existe só para os testes de crash. Ele é validado por enum, com padrão `none`; em produção, eu o removeria do build.
- **Teste de carga** (diferencial opcional) não foi feito por falta de tempo.
- **Autenticação** não implementada (seção 6).
