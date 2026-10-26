import type { RequiredEntityData } from "@mikro-orm/core";
import { Money } from "../../shared/domain/money";
import type { FailureCode } from "../domain/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../domain/wager-transaction";
import type { WagerTransactionRecord } from "./wager-transaction.record";

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.wallet,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: money(record.amount),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      createdAt: record.createdAt,
      status: record.status as WagerTransactionStatus,
      referenceTransactionId: record.referenceTransaction ?? undefined,
      failureCode: (record.failureCode as FailureCode | null) ?? undefined,
      processedAt: record.processedAt ?? undefined,
      resultBalance: record.resultBalanceAmount != null ? money(record.resultBalanceAmount) : undefined,
      referenceAttempts: record.referenceAttempts,
      nextReferenceCheckAt: record.nextReferenceCheckAt ?? undefined,
    });
  },

  toRecord(tx: WagerTransaction, updatedAt: Date): RequiredEntityData<WagerTransactionRecord> {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      wallet: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toJSON().amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransaction: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      resultBalanceAmount: tx.resultBalance?.toJSON().amount ?? null,
      referenceAttempts: tx.referenceAttempts,
      nextReferenceCheckAt: tx.nextReferenceCheckAt ?? null,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt ?? null,
      updatedAt,
    };
  },
};
