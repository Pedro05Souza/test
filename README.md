# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
enviadas por provedores de jogos via **HTTP** e **AWS SQS**. Permanece correto com entregas duplicadas,
fora de ordem e simultâneas, com múltiplas instâncias e com crashes.

**Stack:** Bun 1.4 · TypeScript (strict) · NestJS 12 · PostgreSQL 17 · MikroORM 7 · AWS SQS via
MiniStack · Docker Compose · zod · pino · prom-client.

Decisões de design, trade-offs e limitações: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Requisitos

* Docker com Compose v2
* [Bun](https://bun.sh) ≥ 1.4 (`curl -fsSL https://bun.sh/install | bash`) — necessário apenas para rodar os testes ou a aplicação fora do Docker

 o MiniStack emula o SQS localmente na porta 4566.

## Início rápido — stack completa (3 réplicas)

```bash
bun install
bun run stack:up          # postgres, ministack, criação das filas, migrations, 3 réplicas da app
curl localhost:3000/health/ready
```

As réplicas escutam em **http://localhost:3000**, **:3001** e **:3002**. Elas compartilham o PostgreSQL e
as filas; cada uma roda a API HTTP, o consumidor SQS, o publisher da outbox e o worker de pending-reference.

```bash
bun run stack:down        # parar (SIGTERM → drenagem graciosa)
bun run infra:down        # parar tudo e apagar os volumes
```

## Rodando os testes

Os testes precisam do PostgreSQL e do MiniStack, mas **não** das réplicas da app (o publisher da outbox de
uma réplica em execução competiria com os publishers dos próprios testes):

```bash
bun install
bun run infra:up          # postgres + ministack + criação das filas (sem réplicas da app)
bun run migrate:up        # opcional: os testes também aplicam as migrations
bun test                  # tudo (~60 s)
```

| Comando | O quê |
|---|---|
| `bun run test:unit` | regras de domínio, Money, políticas, logger (não precisa de Docker) |
| `bun run test:integration` | PostgreSQL real + SQS real: constraints do schema, migrations, atomicidade, API HTTP, consumidor, outbox, pending references |
| `bun run test:concurrency` | paralelismo real: corridas no mesmo processo e **múltiplos processos do SO** com injeção de crash e reinícios |
| `bun run typecheck` | `tsc --noEmit` |

Se a stack completa estiver rodando, pare as réplicas antes: `docker compose stop app`.

## Rodando a app localmente (sem Docker para a app)

```bash
bun run infra:up
bun run migrate:up
bun run dev               # http://localhost:3000, com hot reload
```

## Experimente

```bash
# 1. abrir uma wallet (crédito OPENING + lançamento no ledger na mesma transação)
curl -s -XPOST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# → 201 {"id":"<walletId>","playerId":"player-1","balance":{"amount":"100.00","currency":"BRL"},"version":1}

W=<walletId>

# 2. fazer uma aposta (envie duas vezes: a segunda é replay, 200 + idempotentReplay:true)
curl -s -XPOST localhost:3001/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1","walletId":"'$W'",
       "roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
# → 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false}

# 3. a mesma operação via SQS (consumida por qualquer réplica)
bun run send:wager $W player-1 BET 5.00

# 4. inspecionar
curl -s localhost:3002/wallets/$W
curl -s "localhost:3002/wallets/$W/ledger?limit=50"
curl -s -XPOST localhost:3002/wallets/$W/reconciliation
curl -s localhost:3000/metrics | grep wagering_
```

## API

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | abre uma wallet (`409` se o jogador já tem uma nessa moeda) |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | lançamentos do ledger, mais antigos primeiro, cursor opaco e estável (`limit` 1–200, padrão 50) |
| `POST /wallets/:walletId/reconciliation` | saldo armazenado vs. derivado do ledger; divergência sinalizada, nunca corrigida automaticamente |
| `POST /wagering/transactions` | submete uma transação; header `Idempotency-Key` obrigatório |
| `GET /wagering/transactions/:transactionId` | transação pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness / readiness (PostgreSQL + SQS); sem autenticação |
| `GET /metrics` | métricas Prometheus |

Status: `201` processada (`200` em replay) · `202` aguardando referência · `422` rejeição de negócio
(`failureCode`, `providerAction`) · `400` entrada inválida · `404` não encontrado · `409` conflito de
idempotência / wallet duplicada · `503` transitório (reenvie a requisição idêntica). Detalhes em
[ARCHITECTURE.md §8](ARCHITECTURE.md#8-mapeamento-de-status-http-consistente-em-todos-os-endpoints).

### Mensagem SQS (`wager-transactions.fifo`)

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a", "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "…", "walletId": "…", "roundId": "round-987", "gameId": "fortune-chimp",
    "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Use o id da wallet como `MessageGroupId`. Falhas permanentes vão para `wager-transactions-dlq.fifo` com o
atributo `reason`; os eventos de integração são publicados em `wagering-events.fifo`.

## Configuração

| Variável | Padrão | Finalidade |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | PostgreSQL |
| `DB_POOL_MAX` | `20` | tamanho do pool de conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima pelo lock da linha da wallet (depois 503 / retry no SQS) |
| `RUN_MIGRATIONS` | `false` | aplica as migrations na inicialização (o Compose usa um serviço `migrate` dedicado) |
| `SQS_ENDPOINT` / `AWS_REGION` | `http://localhost:4566` / `us-east-1` | endpoint do SQS |
| `SQS_WAGER_QUEUE` / `SQS_WAGER_DLQ` / `SQS_EVENTS_QUEUE` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wagering-events.fifo` | nomes das filas |
| `SQS_MAX_RECEIVE_COUNT` | `5` | recebimentos antes do redrive para a DLQ (deve coincidir com a fila) |
| `SQS_WAIT_SECONDS` | `10` | duração do long poll |
| `SQS_RETRY_BASE_DELAY_SECONDS` / `SQS_RETRY_MAX_DELAY_SECONDS` | `2` / `300` | backoff de visibilidade para falhas transitórias |
| `SQS_CONSUMER_ENABLED` | `true` | roda o consumidor SQS |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | roda o publisher da outbox |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_LEASE_MS` / `OUTBOX_IDLE_POLL_MS` | `50` / `30000` / `250` | ajuste do relay da outbox |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | roda o worker de pending-reference |
| `PENDING_REFERENCE_POLL_MS` | `500` | intervalo do worker quando ocioso |
| `REFERENCE_MAX_ATTEMPTS` / `REFERENCE_BASE_DELAY_MS` / `REFERENCE_MAX_DELAY_MS` | `10` / `2000` / `300000` | política de retry de referências fora de ordem |
| `SHUTDOWN_GRACE_MS` | `15000` | tempo de drenagem no SIGTERM |
| `LOG_LEVEL` | `info` | nível do pino (`silent` nos testes) |

## Estrutura do projeto

```
src/
  shared/        domain (Money, erros, IntegrationEvent), portas e erros da application,
                 infrastructure (unit of work MikroORM, config, logger, métricas, polling loop), http (filter, zod pipe, auth guard)
  wallet/        domain (Wallet, WalletLedgerEntry) · application (OpenWallet, WalletQueries) · infrastructure · http
  wagering/      domain (WagerTransaction, WagerSettlement, códigos de falha, eventos) · application (ProcessWagerTransaction,
                 ResolvePendingReferences, settleAndRecord) · infrastructure · http · sqs (consumidor)
  messaging/     domain (InboxMessage, OutboxMessage) · application (OutboxRelay) · infrastructure (outbox store, publisher SQS)
  health/        controllers de health e métricas
migrations/      migrations SQL versionadas e reversíveis (constraints, triggers, índices)
scripts/         migrate, create-queues, send-wager-message
test/            unit · integration · concurrency (inclui multi-processo) · support
```
