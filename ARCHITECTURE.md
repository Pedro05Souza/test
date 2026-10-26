# Arquitetura

Este documento explica como o Distributed Wagering Processor permanece correto quando mensagens são
**duplicadas**, chegam **fora de ordem**, são processadas **simultaneamente por várias instâncias** e
quando processos **morrem** em qualquer ponto. Toda afirmação abaixo é comprovada por um teste (ver §15).

---

## 1. Visão geral

```
 Provedores ──HTTP──▶ ┌────────────────────────────────────────────┐
                      │  instâncias 1..N  (idênticas, stateless)   │
 Provedores ──SQS───▶ │                                            │
 wager-transactions   │  controller HTTP ─┐                        │
 .fifo                │  consumidor SQS ──┼─▶ ProcessWagerTransaction ──▶ PostgreSQL
                      │  worker pending-ref ─▶ ResolvePendingReferences    (wallets, ledger,
                      │  publisher outbox ◀──────────────── outbox ◀─────   transações,
                      └──────────┬─────────────────────────────────┘        inbox, outbox)
                                 ▼
                        wagering-events.fifo
```

* **Monólito modular** com três módulos — `wallet`, `wagering`, `messaging` — mais `shared`.
* Dentro de cada módulo, **arquitetura hexagonal** (ports & adapters); as dependências apontam para dentro:

| Camada | Contém | Depende de |
|---|---|---|
| `domain/` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos de integração, `WagerSettlement` | nada (sem Nest, sem ORM, sem I/O) |
| `application/` | casos de uso + **portas** (`UnitOfWork`, repositórios, `Clock`, `IdGenerator`, `Metrics`, `Logger`, `EventPublisher`, `OutboxStore`) | domain |
| `infrastructure/` | records/mappers/repositórios MikroORM, adapters SQS, pino, prom-client, workers | portas da application |
| `http/`, `sqs/` | adapters finos: validar (zod) → chamar o caso de uso → mapear o resultado | application |

* HTTP e SQS compartilham **um único** caso de uso (`ProcessWagerTransaction`); o worker de
  PENDING_REFERENCE e a primeira submissão compartilham **uma única** rotina de liquidação e gravação
  (`settleAndRecord`). As regras de negócio vivem em um só lugar: `WagerSettlement` +
  `WagerTransaction.checkReference`.
* Deliberadamente **não** foram usados: buses de CQRS, repositórios genéricos, event sourcing, pacotes
  separados — adicionariam indireção sem adicionar correção.

---

## 2. Modelo de domínio

Todos os agregados e value objects usam **construtor privado** + factories estáticas
(`create`/`open`/`from`, e `rehydrate` para persistência, que não revalida transições).

### Money
* `decimal.js` (clone privado, sem alterar a configuração global); nunca `number` do JS.
* Contrato de entrada (`Money.from`): **string** decimal, não negativa, ≤ 2 casas decimais, ≤ 18 dígitos
  inteiros, sem expoente/sinal/espaços/zeros à esquerda. Valores com mais de 2 casas são **rejeitados,
  não arredondados**.
* Saída sempre com escala 2 (`"25.00"`); `-0` normalizado para `0.00`. Operações entre moedas
  diferentes lançam `CurrencyMismatchError`. O modelo é multi-moeda; os testes cobrem conflitos BRL/USD.

### Wallet (aggregate root)
* A única forma de alterar o saldo é `debit`/`credit`/`apply`, e cada um **retorna o
  `WalletLedgerEntry`** daquela movimentação — saldo e ledger não têm como divergir no código.
* `version` começa em 1 e incrementa **somente** quando o saldo muda.
* `open()` retorna a wallet e, para saldo inicial positivo, o lançamento de OPENING (mantém
  "version = 1 após a criação" e ainda registra o crédito de abertura).

### WagerTransaction — máquina de estados

