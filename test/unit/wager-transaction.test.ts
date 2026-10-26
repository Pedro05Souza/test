import { describe, expect, test } from "bun:test";
import { InvalidArgumentError, InvalidTransactionStateError } from "../../src/shared/domain/errors";
import { computePayloadHash, type WagerPayloadFields } from "../../src/wagering/application/payload-hash";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../src/wallet/domain/wallet-ledger-entry";
import { brl, NOW, policy, tx } from "./fixtures";

describe("WagerTransaction", () => {
  describe("creation", () => {
    test("is born PENDING", () => {
      expect(tx(WagerTransactionKind.Bet, "10.00").status).toBe(WagerTransactionStatus.Pending);
    });

    test("REFUND and ROLLBACK require a reference", () => {
      expect(() => tx(WagerTransactionKind.Refund, "10.00")).toThrow(InvalidArgumentError);
      expect(() => tx(WagerTransactionKind.Rollback, "10.00")).toThrow(InvalidArgumentError);
      expect(() => tx(WagerTransactionKind.Refund, "10.00", { reference: "bet-1" })).not.toThrow();
    });

    test("BET cannot reference another transaction", () => {
      expect(() => tx(WagerTransactionKind.Bet, "10.00", { reference: "x" })).toThrow(InvalidArgumentError);
    });

    test("balance-moving kinds need a positive amount; LOSS may be zero", () => {
      expect(() => tx(WagerTransactionKind.Bet, "0.00")).toThrow(InvalidArgumentError);
      expect(() => tx(WagerTransactionKind.Win, "0")).toThrow(InvalidArgumentError);
      expect(() => tx(WagerTransactionKind.Loss, "0.00")).not.toThrow();
    });

    test("OPENING cannot be submitted", () => {
      const bet = tx(WagerTransactionKind.Bet, "10.00");
      expect(() =>
        WagerTransaction.create({
          ...bet,
          kind: WagerTransactionKind.Opening as unknown as WagerTransactionKind.Bet,
          money: bet.money,
          referenceExternalTransactionId: undefined,
        }),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe("transitions", () => {
    test("terminal states cannot transition again", () => {
      const processed = tx(WagerTransactionKind.Bet, "10.00");
      processed.markProcessed({ referenceTransactionId: undefined, balanceAfter: brl("90.00"), at: NOW });

      const rejected = tx(WagerTransactionKind.Bet, "10.00");
      rejected.reject(FailureCode.InsufficientFunds, { balance: brl("0"), at: NOW });

      const failed = tx(WagerTransactionKind.Bet, "10.00");
      failed.fail(FailureCode.InfrastructureFailure, NOW);

      for (const t of [processed, rejected, failed]) {
        expect(t.isTerminal()).toBe(true);
        expect(() => t.markProcessed({ referenceTransactionId: undefined, balanceAfter: brl("1.00"), at: NOW })).toThrow(
          InvalidTransactionStateError,
        );
        expect(() => t.reject(FailureCode.AmountMismatch, { balance: brl("1.00"), at: NOW })).toThrow(
          InvalidTransactionStateError,
        );
        expect(() => t.fail(FailureCode.InfrastructureFailure, NOW)).toThrow(InvalidTransactionStateError);
        expect(() => t.markPendingReference(NOW, policy)).toThrow(InvalidTransactionStateError);
      }
    });

    test("PENDING_REFERENCE schedules checks with exponential backoff and can still resolve", () => {
      const refund = tx(WagerTransactionKind.Refund, "10.00", { reference: "bet-x" });
      refund.markPendingReference(NOW, policy);
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
      expect(refund.referenceAttempts).toBe(1);
      expect(refund.nextReferenceCheckAt!.getTime() - NOW.getTime()).toBe(1_000);

      refund.markPendingReference(NOW, policy);
      expect(refund.nextReferenceCheckAt!.getTime() - NOW.getTime()).toBe(2_000);

      refund.markProcessed({ referenceTransactionId: "bet-internal", balanceAfter: brl("10.00"), at: NOW });
      expect(refund.status).toBe(WagerTransactionStatus.Processed);
      expect(refund.nextReferenceCheckAt).toBeUndefined();
    });

    test("backoff is capped", () => {
      expect(policy.delayFor(1)).toBe(1_000);
      expect(policy.delayFor(4)).toBe(8_000);
      expect(policy.delayFor(10)).toBe(10_000);
    });
  });

  describe("domain queries", () => {
    test("affectsBalance is false only for LOSS", () => {
      expect(tx(WagerTransactionKind.Loss, "0").affectsBalance()).toBe(false);
      expect(tx(WagerTransactionKind.Win, "1.00").affectsBalance()).toBe(true);
    });

    test("ledger direction per kind; ROLLBACK inverts its reference", () => {
      const bet = tx(WagerTransactionKind.Bet, "10.00");
      const win = tx(WagerTransactionKind.Win, "10.00");
      const refund = tx(WagerTransactionKind.Refund, "10.00", { reference: "b" });
      const rollback = tx(WagerTransactionKind.Rollback, "10.00", { reference: "b" });
      expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
      expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
      expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidArgumentError);
    });
  });
});

describe("payload hash / idempotency", () => {
  const fields: WagerPayloadFields = {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  };

  test("is independent of key order and amount formatting", () => {
    const reordered = Object.fromEntries(Object.entries(fields).reverse()) as unknown as WagerPayloadFields;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(fields));
    expect(computePayloadHash({ ...fields, money: { amount: "25", currency: "BRL" } })).toBe(
      computePayloadHash(fields),
    );
  });

  test("ignores fields outside the business subset", () => {
    const withExtras = { ...fields, idempotencyKey: "whatever", traceId: "abc" } as WagerPayloadFields;
    expect(computePayloadHash(withExtras)).toBe(computePayloadHash(fields));
  });

  test("same idempotency key with a divergent payload does not match", () => {
    const original = tx(WagerTransactionKind.Bet, "25.00", { externalTransactionId: "transaction-123" });
    const divergent = computePayloadHash({
      providerId: original.providerId,
      externalTransactionId: original.externalTransactionId,
      playerId: original.playerId,
      walletId: original.walletId,
      roundId: original.roundId,
      gameId: original.gameId,
      kind: original.kind,
      money: { amount: "26.00", currency: "BRL" },
    });
    const identical = computePayloadHash({
      providerId: original.providerId,
      externalTransactionId: original.externalTransactionId,
      playerId: original.playerId,
      walletId: original.walletId,
      roundId: original.roundId,
      gameId: original.gameId,
      kind: original.kind,
      money: original.money.toJSON(),
    });
    expect(original.matchesPayload(identical)).toBe(true);
    expect(original.matchesPayload(divergent)).toBe(false);
  });
});
