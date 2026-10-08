# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por HTTP ou SQS. Ele continua correto com mensagens duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo.

- Enunciado do desafio: [docs/DESAFIO.md](docs/DESAFIO.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)

## Pré-requisitos

- Docker com Compose v2
- [Bun](https://bun.sh) 1.4+ (só para rodar testes e scripts fora do Docker)

## Subindo tudo

```bash
docker compose up --build              # Postgres, MiniStack (SQS), setup (filas e migrations) e app
curl localhost:3000/health/ready
```

Várias instâncias da aplicação:

```bash
docker compose up --build --scale app=3   # portas 3000, 3001 e 3002
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun install` | instala as dependências |
| `bun run typecheck` | checagem de tipos (TypeScript estrito) |
| `bun run migration:up` / `migration:down` / `migration:status` | aplica, reverte uma, mostra o estado |
| `bun run sqs:setup` | cria as filas (idempotente) |
| `bun run test` | testes de unidade (rápidos, sem Docker) |
| `bun run test:integration` | integração e concorrência contra Postgres e MiniStack reais |

## Portas e variáveis

Os defaults ficam em [src/infrastructure/config/env.ts](src/infrastructure/config/env.ts) e batem com o `docker-compose.yml`. Se alguma porta já estiver em uso na sua máquina, crie um `.env` (ignorado pelo git; o Compose e o Bun leem automaticamente). Por exemplo:

```bash
POSTGRES_HOST_PORT=5435
DATABASE_URL=postgres://wagering:wagering@localhost:5435/wagering
```