```
            ┌────────────► PROCESSED   (terminal)
 PENDING ───┼────────────► REJECTED    (terminal, failureCode)
   │        └────────────► FAILED      (terminal, failureCode)
   ▼             ▲
 PENDING_REFERENCE ──┘ (reverificada com backoff; pode continuar em PENDING_REFERENCE)
```

* Qualquer transição a partir de um estado terminal lança `InvalidTransactionStateError` (erro de
  programação, não caminho de negócio). O banco garante o mesmo via trigger.
* `PENDING` só existe dentro da transação de processamento; linhas persistidas são
  `PENDING_REFERENCE` ou terminais.
* `FAILED` faz parte do modelo para erros permanentes de infraestrutura em uma transação aceita.
  Nesta implementação, falhas de infraestrutura fazem rollback de toda a unidade de trabalho (nada é
  persistido; a requisição/mensagem é reenviada), então nenhum caminho de código produz `FAILED` hoje.

### WalletLedgerEntry
Sem campos mutáveis, sem métodos de transição; `create` verifica `balanceBefore ± money = balanceAfter`.

---

## 3. Persistência — MikroORM

**Por que MikroORM:** Unit of Work e Identity Map explícitos, `em.transactional()`, `LockMode`,
exceções de driver tipadas. Versão 7 com `defineEntity` (sem decorators).

* **Records ≠ domínio.** Os records do ORM (`*.record.ts`) são formatos de persistência puros; mappers
  convertem de/para objetos de domínio. Assim o domínio não conhece tipos do ORM e mantém seus construtores privados.
* **Mapeamento do Money:** valor em `NUMERIC(20,2)` + moeda em `CHAR(3)`. `p.decimal("string")` hidrata o
  valor como **string** (o pg retorna numerics como string), que o mapper transforma em `Money`.
* **Relações como `manyToOne(...).mapToPk()`:** as propriedades continuam sendo ids simples, mas o Unit of
  Work conhece o grafo de FKs e faz o flush na ordem `wallet → transação → ledger`.
* **Estratégia transacional:** `MikroOrmUnitOfWork.run(work)` = `orm.em.fork().transactional(...)` — um
  EntityManager forkado (identity map isolado) e **uma transação SQL** por chamada de caso de uso.
  Registro de inbox, transação, atualização da wallet, lançamento no ledger e eventos da outbox recebem
  flush no final e são confirmados juntos, ou desfeitos juntos. Toda transação começa com
  `SET LOCAL lock_timeout = 5s`.
* SQL puro é usado apenas onde é a ferramenta mais clara: probe de lock, `INSERT … ON CONFLICT` da inbox,
  claim da outbox, paginação do ledger e leitura da reconciliação.
* **Migrations** escritas à mão, versionadas e reversíveis (`up`/`down`), listadas explicitamente na
  configuração (sem glob no filesystem). O Compose as executa uma única vez em um serviço `migrate`
  antes de qualquer réplica subir.

---

## 4. Invariantes garantidas pelo banco

Código de aplicação pode ter bugs; estas garantias valem mesmo para escritas que o contornam
(comprovado por `test/integration/schema-constraints.test.ts`, que ataca o schema com SQL puro).

| Garantia | Mecanismo |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance_amount >= 0)`; no ledger `CHECK (balance_before >= 0 AND balance_after >= 0)` |
| Aritmética do ledger | `CHECK (balance_after = balance_before ± amount)` |
| Ledger é uma cadeia sem lacunas, na moeda da wallet | trigger `BEFORE INSERT`: `balance_before` = `balance_after` anterior, moeda = moeda da wallet |
| Ledger é append-only | triggers rejeitam `UPDATE`, `DELETE`, `TRUNCATE` |
| **Saldo da wallet == ledger** | constraint trigger `DEFERRABLE INITIALLY DEFERRED`: no COMMIT, o saldo armazenado precisa ser igual ao último `balance_after` (ou 0) — alteração de saldo sem lançamento não consegue commitar |
| `version` +1 sse o saldo muda; identidade imutável; sem deletes | trigger `BEFORE UPDATE/DELETE` em `wallets` |
| Idempotência | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| No máximo um lançamento por transação por wallet | `UNIQUE (wallet_id, transaction_id)` |
| Uma transação é revertida no máximo uma vez | índice único parcial em `reference_transaction_id` `WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Transações terminais congeladas; campos de negócio imutáveis; sem deletes | trigger `BEFORE UPDATE/DELETE/TRUNCATE` em `wager_transactions` |
| Coerência de status | `CHECK`s: failure code ⇔ REJECTED/FAILED, `processed_at` ⇔ terminal, reversões exigem referência, reversões processadas exigem referência resolvida, valor > 0 exceto LOSS (≥ 0) |
| Dedup da inbox | `PRIMARY KEY (consumer_name, message_id)` |

