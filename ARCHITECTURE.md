# Arquitetura — Distributed Wagering Processor

Este documento registra **as decisões, os trade-offs e as limitações** da solução. Setup e comandos ficam no [README.md](README.md).

## 1. Visão geral

O provedor manda transações por HTTP ou pela fila wager-transactions.fifo. Os dois caminhos chamam o mesmo use case, que grava tudo numa única transação no Postgres: saldo, ledger, inbox e o evento na outbox. Depois, um worker publica os eventos da outbox na fila de eventos, e outro reprocessa as transações que chegaram antes da referência.

Princípio central: **o PostgreSQL é a fonte da verdade para todas as invariantes.** Os recursos do SQS (FIFO, deduplicação) são otimização, nunca garantia.

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

<!-- Próximas decisões, preenchidas a cada bloco:
     D6 ORM e mapeamento domínio ↔ persistência
     D7 Estratégia de concorrência
     D8 Idempotência e payloadHash
     D9 Referências fora de ordem
     D10 Transactional outbox
     D11 Inbox e classificação de erros do consumer
     D12 Mapeamento de status HTTP
-->

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
| Dinheiro nunca é `number` | `Money` com `bigint` de centavos | | `test/unit/domain/money.test.ts` |
| Saldo nunca negativo | `Wallet.debit` lança `InsufficientFundsError`; `WalletLedgerEntry` recusa saldo final negativo | | `test/unit/domain/wallet.test.ts`, `apply-wager-transaction.test.ts` |
| Uma wallet por `playerId` + `currency` | | | |
| Toda alteração de saldo tem um lançamento no ledger | `debit` e `credit` são o único jeito de mudar o saldo, e ambos devolvem o lançamento | | `test/unit/domain/wallet.test.ts` ("the ledger rebuilds the balance") |
| Ledger imutável (sem UPDATE/DELETE) | `WalletLedgerEntry`: campos `readonly` e `Object.freeze`, sem métodos de transição | | `test/unit/domain/wallet-ledger-entry.test.ts` |
| No máximo um lançamento por transação por wallet | `applyWagerTransaction` recusa uma transação que já está em estado terminal | | `test/unit/domain/apply-wager-transaction.test.ts` |
| Operação idempotente (sem débito ou crédito duplicado) | | | |
| Mesma key com payload diferente gera conflito | `payloadHash` canônico e `matchesPayload` | | `test/unit/domain/payload-hash.test.ts` |
| Referência revertida no máximo uma vez | `ALREADY_REVERSED` quando a referência já tem uma reversão processada | | `test/unit/domain/apply-wager-transaction.test.ts` |
| Sem lost update entre instâncias | | | |
| Evento publicado só depois do commit | | | |
| `wallet.balance == saldo reconstruído pelo ledger` | cada lançamento guarda saldo antes e depois e a versão da wallet | | `test/unit/domain/wallet.test.ts` ("the ledger rebuilds the balance") |

---

## 5. Interpretações adotadas

Pontos em que o enunciado admite mais de uma leitura, e a leitura escolhida:

- **Escala do `amount` na entrada:** o desafio diz "escala fixa de 2 casas" e também manda rejeitar "mais de 2 casas decimais", o que sugere que menos casas são aceitáveis. Aceitamos de 0 a 2 casas e normalizamos para 2 (`"25.5"` vira `"25.50"`). A resposta sempre sai com 2 casas, e o `payloadHash` usa o valor normalizado, então `"25.5"` e `"25.50"` são o mesmo pedido.
- **Uma única reversão por referência, de qualquer tipo:** a regra 4 da seção 7 diz "uma referência não pode ser revertida duas vezes **pelo mesmo tipo** de operação". Lida ao pé da letra, ela permite um REFUND **e** um ROLLBACK da mesma BET, o que devolveria o valor duas vezes e quebraria o invariante global "não duplicar créditos". Adotei a leitura mais restrita: depois de qualquer reversão processada, uma nova tentativa recebe `ALREADY_REVERSED`. Fazer o ROLLBACK de um REFUND também não torna a BET reversível de novo.
- **WIN e LOSS podem referenciar a BET:** o enunciado diz que o WIN "pode referenciar" a BET. Quando a referência vem, ela é validada como qualquer outra (precisa ser uma BET da mesma rodada) e, se ainda não chegou, a transação espera em `PENDING_REFERENCE`. Apliquei a mesma regra ao LOSS. Uma BET com referência é payload inválido.
- **Valores por tipo:** BET, WIN, REFUND e ROLLBACK exigem valor maior que zero. Um "WIN de zero" deve ser enviado como LOSS, que aceita valor maior ou igual a zero e nunca move saldo.
- **Referência que falhou:** se a referência terminou `REJECTED` ou `FAILED`, a transação dependente é rejeitada na hora com `REFERENCE_NOT_PROCESSED`, sem esperar: a referência nunca vai mudar de estado.
- **`aggregateId` dos eventos:** todos os eventos usam a `walletId` como `aggregateId`, inclusive os de transação. A wallet é a unidade de consistência (seção 8), então os consumidores podem particionar e ordenar por ela. O `transactionId` vai dentro de `data`.

<!-- Preencher conforme as regras forem implementadas. -->

---

## 6. Autenticação

Não implementada, como o desafio permite (seção 2 do README). <!-- Detalhar o desenho com IdP e o ponto de extensão quando ele existir no código. -->

---

## 7. Limitações e próximos passos

<!-- Preencher no dia 3, com honestidade. -->
