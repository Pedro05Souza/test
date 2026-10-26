import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { WagerSettlement, type SettlementOutcome } from "../../src/wagering/domain/wager-settlement";
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/wagering/domain/wager-transaction";
import type { Wallet } from "../../src/wallet/domain/wallet";
import { LedgerDirection } from "../../src/wallet/domain/wallet-ledger-entry";
import { nextId, NOW, openWallet, policy, tx } from "./fixtures";

function settle(
  wallet: Wallet,
  transaction: WagerTransaction,
  reference?: WagerTransaction,
  alreadyReversed = false,
): SettlementOutcome {
  return WagerSettlement.settle({
    wallet,
    transaction,
    reference,
    alreadyReversed,
    ledgerEntryId: nextId("entry"),
    now: NOW,
    retryPolicy: policy,
  });
}

/** A BET already settled against the wallet. */
function processedBet(wallet: Wallet, amount: string, ext = nextId("bet")): WagerTransaction {
  const bet = tx(K.Bet, amount, { externalTransactionId: ext });
  expect(settle(wallet, bet).status).toBe(S.Processed);
  return bet;
}

describe("WagerSettlement", () => {
  describe("BET", () => {
    test("debits and produces one DEBIT entry", () => {
      const wallet = openWallet("100.00");
      const outcome = settle(wallet, tx(K.Bet, "25.00"));
      expect(outcome.status).toBe(S.Processed);
      if (outcome.status !== S.Processed) return;
      expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toJSON().amount).toBe("75.00");
    });

    test("is rejected with INSUFFICIENT_FUNDS without touching the wallet", () => {
      const wallet = openWallet("10.00");
      const bet = tx(K.Bet, "10.01");
      expect(settle(wallet, bet)).toEqual({ status: S.Rejected, code: FailureCode.InsufficientFunds });
      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(bet.resultBalance?.toJSON().amount).toBe("10.00");
      expect(wallet.version).toBe(1);
    });

    test("section 8 scenario (sequential form): 100.00, two bets of 80.00 → one processed, one rejected", () => {
      const wallet = openWallet("100.00");
      const first = settle(wallet, tx(K.Bet, "80.00"));
      const second = settle(wallet, tx(K.Bet, "80.00"));
      expect(first.status).toBe(S.Processed);
      expect(second).toEqual({ status: S.Rejected, code: FailureCode.InsufficientFunds });
      expect(wallet.balance.toJSON().amount).toBe("20.00");
    });
  });

  describe("WIN", () => {
    test("credits, with or without a reference to the round's BET", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "10.00");
      expect(settle(wallet, tx(K.Win, "30.00")).status).toBe(S.Processed);
      const win = tx(K.Win, "5.00", { reference: bet.externalTransactionId });
      expect(settle(wallet, win, bet).status).toBe(S.Processed);
      expect(win.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.toJSON().amount).toBe("125.00");
    });

    test("may only reference a BET", () => {
      const wallet = openWallet("100.00");
      const otherWin = tx(K.Win, "1.00");
      settle(wallet, otherWin);
      const win = tx(K.Win, "1.00", { reference: otherWin.externalTransactionId });
      expect(settle(wallet, win, otherWin)).toEqual({ status: S.Rejected, code: FailureCode.InvalidReferenceKind });
    });
  });

  describe("LOSS", () => {
    test("is processed without moving the balance or creating a ledger entry", () => {
      const wallet = openWallet("100.00");
      processedBet(wallet, "10.00");
      const loss = tx(K.Loss, "0.00");
      expect(settle(wallet, loss)).toEqual({ status: S.Processed, ledgerEntry: undefined });
      expect(wallet.balance.toJSON().amount).toBe("90.00");
      expect(wallet.version).toBe(2);
      expect(loss.resultBalance?.toJSON().amount).toBe("90.00");
    });
  });

  describe("REFUND", () => {
    test("credits back a processed BET", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "40.00");
      const refund = tx(K.Refund, "40.00", { reference: bet.externalTransactionId });
      const outcome = settle(wallet, refund, bet);
      expect(outcome.status).toBe(S.Processed);
      expect(wallet.balance.toJSON().amount).toBe("100.00");
      expect(refund.referenceTransactionId).toBe(bet.id);
    });

    test("only references BET", () => {
      const wallet = openWallet("100.00");
      const win = tx(K.Win, "10.00");
      settle(wallet, win);
      expect(settle(wallet, tx(K.Refund, "10.00", { reference: win.externalTransactionId }), win)).toEqual({
        status: S.Rejected,
        code: FailureCode.InvalidReferenceKind,
      });
    });

    test("must match the referenced amount (no partial refunds)", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "40.00");
      expect(settle(wallet, tx(K.Refund, "39.99", { reference: bet.externalTransactionId }), bet)).toEqual({
        status: S.Rejected,
        code: FailureCode.AmountMismatch,
      });
    });

    test("cannot reverse the same BET twice", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "40.00");
      expect(settle(wallet, tx(K.Refund, "40.00", { reference: bet.externalTransactionId }), bet, true)).toEqual({
        status: S.Rejected,
        code: FailureCode.AlreadyReversed,
      });
      expect(wallet.balance.toJSON().amount).toBe("60.00");
    });

    test("cannot reference a rejected BET", () => {
      const wallet = openWallet("10.00");
      const bet = tx(K.Bet, "50.00");
      settle(wallet, bet);
      expect(settle(wallet, tx(K.Refund, "50.00", { reference: bet.externalTransactionId }), bet)).toEqual({
        status: S.Rejected,
        code: FailureCode.ReferenceNotProcessed,
      });
    });

    test("reference must be in the same round, player and provider", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "10.00");
      for (const overrides of [{ roundId: "round-2" }, { providerId: "provider-b" }]) {
        expect(
          settle(wallet, tx(K.Refund, "10.00", { reference: bet.externalTransactionId, ...overrides }), bet),
        ).toEqual({ status: S.Rejected, code: FailureCode.ReferenceMismatch });
      }
    });
  });

  describe("ROLLBACK", () => {
    test("of a BET credits it back", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "30.00");
      const rb = tx(K.Rollback, "30.00", { reference: bet.externalTransactionId });
      const outcome = settle(wallet, rb, bet);
      expect(outcome.status === S.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.toJSON().amount).toBe("100.00");
    });

    test("of a WIN debits it back", () => {
      const wallet = openWallet("100.00");
      const win = tx(K.Win, "50.00");
      settle(wallet, win);
      const outcome = settle(wallet, tx(K.Rollback, "50.00", { reference: win.externalTransactionId }), win);
      expect(outcome.status === S.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toJSON().amount).toBe("100.00");
    });

    test("of a REFUND debits it back", () => {
      const wallet = openWallet("100.00");
      const bet = processedBet(wallet, "20.00");
      const refund = tx(K.Refund, "20.00", { reference: bet.externalTransactionId });
      settle(wallet, refund, bet);
      settle(wallet, tx(K.Rollback, "20.00", { reference: refund.externalTransactionId }), refund);
      expect(wallet.balance.toJSON().amount).toBe("80.00");
    });

    test("cannot reference a LOSS", () => {
      const wallet = openWallet("100.00");
      const loss = tx(K.Loss, "0");
      settle(wallet, loss);
      expect(settle(wallet, tx(K.Rollback, "1.00", { reference: loss.externalTransactionId }), loss)).toEqual({
        status: S.Rejected,
        code: FailureCode.InvalidReferenceKind,
      });
    });

    test("that would make the balance negative is rejected with REVERSAL_INSUFFICIENT_FUNDS", () => {
      const wallet = openWallet("0");
      const win = tx(K.Win, "50.00");
      settle(wallet, win);
      processedBet(wallet, "45.00");
      const rb = tx(K.Rollback, "50.00", { reference: win.externalTransactionId });
      expect(settle(wallet, rb, win)).toEqual({ status: S.Rejected, code: FailureCode.ReversalInsufficientFunds });
      expect(wallet.balance.toJSON().amount).toBe("5.00");
    });
  });

  describe("out-of-order references", () => {
    test("missing reference → PENDING_REFERENCE, retried until exhausted → REFERENCE_NOT_FOUND", () => {
      const wallet = openWallet("100.00");
      const refund = tx(K.Refund, "10.00", { reference: "not-yet" });
      for (let i = 1; i <= policy.maxAttempts; i++) {
        expect(settle(wallet, refund)).toEqual({ status: S.PendingReference });
        expect(refund.referenceAttempts).toBe(i);
      }
      expect(settle(wallet, refund)).toEqual({ status: S.Rejected, code: FailureCode.ReferenceNotFound });
      expect(wallet.version).toBe(1);
    });

    test("pending REFUND resolves once the BET arrives", () => {
      const wallet = openWallet("100.00");
      const refund = tx(K.Refund, "10.00", { reference: "bet-late" });
      expect(settle(wallet, refund).status).toBe(S.PendingReference);
      const bet = processedBet(wallet, "10.00", "bet-late");
      expect(settle(wallet, refund, bet).status).toBe(S.Processed);
      expect(wallet.balance.toJSON().amount).toBe("100.00");
    });

    test("a reference still pending itself makes the dependent wait", () => {
      const wallet = openWallet("100.00");
      const refund = tx(K.Refund, "10.00", { reference: "bet-late" });
      settle(wallet, refund);
      const rb = tx(K.Rollback, "10.00", { reference: refund.externalTransactionId });
      expect(settle(wallet, rb, refund)).toEqual({ status: S.PendingReference });
    });
  });

  describe("wallet scope", () => {
    test("currency mismatch is rejected", () => {
      const wallet = openWallet("100.00");
      expect(settle(wallet, tx(K.Bet, "1.00", { currency: "USD" }))).toEqual({
        status: S.Rejected,
        code: FailureCode.CurrencyMismatch,
      });
    });

    test("player that does not own the wallet is rejected", () => {
      const wallet = openWallet("100.00");
      expect(settle(wallet, tx(K.Bet, "1.00", { playerId: "someone-else" }))).toEqual({
        status: S.Rejected,
        code: FailureCode.WalletPlayerMismatch,
      });
    });
  });
});