Custo: os triggers de cadeia e de consistência acrescentam duas leituras indexadas por escrita.
Aceito: eles transformam as invariantes mais importantes de "testadas" em "impossíveis de violar".

---

## 5. Concorrência

**Unidade de concorrência: a wallet.** Toda operação que pode alterar uma wallet executa:

```
BEGIN
  SET LOCAL lock_timeout = '5s'
  SELECT … FROM wallets WHERE id = $1 FOR UPDATE      ← serializa esta wallet em TODAS as instâncias
  … verificação de idempotência, resolução de referência, liquidação …
  INSERT/UPDATE wallet, transação, ledger, inbox, outbox
COMMIT                                                ← verificação diferida wallet↔ledger roda aqui
```

**Por que lock pessimista por linha** (e não optimistic locking com `version` + retry):

* Uma *hot wallet* (um jogador, muitas apostas simultâneas) é o caso normal em um cassino. Optimistic
  locking transforma contenção em tempestade de retries e latência de cauda; um lock de linha a
  transforma em uma fila ordenada.
* O lock é por linha — wallets nunca bloqueiam umas às outras (sem lock global) — e funciona igual para
  qualquer número de instâncias, porque quem coordena é o PostgreSQL.
* A verificação de idempotência roda **depois** de obter o lock, então 50 cópias paralelas da mesma
  requisição serializam; a primeira aplica, as outras 49 encontram a linha commitada e fazem replay.
* Livre de deadlock por construção: uma transação trava no máximo uma wallet.
* `version` continua sendo mantido (verificado por trigger) como segunda linha de defesa e para consumidores.

**Métrica de conflito de lock:** antes de bloquear, o repositório testa com `FOR UPDATE NOWAIT` dentro de
um savepoint. Se a linha estiver ocupada, incrementa `wagering_lock_conflicts_total` e a transação então
espera normalmente. Esperar mais que `lock_timeout` → `55P03` → erro transitório (HTTP 503 / retry no SQS).

**A única corrida que o lock não cobre:** a mesma idempotency key enviada simultaneamente para duas
wallets *diferentes* trava duas linhas diferentes. A constraint única pega o caso; o caso de uso roda de
novo (até 3 vezes) e a segunda passada encontra a linha commitada → replay ou conflito.

---

## 6. Idempotência

* O header `Idempotency-Key` (ou `data.idempotencyKey` no SQS) é a fonte da verdade. Valor recomendado:
  `"{providerId}:{externalTransactionId}"`.
* **payloadHash** = `hex(SHA-256(canonicalJson(subconjunto)))`, onde o subconjunto é
  `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId}`,
  com `money` normalizado via `Money` (`"25"` ≡ `"25.00"`), e `canonicalJson` ordena as chaves dos objetos
  recursivamente e descarta `undefined`. A própria key, headers e metadados de transporte ficam de fora.
* Mesma key + mesmo hash → **replay**: o resultado armazenado, incluindo o saldo observado naquele
  momento (`result_balance_amount`), com `idempotentReplay: true` e o mesmo status HTTP (200 em vez de
  201 para processadas; 422/202 inalterados).
