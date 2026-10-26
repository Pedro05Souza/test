import type { MoneyProps } from "../../shared/domain/money";
import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from "../../shared/domain/integration-event";
import type { Wallet } from "../../wallet/domain/wallet";
import type { LedgerDirection, WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { FAILURE_CODE_ACTION, type FailureCode, type ProviderAction } from "./failure-code";
import type { WagerTransaction, WagerTransactionKind } from "./wager-transaction";

interface TransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionRef(tx: WagerTransaction): TransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function props<T>(aggregateId: string, ctx: EventContext, data: T): IntegrationEventProps<T> {
  return { ...ctx, aggregateId, data };
}

// ---- WagerTransactionProcessed: any applied transaction, including LOSS

export interface WagerTransactionProcessedData extends TransactionRef {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(p: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(p);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      props(tx.id, ctx, {
        ...transactionRef(tx),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balance: tx.resultBalance!.toJSON(),
        processedAt: tx.processedAt!.toISOString(),
      }),
    );
  }
}

// ---- WagerTransactionRejected: business rule violation

export interface WagerTransactionRejectedData extends TransactionRef {
  failureCode: FailureCode;
  providerAction: ProviderAction;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(p: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(p);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const code = tx.failureCode!;
    return new WagerTransactionRejected(
      props(tx.id, ctx, {
        ...transactionRef(tx),
        failureCode: code,
        providerAction: FAILURE_CODE_ACTION[code],
        rejectedAt: tx.processedAt!.toISOString(),
      }),
    );
  }
}

// ---- WagerTransactionPendingReference: reference not found yet

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  referenceExternalTransactionId: string;
  attempts: number;
  nextCheckAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(p: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(p);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      props(tx.id, ctx, {
        ...transactionRef(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId!,
        attempts: tx.referenceAttempts,
        nextCheckAt: tx.nextReferenceCheckAt!.toISOString(),
      }),
    );
  }
}

// ---- WalletBalanceChanged: only when the balance actually moved

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  private constructor(p: IntegrationEventProps<WalletBalanceChangedData>) {
    super(p);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      props(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}
