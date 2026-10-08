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

## 3. Invariantes: onde cada uma é garantida

Cada invariante é garantida **em duas camadas** (domínio e banco) e **provada por um teste**.

| Invariante | Domínio | Banco (schema) | Teste |
|---|---|---|---|
| Dinheiro nunca é `number` | `Money` com `bigint` de centavos | | `test/unit/domain/money.test.ts` |
| Saldo nunca negativo | | | |
| Uma wallet por `playerId` + `currency` | | | |
| Toda alteração de saldo tem um lançamento no ledger | | | |
| Ledger imutável (sem UPDATE/DELETE) | `WalletLedgerEntry`: campos `readonly` e `Object.freeze`, sem métodos de transição | | `test/unit/domain/wallet-ledger-entry.test.ts` |
| No máximo um lançamento por transação por wallet | | | |
| Operação idempotente (sem débito ou crédito duplicado) | | | |
| Mesma key com payload diferente gera conflito | | | |
| Referência revertida no máximo uma vez | | | |
| Sem lost update entre instâncias | | | |
| Evento publicado só depois do commit | | | |
| `wallet.balance == saldo reconstruído pelo ledger` | | | |

---

## 4. Interpretações adotadas

Pontos em que o enunciado admite mais de uma leitura, e a leitura escolhida:

- **Escala do `amount` na entrada:** o desafio diz "escala fixa de 2 casas" e também manda rejeitar "mais de 2 casas decimais", o que sugere que menos casas são aceitáveis. Aceitamos de 0 a 2 casas e normalizamos para 2 (`"25.5"` vira `"25.50"`). A resposta sempre sai com 2 casas, e o `payloadHash` usa o valor normalizado, então `"25.5"` e `"25.50"` são o mesmo pedido.

<!-- Preencher conforme as regras forem implementadas. -->

---

## 5. Autenticação

Não implementada, como o desafio permite (seção 2 do README). <!-- Detalhar o desenho com IdP e o ponto de extensão quando ele existir no código. -->

---

## 6. Limitações e próximos passos

<!-- Preencher no dia 3, com honestidade. -->