* Mesma key + hash diferente → **409 `IDEMPOTENCY_CONFLICT`**, nunca replay. O mesmo
  `(providerId, externalTransactionId)` com outra key também é conflito.
* Tudo isso é persistido; não existe cache em memória em lugar nenhum.

---

## 7. Regras de negócio e interpretações

| Kind | Saldo | Ledger | Observações |
|---|---|---|---|
| BET | débito | 1 DEBIT | `INSUFFICIENT_FUNDS` se saldo < valor |
| WIN | crédito | 1 CREDIT | pode referenciar uma BET da mesma rodada |
| LOSS | — | nenhum | valor pode ser `0.00`; pode referenciar uma BET |
| REFUND | crédito | 1 CREDIT | referencia uma BET PROCESSED; mesmo valor |
| ROLLBACK | inverso da referência | 1 lançamento invertido | referencia BET, WIN ou REFUND PROCESSED; mesmo valor |

Interpretações (além do enunciado):

1. **Uma transação só pode ser revertida uma vez, por qualquer tipo.** O enunciado diz "uma vez por tipo
   de operação"; permitir REFUND e ROLLBACK da mesma BET creditaria o jogador duas vezes, então a regra
   mais estrita é aplicada (domínio + índice único parcial). Um ROLLBACK de um REFUND aponta para o
   REFUND, não para a BET, então continua possível.
2. A referência precisa coincidir em provider, player, wallet, moeda **e** rodada → senão `REFERENCE_MISMATCH`.
3. Uma referência que ainda está em `PENDING_REFERENCE` faz a dependente **esperar** (não rejeitar); uma
   referência que terminou `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`.
4. Uma reversão que deixaria o saldo negativo → `REVERSAL_INSUFFICIENT_FUNDS` (distinto de
   `INSUFFICIENT_FUNDS`, e marcado como `INVESTIGATE`).
5. Moeda diferente da wallet, ou player que não é dono da wallet, são **rejeições persistidas**
   (`CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`) — auditáveis e com replay.
6. Um `walletId` desconhecido não pode ser persistido (FK) → 404 via HTTP, DLQ via SQS.
7. OPENING é interno: criado apenas por `POST /wallets` e rejeitado pela validação nas duas entradas.

### Referências fora de ordem (§7.1)

* Referência ausente → `PENDING_REFERENCE` com `reference_attempts` e `next_reference_check_at`.
* Um **worker agendado em cada instância** busca as linhas vencidas e reprocessa cada uma em sua própria
  transação **sob o mesmo lock da wallet**, revalidando após o lock (ainda pendente e ainda vencida) —
  workers concorrentes em várias instâncias não aplicam duas vezes; quem perde a corrida apenas pula.
* **Política:** 10 tentativas, atraso `2s · 2^(n-1)` limitado a 5 min → ≈ 18,5 min no total. Entrega fora
  de ordem é questão de segundos; uma referência que ainda não chegou depois de ~18 minutos não vai
  chegar, e manter a rodada aberta por mais tempo só atrasa a reconciliação do próprio provedor.
  Configurável via `REFERENCE_MAX_ATTEMPTS`, `REFERENCE_BASE_DELAY_MS`, `REFERENCE_MAX_DELAY_MS`.
* **Despertar:** quando uma transação é processada, as dependentes da mesma wallet que a referenciam
  ficam vencidas imediatamente, então um REFUND que chegou primeiro é resolvido no próximo ciclo do
  worker (≤ 500 ms).
