import { InvalidArgumentError } from "../../shared/domain/errors";
import type { Wallet } from "../../wallet/domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import type { ReferenceRetryPolicy } from "./reference-retry-policy";
import { WagerTransactionStatus, type WagerTransaction } from "./wager-transaction";

export interface SettlementInput {
  /** Must be locked by the caller for the duration of the database transaction. */
  wallet: Wallet;
  transaction: WagerTransaction;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when not found or not referenced. */
  reference: WagerTransaction | undefined;
  /** Whether a PROCESSED REFUND/ROLLBACK already points to `reference`. */
  alreadyReversed: boolean;
  ledgerEntryId: string;
  now: Date;
  retryPolicy: ReferenceRetryPolicy;
}

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; ledgerEntry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; code: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/**
 * Applies a wager transaction to its wallet according to the business rules (section 7).
 * Pure: mutates only the given aggregates and returns what happened; no I/O.
 */
export class WagerSettlement {
  static settle(input: SettlementInput): SettlementOutcome {
    const { wallet, transaction: tx, reference, now } = input;

    if (tx.walletId !== wallet.id) {
      throw new InvalidArgumentError("settlement called with a wallet that does not belong to the transaction");
    }
    if (tx.playerId !== wallet.playerId) return reject(input, FailureCode.WalletPlayerMismatch);
    if (tx.money.currency !== wallet.currency) return reject(input, FailureCode.CurrencyMismatch);

    if (tx.referenceExternalTransactionId) {
      if (!reference) return waitForReference(input, FailureCode.ReferenceNotFound);
      const check = tx.checkReference(reference, { alreadyReversed: input.alreadyReversed });
      if (check.outcome === "reject") return reject(input, check.code);
      if (check.outcome === "wait") return waitForReference(input, FailureCode.ReferenceNotProcessed);
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed({ referenceTransactionId: reference?.id, balanceAfter: wallet.balance, at: now });
      return { status: WagerTransactionStatus.Processed, ledgerEntry: undefined };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      // A reversal that cannot be covered is operationally different from a bet without funds.
      return reject(input, tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
    }

    const ledgerEntry = wallet.apply(direction, tx.money, {
      transactionId: tx.id,
      ledgerEntryId: input.ledgerEntryId,
      at: now,
    });
    tx.markProcessed({ referenceTransactionId: reference?.id, balanceAfter: wallet.balance, at: now });
    return { status: WagerTransactionStatus.Processed, ledgerEntry };
  }
}

function reject(input: SettlementInput, code: FailureCode): SettlementOutcome {
  input.transaction.reject(code, { balance: input.wallet.balance, at: input.now });
  return { status: WagerTransactionStatus.Rejected, code };
}

/** Schedules another reference check, or rejects with `exhaustedCode` once the retry budget is spent. */
function waitForReference(input: SettlementInput, exhaustedCode: FailureCode): SettlementOutcome {
  const { transaction: tx, retryPolicy, now } = input;
  if (retryPolicy.isExhausted(tx.referenceAttempts)) return reject(input, exhaustedCode);
  tx.markPendingReference(now, retryPolicy);
  return { status: WagerTransactionStatus.PendingReference };
}
