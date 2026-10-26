import { OutboxMessage } from "../../messaging/domain/outbox-message";
import type { IdGenerator, TransactionalRepositories } from "../../shared/application/ports";
import type { Wallet } from "../../wallet/domain/wallet";
import type { ReferenceRetryPolicy } from "../domain/reference-retry-policy";
import { WagerSettlement, type SettlementOutcome } from "../domain/wager-settlement";
import { WagerTransactionStatus, type WagerTransaction } from "../domain/wager-transaction";
import { eventsForOutcome, type TraceContext } from "./wager-events";

export interface SettleAndRecordInput {
  repos: TransactionalRepositories;
  /** Must already be locked (lockForUpdate) in this unit of work. */
  wallet: Wallet;
  transaction: WagerTransaction;
  /** true: first time this transaction is persisted; false: it was loaded (PENDING_REFERENCE retry). */
  isNew: boolean;
  trace: TraceContext;
  ids: IdGenerator;
  retryPolicy: ReferenceRetryPolicy;
  now: Date;
}

/**
 * The one place a wager transaction is settled and recorded — shared by first submission
 * (HTTP/SQS) and by the PENDING_REFERENCE worker, so both follow exactly the same rules:
 * resolve reference → settle → persist transaction, wallet, ledger line and events (same SQL tx).
 */
export async function settleAndRecord(input: SettleAndRecordInput): Promise<SettlementOutcome> {
  const { repos, wallet, transaction: tx, now } = input;

  const reference = tx.referenceExternalTransactionId
    ? ((await repos.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)) ?? undefined)
    : undefined;
  const alreadyReversed =
    reference && tx.isReversal() ? await repos.transactions.hasProcessedReversal(reference.id) : false;

  const outcome = WagerSettlement.settle({
    wallet,
    transaction: tx,
    reference,
    alreadyReversed,
    ledgerEntryId: input.ids.next(),
    now,
    retryPolicy: input.retryPolicy,
  });

  if (input.isNew) repos.transactions.add(tx);
  else repos.transactions.save(tx);

  const ledgerEntry = outcome.status === WagerTransactionStatus.Processed ? outcome.ledgerEntry : undefined;
  if (ledgerEntry) {
    repos.wallets.save(wallet);
    repos.ledger.add(ledgerEntry);
  }
  // "Waiting for reference" is announced once, on arrival; retries only announce the final outcome.
  const announce = input.isNew || outcome.status !== WagerTransactionStatus.PendingReference;
  if (announce) {
    for (const event of eventsForOutcome(tx, wallet, ledgerEntry, input.trace, input.ids, now)) {
      repos.outbox.add(OutboxMessage.enqueue(event));
    }
  }
  // Transactions on this wallet that were waiting for this one can be re-checked right away.
  if (outcome.status === WagerTransactionStatus.Processed) {
    await repos.transactions.wakeDependents(tx, now);
  }
  return outcome;
}