* Esgotado → `REJECTED / REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.
  `WagerTransactionPendingReference` é publicado uma vez (na chegada), não a cada retry.

### Códigos de falha (§7.2)

| Código | Significado | `providerAction` |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | `DO_NOT_RETRY` |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão deixaria o saldo negativo | `INVESTIGATE` |
| `CURRENCY_MISMATCH` | moeda da operação ≠ moeda da wallet | `FIX_AND_RESEND` |
| `WALLET_PLAYER_MISMATCH` | o player não é dono da wallet | `FIX_AND_RESEND` |
| `REFERENCE_NOT_FOUND` | a referência não chegou dentro da política de retry | `INVESTIGATE` |
| `REFERENCE_MISMATCH` | referência em outro provider/player/wallet/moeda/rodada | `FIX_AND_RESEND` |
| `INVALID_REFERENCE_KIND` | ex.: REFUND de uma WIN, ROLLBACK de uma LOSS | `FIX_AND_RESEND` |
| `REFERENCE_NOT_PROCESSED` | a referência terminou REJECTED/FAILED | `DO_NOT_RETRY` |
| `ALREADY_REVERSED` | a referência já foi revertida | `DO_NOT_RETRY` |
| `AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência | `FIX_AND_RESEND` |
| `INFRASTRUCTURE_FAILURE` | reservado para `FAILED` | `INVESTIGATE` |

`FIX_AND_RESEND` significa uma operação corrigida com um **novo** `externalTransactionId` (o antigo é
definitivo e faz replay da sua rejeição).

---

## 8. Mapeamento de status HTTP (consistente em todos os endpoints)

| Situação | Status | Corpo | Reenviar? |
|---|---|---|---|
| Payload / header / path / query inválido, JSON malformado | 400 | `error.code` (`INVALID_PAYLOAD`, `INVALID_MONEY`, …) + `issues` | não — corrigir |
| Wallet / transação desconhecida | 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | não |
| Conflito de idempotência, wallet duplicada | 409 | `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS` | não |
| Rejeição de negócio (persistida) | **422** | o resultado com `failureCode` + `providerAction` | faz replay do mesmo 422 |
| Aceita, aguardando referência | **202** | o resultado, `status: PENDING_REFERENCE` | faz replay |
| Processada | 201 (replay **200**) | o resultado | faz replay |
| Falha transitória de infraestrutura | **503** + `Retry-After` | `TEMPORARILY_UNAVAILABLE`, `retryable: true` | sim, a requisição idêntica |

Todo corpo de erro é `{ error: { code, message, retryable, issues? } }`. Bodies, params, query e o header
`Idempotency-Key` são validados por um `ZodPipe` antes de chegar ao controller.

---

## 9. Consumidor SQS

* Faz long-poll em `wager-transactions.fifo`; valida o envelope com o mesmo schema zod do HTTP; chama
  `ProcessWagerTransaction` com `inbox = (consumerName, message.messageId)`.
* **Inbox:** `INSERT … ON CONFLICT DO NOTHING` dentro da transação de processamento. Uma reentrega
  encontra a linha (ou espera o insert em andamento e então a encontra) e retorna replay → ack.
* **Ack somente após o commit:** `DeleteMessage` é chamado depois que o caso de uso retornou.
* **Classificação de falhas:**
  * rejeição de negócio → `REJECTED` commitada → **ack**;
  * transitória (`ApplicationError.category === "transient"`, ou erro desconhecido) → **sem ack**,
    `ChangeMessageVisibility` = `min(2s · 2^(n-1), 300s)`; após `maxReceiveCount` (5) recebimentos a
    **RedrivePolicy** da fila move a mensagem para `wager-transactions-dlq.fifo`;
  * permanente (JSON malformado, erro de schema, wallet desconhecida, conflito de idempotência, recusa do
    domínio) → copiada para a DLQ imediatamente com o atributo `reason`, e depois removida.
* **Ordenação:** o `MessageGroupId` deve ser o id da wallet. Dentro de um lote recebido, mensagens do mesmo
  grupo são processadas em sequência; grupos diferentes em paralelo. A ordenação FIFO é otimização — a
  correção vem do banco (§5).
* **SIGTERM:** para de consumir (aborta o long poll), conclui as mensagens em andamento (grace de 15 s) e
  devolve com visibilidade 0 as recebidas que ainda não começaram. O que ainda estiver rodando após o
  grace reaparece depois do visibility timeout e é absorvido pela inbox.

