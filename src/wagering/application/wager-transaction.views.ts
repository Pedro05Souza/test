import type { Money, MoneyProps } from "../../shared/domain/money";
import { FAILURE_CODE_ACTION, type FailureCode, type ProviderAction } from "../domain/failure-code";
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";

/** Outcome of a submission (HTTP response body / basis of the SQS ack decision). */
export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
  providerAction?: ProviderAction;
}

/**
 * Replays return the balance observed when the outcome was reached (`resultBalance`).
 * A transaction still waiting for its reference has no outcome yet, so the current balance is used.
 */
export function toResult(tx: WagerTransaction, currentBalance: Money, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: (tx.resultBalance ?? currentBalance).toJSON(),
    idempotentReplay,
    ...(tx.failureCode ? { failureCode: tx.failureCode, providerAction: FAILURE_CODE_ACTION[tx.failureCode] } : {}),
  };
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  providerAction?: ProviderAction;
  resultBalance?: MoneyProps;
  referenceAttempts: number;
  nextReferenceCheckAt?: string;
  createdAt: string;
  processedAt?: string;
}

export function toView(tx: WagerTransaction): WagerTransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
    ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
    ...(tx.failureCode ? { failureCode: tx.failureCode, providerAction: FAILURE_CODE_ACTION[tx.failureCode] } : {}),
    ...(tx.resultBalance ? { resultBalance: tx.resultBalance.toJSON() } : {}),
    referenceAttempts: tx.referenceAttempts,
    ...(tx.nextReferenceCheckAt ? { nextReferenceCheckAt: tx.nextReferenceCheckAt.toISOString() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}
