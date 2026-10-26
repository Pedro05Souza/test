import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { OutboxMessage } from "../../src/messaging/domain/outbox-message";
import { InboxMapper, OutboxMapper } from "../../src/messaging/infrastructure/messaging.mappers";
import { InboxMessageRecord, OutboxMessageRecord } from "../../src/messaging/infrastructure/messaging.records";
import { Money } from "../../src/shared/domain/money";
import { createOrmConfig } from "../../src/shared/infrastructure/database/mikro-orm.config";
import { WalletBalanceChanged } from "../../src/wagering/domain/events";
import { WagerTransaction, WagerTransactionKind } from "../../src/wagering/domain/wager-transaction";
import { WagerTransactionMapper } from "../../src/wagering/infrastructure/wager-transaction.mapper";
import { WagerTransactionRecord } from "../../src/wagering/infrastructure/wager-transaction.record";
import { Wallet } from "../../src/wallet/domain/wallet";
import { WalletLedgerEntryRecord } from "../../src/wallet/infrastructure/wallet-ledger-entry.record";
import { LedgerEntryMapper, WalletMapper } from "../../src/wallet/infrastructure/wallet.mapper";
import { WalletRecord } from "../../src/wallet/infrastructure/wallet.record";
import { migrateUp, rawSql, uuid } from "./support/db";

let orm: MikroORM;
const db = rawSql();

beforeAll(async () => {
  await migrateUp();
  orm = await MikroORM.init(createOrmConfig());
});
afterAll(async () => {
  await orm.close(true);
  await db.close();
});

/** Persists a funded wallet (wallet + OPENING tx + ledger) through the Unit of Work in one transaction. */
async function openWalletViaOrm(balance: string) {
  const now = new Date();
  const walletId = uuid();
  const openingTxId = uuid();
  const initial = Money.from({ amount: balance, currency: "BRL" });
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: `player-${uuid()}`,
    initialBalance: initial,
    opening: { transactionId: openingTxId, ledgerEntryId: uuid() },
    at: now,
  });
  const opening = WagerTransaction.createOpening({ id: openingTxId, walletId, playerId: wallet.playerId, money: initial, at: now });
  await orm.em.fork().transactional(async (em) => {
    // persisted in "wrong" order on purpose: the UoW must order INSERTs by the FK graph
    em.create(WalletLedgerEntryRecord, LedgerEntryMapper.toRecord(openingEntry!));
    em.create(WagerTransactionRecord, WagerTransactionMapper.toRecord(opening, now));
    em.create(WalletRecord, WalletMapper.toRecord(wallet));
  });
  return wallet;
}

async function countsFor(walletId: string, inboxId: string, outboxId: string) {
  const [row] = await db`
    SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${walletId} AND kind = 'BET') AS bets,
           (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${walletId}) AS ledger,
           (SELECT count(*)::int FROM inbox_messages WHERE message_id = ${inboxId}) AS inbox,
           (SELECT count(*)::int FROM outbox_messages WHERE id = ${outboxId}) AS outbox,
           (SELECT balance_amount FROM wallets WHERE id = ${walletId}) AS balance,
           (SELECT version FROM wallets WHERE id = ${walletId}) AS version`;
  return row;
}