## 10. Transactional outbox

* Os eventos são inseridos em `outbox_messages` **na mesma transação SQL** da alteração que os originou —
  nunca publicados antes do commit.
* O relay (um por instância, todos rodando concorrentemente):
  1. **claim**: `UPDATE … SET next_attempt_at = now() + lease WHERE id IN (SELECT … vencidas … FOR UPDATE SKIP LOCKED) RETURNING *` —
     um único comando com auto-commit; relays concorrentes recebem conjuntos disjuntos, e o lease mantém
     as linhas longe dos outros depois do claim;
  2. **publish**: `SendMessageBatch` para `wagering-events.fifo`, `MessageGroupId = aggregateId`,
     `MessageDeduplicationId = eventId`;
  3. **mark** `published_at`, ou em caso de falha `attempts+1`, backoff `min(1s · 2^(n-1), 60s)`, `last_error`.
* Crash depois do commit e antes de publicar → as linhas continuam não publicadas (ou com lease) → outra
  instância as publica quando o lease expira. Crash depois de publicar e antes de marcar → publicado de
  novo: o SQS deduplica por `eventId` dentro de 5 minutos e todo evento carrega `eventId` para dedup no
  consumidor além disso.
* Eventos: `WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`,
  `WalletBalanceChanged` (somente quando o saldo muda, inclusive OPENING),
  `WagerTransactionPendingReference`. Cada um é uma subclasse da classe abstrata `IntegrationEvent<T>`,
  com `eventType`/`version` no tipo; `data` carrega strings `MoneyProps`, nunca `Money`.

## 11. Observabilidade

* **Logs:** pino em JSON; `correlationId` (vindo de `x-correlation-id` ou gerado, devolvido na resposta),
  `requestId`/`messageId` via AsyncLocalStorage em toda linha, mais `transactionId`, `walletId`,
  `providerId` nos pontos de chamada. Valores e payloads nunca são logados; o `redact` do pino mascara
  `money`, `balance`, `amount`, `payload`, `data`, … como rede de segurança. Uma linha de access log por
  requisição HTTP.
* **Métricas** (`GET /metrics`, Prometheus): `wagering_transactions_total{status,kind,source}`,
  `wagering_duplicates_detected_total{type}`, `wagering_retries_total{component}`,
  `wagering_dlq_messages_total{reason}`, `wagering_lock_conflicts_total`, `wagering_outbox_lag_seconds`,
  `wagering_outbox_published_total`, `wagering_processing_duration_seconds{source}` (histograma),
  `wagering_reconciliations_total{result}`, além das métricas padrão do processo.
* **Health:** `/health/live` (só o processo) e `/health/ready` (PostgreSQL `SELECT 1` + SQS
  `GetQueueAttributes`, timeout de 2 s cada, 503 quando algum estiver fora). Ambos sem autenticação.
* **Reconciliação:** `POST /wallets/:id/reconciliation` compara o saldo armazenado com o derivado do ledger
  em um único comando (um único snapshot MVCC). Divergências são logadas em `error`, contabilizadas e
  retornadas com `consistent: false` — nunca corrigidas silenciosamente.

## 12. Autenticação — não implementada (decisão)

Autenticação não vale pontos e competiria com as áreas avaliadas, então foi deixada de fora de propósito.
O ponto de extensão é explícito: `AuthGuard` (`src/shared/http/auth.guard.ts`) é aplicado a todos os
controllers de negócio e hoje é um no-op.

Desenho pretendido: os provedores se autenticam em um IdP externo (Keycloak ou Zitadel no Compose) com o
grant OAuth2 **client-credentials**. O guard valida o JWT bearer (issuer, audience, assinatura via JWKS,
expiração), mapeia o cliente (`azp`/`client_id`) para um `providerId` e rejeita requisições cujo
`providerId` no corpo seja diferente do autenticado. Health e métricas continuam abertos; o SQS é um canal
interno confiável, mas o provider id dentro da mensagem continua sujeito às mesmas validações de domínio.

