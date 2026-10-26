import { defineEntity, p, type InferEntity } from "@mikro-orm/core";
import { WalletRecord } from "../../wallet/infrastructure/wallet.record";

export const WagerTransactionRecord = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.string().length(64),
    externalTransactionId: p.string().length(128),
    idempotencyKey: p.string().length(256),
    payloadHash: p.string().length(64),
    wallet: () => p.manyToOne(WalletRecord).mapToPk(),
    playerId: p.string().length(128),
    roundId: p.string().length(128),
    gameId: p.string().length(128),
    kind: p.string().length(16),
    amount: p.decimal("string").precision(20).scale(2),
    currency: p.string().columnType("char(3)"),
    referenceExternalTransactionId: p.string().length(128).nullable(),
    referenceTransaction: () => p.manyToOne(WagerTransactionRecord).mapToPk().nullable(),
    status: p.string().length(20),
    failureCode: p.string().length(40).nullable(),
    resultBalanceAmount: p.decimal("string").precision(20).scale(2).nullable(),
    referenceAttempts: p.integer(),
    nextReferenceCheckAt: p.datetime().columnType("timestamptz").nullable(),
    createdAt: p.datetime().columnType("timestamptz"),
    processedAt: p.datetime().columnType("timestamptz").nullable(),
    updatedAt: p.datetime().columnType("timestamptz"),
  },
});
export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecord>;
