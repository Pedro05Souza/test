import type { IdGenerator } from "../../shared/application/ports";
import type { IntegrationEvent } from "../../shared/domain/integration-event";
import type { Wallet } from "../../wallet/domain/wallet";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events";
import { WagerTransactionStatus, type WagerTransaction } from "../domain/wager-transaction";

export interface TraceContext {
  correlationId: string;
  /** What caused this processing: the SQS messageId, or the HTTP request id. */
  causationId?: string;
}

/** Integration events raised by the outcome of a settlement (written to the outbox, never published inline). */
export function eventsForOutcome(
  tx: WagerTransaction,
  wallet: Wallet,
  ledgerEntry: WalletLedgerEntry | undefined,
  trace: TraceContext,
  ids: IdGenerator,
  now: Date,
): IntegrationEvent<unknown>[] {
  const ctx = () => ({ eventId: ids.next(), correlationId: trace.correlationId, causationId: trace.causationId, occurredAt: now });
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return ledgerEntry
        ? [WagerTransactionProcessed.from(tx, ctx()), WalletBalanceChanged.from(wallet, ledgerEntry, ctx())]
        : [WagerTransactionProcessed.from(tx, ctx())];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(tx, ctx())];
    case WagerTransactionStatus.PendingReference:
      return [WagerTransactionPendingReference.from(tx, ctx())];
    default:
      return [];
  }
}