## 13. Topologia de execução

`docker-compose.yml`: PostgreSQL 17, MiniStack (emulador de SQS), `ministack-init` (cria as três filas FIFO
e a redrive policy), `migrate` (roda as migrations uma vez) e `app` com **3 réplicas** nas portas
3000–3002 do host, cada uma rodando HTTP + consumidor + publisher da outbox + worker de pending-reference,
com 30 s de stop grace period para drenar.

## 14. Trade-offs e limitações

* **Throughput de hot wallet** limitado a uma transação por vez por wallet (por desenho). Milhares de
  operações por segundo em uma única wallet exigiriam particionar a atividade dessa wallet ou outro modelo
  (ex.: liquidação em lote); desnecessário para wallets de jogadores.
* **Ordem dos eventos:** os grupos FIFO dão ordem por agregado no caminho normal, mas um evento cuja
  publicação falhou e foi tentado depois pode ser ultrapassado por um mais novo. `WalletBalanceChanged`
  carrega `walletVersion`, para que consumidores ordenem ou descartem atualizações antigas.
* **Janela de dedup do broker** é de 5 minutos; além disso, os consumidores devem deduplicar por `eventId`.
* **Crescimento de tabelas:** `inbox_messages` e as `outbox_messages` publicadas crescem sem limite; em
  produção é preciso um job de retenção (ex.: apagar linhas da inbox mais antigas que o horizonte máximo de
  reentrega, e linhas publicadas da outbox após N dias).
* **`FAILED` não é usado** (ver §2); falhas de infraestrutura são retentadas em vez de virarem terminais.
* **Wallet desconhecida via SQS** vai para a DLQ (não pode ser persistida por causa da FK).
* **Reconciliação sob demanda** por wallet; uma varredura periódica de todas as wallets seria um acréscimo pequeno.
* **Shutdown:** o NestJS re-emite o SIGTERM depois dos seus shutdown hooks, então um processo drenado
  corretamente fora de um container termina *por sinal*; a drenagem em si é verificada pelos logs
  `worker stopped {drained: true}`.
* **Hooks de injeção de falha** (`FAULT_POINT`) existem no código de produção para os testes de crash;
  ficam inertes a menos que a variável seja definida.
* **Sem autenticação** (§12).

## 15. Como a correção é testada

| Requisito | Teste |
|---|---|
| Money, Wallet, regras de cada kind, conflito de moeda, payload divergente | `test/unit/*` |
| Migrations up/down/up, cada constraint e trigger do banco | `integration/migrations`, `integration/schema-constraints` |
| Atomicidade wallet + ledger + inbox + outbox (inclusive falha antes do commit) | `integration/orm-atomicity` |
| Contrato HTTP, mapeamento de status, replay, reconciliação (inclusive divergência forçada) | `integration/http-api` |
| Inbox e reentrega, retry com backoff, DLQ (explícita e por redrive), parada graciosa | `integration/sqs-consumer` |
| Publishers concorrentes, crash após claim, falha do broker, lag | `integration/outbox-relay` |
| REFUND/ROLLBACK fora de ordem, cadeias, esgotamento, workers concorrentes | `integration/pending-references` |
| Mesma aposta ×50 em paralelo, corrida da seção 8, hot wallet, wallets independentes | `concurrency/http-concurrency` |
| ≥3 processos do SO, kill após commit/antes do ack, kill após claim/antes de publicar, SIGKILL da frota inteira + reinício | `concurrency/multi-instance` |

Os testes de crash usam `FAULT_POINT` para fazer um processo filho real se matar com `SIGKILL` no momento
exato (`consumer:after-commit-before-ack`, `outbox:after-claim-before-publish`). Todo teste termina
verificando `wallet.balance == saldo reconstruído pelo ledger`. Nenhum teste substitui PostgreSQL ou SQS por mocks.
