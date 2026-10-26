import { describe, expect, test } from "bun:test";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { OutboxMessage } from "../../src/messaging/domain/outbox-message";
import { WalletBalanceChanged, WagerTransactionRejected } from "../../src/wagering/domain/events";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { WagerTransactionKind } from "../../src/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../src/wallet/domain/wallet-ledger-entry";
import { brl, NOW, openWallet, tx } from "./fixtures";

const ctx = { eventId: "evt-1", correlationId: "corr-1", causationId: "msg-1", occurredAt: NOW };

describe("integration events", () => {
  test("envelope carries type and version from the class, and money as decimal strings", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit(brl("25.00"), { transactionId: "t-1", ledgerEntryId: "e-1", at: NOW });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();

    expect(json).toEqual({
      eventId: "evt-1",
      eventType: "WalletBalanceChanged",
      aggregateId: wallet.id,
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-07-29T15:00:00.000Z",
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: "t-1",
        direction: LedgerDirection.Debit,
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
    // stable JSON — no class instances leak into the payload
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test("rejection event exposes the failure code and the provider action", () => {
    const bet = tx(WagerTransactionKind.Bet, "10.00");
    bet.reject(FailureCode.InsufficientFunds, { balance: brl("0"), at: NOW });
    const { data } = WagerTransactionRejected.from(bet, ctx).toJSON();
    expect(data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(data.providerAction).toBe("DO_NOT_RETRY");
  });
});

describe("OutboxMessage", () => {
  const message = () => {
    const wallet = openWallet("100.00");
    const entry = wallet.credit(brl("1.00"), { transactionId: "t", ledgerEntryId: "e", at: NOW });
    return OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx));
  };

  test("is enqueued pending and immediately due, keyed by the event id", () => {
    const m = message();
    expect(m.id).toBe("evt-1");
    expect(m.isPending()).toBe(true);
    expect(m.isDue(NOW)).toBe(true);
    expect(m.payload.eventType).toBe("WalletBalanceChanged");
  });

  test("retries back off exponentially up to 60s", () => {
    const m = message();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      m.scheduleRetry(NOW);
      delays.push(m.nextAttemptAt!.getTime() - NOW.getTime());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(m.attempts).toBe(8);
    expect(m.isDue(NOW)).toBe(false);
  });

  test("publishing is idempotent", () => {
    const m = message();
    m.markPublished(NOW);
    m.markPublished(new Date(NOW.getTime() + 1000));
    expect(m.publishedAt).toEqual(NOW);
    expect(m.isDue(new Date(NOW.getTime() + 10_000))).toBe(false);
  });
});

describe("InboxMessage", () => {
  test("tracks processing once", () => {
    const m = InboxMessage.receive({ messageId: "msg-1", consumerName: "wager", payloadHash: "h", receivedAt: NOW });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(NOW);
    m.markProcessed(new Date(NOW.getTime() + 1));
    expect(m.processedAt).toEqual(NOW);
  });
});