/** One BET applied through the UoW: inbox + tx + wallet update + ledger + outbox. */
async function applyBet(
  wallet: Wallet,
  amount: string,
  opts: { failBeforeCommit?: boolean; inboxId?: string; eventId?: string } = {},
) {
  const now = new Date();
  const inboxId = opts.inboxId ?? `msg-${uuid()}`;
  const eventId = opts.eventId ?? uuid();
  await orm.em.fork().transactional(async (em) => {
    const record = await em.findOneOrFail(WalletRecord, { id: wallet.id });
    const current = WalletMapper.toDomain(record);
    const bet = WagerTransaction.create({
      id: uuid(),
      providerId: "provider-a",
      externalTransactionId: `ext-${uuid()}`,
      idempotencyKey: `k-${uuid()}`,
      payloadHash: "h".repeat(64),
      walletId: current.id,
      playerId: current.playerId,
      roundId: "r",
      gameId: "g",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount, currency: "BRL" }),
      createdAt: now,
    });
    const entry = current.debit(bet.money, { transactionId: bet.id, ledgerEntryId: uuid(), at: now });
    bet.markProcessed({ referenceTransactionId: undefined, balanceAfter: current.balance, at: now });

    em.create(InboxMessageRecord, InboxMapper.toRecord(InboxMessage.receive({ messageId: inboxId, consumerName: "wager", payloadHash: "h", receivedAt: now })));
    em.create(WagerTransactionRecord, WagerTransactionMapper.toRecord(bet, now));
    em.assign(record, WalletMapper.toRecord(current));
    em.create(WalletLedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
    em.create(
      OutboxMessageRecord,
      OutboxMapper.toRecord(OutboxMessage.enqueue(WalletBalanceChanged.from(current, entry, { eventId, correlationId: "c", occurredAt: now }))),
    );
    if (opts.failBeforeCommit) {
      await em.flush(); // statements reach Postgres…
      throw new Error("simulated crash before commit"); // …but the transaction is rolled back
    }
  });
  return { inboxId, eventId };
}

describe("Unit of Work atomicity", () => {
  test("opening a wallet persists wallet, OPENING tx and ledger together (FK order resolved by the UoW)", async () => {
    const wallet = await openWalletViaOrm("1000.00");
    const [row] = await db`
      SELECT w.balance_amount, w.version, t.kind, t.status, l.direction, l.balance_after
      FROM wallets w JOIN wager_transactions t ON t.wallet_id = w.id JOIN wallet_ledger_entries l ON l.transaction_id = t.id
      WHERE w.id = ${wallet.id}`;
    expect(row).toEqual({ balance_amount: "1000.00", version: 1, kind: "OPENING", status: "PROCESSED", direction: "CREDIT", balance_after: "1000.00" });
  });

  test("wallet, transaction, ledger, inbox and outbox commit together", async () => {
    const wallet = await openWalletViaOrm("100.00");
    const { inboxId, eventId } = await applyBet(wallet, "25.00");
    expect(await countsFor(wallet.id, inboxId, eventId)).toEqual({ bets: 1, ledger: 2, inbox: 1, outbox: 1, balance: "75.00", version: 2 });
  });

  test("a failure before commit leaves no trace in any table", async () => {
    const wallet = await openWalletViaOrm("100.00");
    const inboxId = `msg-${uuid()}`;
    const eventId = uuid();
    await expect(applyBet(wallet, "25.00", { failBeforeCommit: true, inboxId, eventId })).rejects.toThrow(/simulated crash/);
    // only the OPENING ledger line remains; nothing from the failed unit of work
    expect(await countsFor(wallet.id, inboxId, eventId)).toEqual({ bets: 0, ledger: 1, inbox: 0, outbox: 0, balance: "100.00", version: 1 });
  });

  test("a database invariant violation rolls back the whole unit of work", async () => {
    const wallet = await openWalletViaOrm("10.00");
    const now = new Date();
    const eventId = uuid();
    await expect(
      orm.em.fork().transactional(async (em) => {
        const record = await em.findOneOrFail(WalletRecord, { id: wallet.id });
        // bypass the domain on purpose: write a balance with no ledger line
        record.balanceAmount = "500.00";
        record.version = 2;
        em.create(OutboxMessageRecord, { id: eventId, aggregateId: wallet.id, eventType: "X", payload: {}, occurredAt: now, attempts: 0, nextAttemptAt: now });
      }),
    ).rejects.toThrow(/does not match ledger balance/);
    const [row] = await db`
      SELECT (SELECT balance_amount FROM wallets WHERE id = ${wallet.id}) AS balance,
             (SELECT count(*)::int FROM outbox_messages WHERE id = ${eventId}) AS outbox`;
    expect(row).toEqual({ balance: "10.00", outbox: 0 });
  });
});
