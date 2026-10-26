import { Inject, Injectable } from "@nestjs/common";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletNotFoundError,
} from "../../shared/application/errors";
import {
  CLOCK,
  ID_GENERATOR,
  LOGGER,
  METRICS,
  UNIT_OF_WORK,
  type Clock,
  type IdGenerator,
  type Logger,
  type Metrics,
  type ProcessingSource,
  type TransactionalRepositories,
  type UnitOfWork,
} from "../../shared/application/ports";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { ReferenceRetryPolicy } from "../domain/reference-retry-policy";
import { WagerTransaction, type SubmittableKind } from "../domain/wager-transaction";
import { computePayloadHash } from "./payload-hash";
import { settleAndRecord } from "./settle-and-record";
import type { TraceContext } from "./wager-events";
import { toResult, type WagerTransactionResult } from "./wager-transaction.views";

export const REFERENCE_RETRY_POLICY = Symbol("ReferenceRetryPolicy");

export interface SubmitWagerTransactionCommand {
  /** Source of truth for idempotency (HTTP header / message field). */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessingContext extends TraceContext {
  source: ProcessingSource;
  /** Present when the command came from a broker message: deduplicated through the inbox. */
  inbox?: { consumerName: string; messageId: string };
}

/** Re-runs after a uniqueness race (e.g. same key submitted concurrently for two different wallets). */
const MAX_ATTEMPTS = 3;

/**
 * Single entry point for wager transactions, shared by the HTTP controller and the SQS consumer.
 * Everything — inbox, transaction, wallet, ledger, outbox — happens in ONE database transaction.
 */
@Injectable()
export class ProcessWagerTransaction {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(REFERENCE_RETRY_POLICY) private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async execute(command: SubmitWagerTransactionCommand, ctx: ProcessingContext): Promise<WagerTransactionResult> {
    const startedAt = performance.now();
    const money = Money.from(command.money);
    const payloadHash = computePayloadHash(command);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await this.uow.run((repos) => this.process(repos, command, money, payloadHash, ctx));
          this.logger.info("wager transaction handled", {
            correlationId: ctx.correlationId,
            messageId: ctx.inbox?.messageId,
            transactionId: result.transactionId,
            walletId: command.walletId,
            providerId: command.providerId,
            kind: command.kind,
            status: result.status,
            failureCode: result.failureCode,
            idempotentReplay: result.idempotentReplay,
          });
          return result;
        } catch (error) {
          if (!(error instanceof UniqueViolationError)) throw error;
          if (attempt >= MAX_ATTEMPTS) {
            throw new TransientInfrastructureError("concurrent conflicting writes, retry the request", { cause: error });
          }
          this.metrics.retry("uow");
        }
      }
    } finally {
      this.metrics.processingDuration(ctx.source, (performance.now() - startedAt) / 1000);
    }
  }

  private async process(
    repos: TransactionalRepositories,
    command: SubmitWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    ctx: ProcessingContext,
  ): Promise<WagerTransactionResult> {
    const now = this.clock.now();

    if (ctx.inbox) {
      const inbox = InboxMessage.receive({ ...ctx.inbox, payloadHash, receivedAt: now });
      inbox.markProcessed(now);
      if (!(await repos.inbox.tryRecord(inbox))) {
        this.metrics.duplicateDetected("inbox_redelivery");
        const original = await repos.transactions.findByIdempotencyKey(command.idempotencyKey);
        const wallet = original && (await repos.wallets.findById(original.walletId));
        if (!original || !wallet) {
          throw new IdempotencyConflictError(`message ${ctx.inbox.messageId} was already used for another transaction`);
        }
        return this.replay(original, command, payloadHash, wallet.balance);
      }
    }

    // Serializes every operation on this wallet across all instances until commit/rollback.
    const wallet = await repos.wallets.lockForUpdate(command.walletId);
    if (!wallet) throw new WalletNotFoundError(`wallet ${command.walletId} not found`);

    const existing =
      (await repos.transactions.findByIdempotencyKey(command.idempotencyKey)) ??
      (await repos.transactions.findByExternalId(command.providerId, command.externalTransactionId));
    if (existing) return this.replay(existing, command, payloadHash, wallet.balance);

    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    await settleAndRecord({
      repos,
      wallet,
      transaction: tx,
      isNew: true,
      trace: ctx,
      ids: this.ids,
      retryPolicy: this.retryPolicy,
      now,
    });

    this.metrics.transactionOutcome(tx.status, tx.kind, ctx.source);
    return toResult(tx, wallet.balance, false);
  }

  /** Identical request → original result. Same key or same external id with a different payload → conflict. */
  private replay(
    original: WagerTransaction,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    currentBalance: Money,
  ): WagerTransactionResult {
    const sameRequest = original.idempotencyKey === command.idempotencyKey && original.matchesPayload(payloadHash);
    if (!sameRequest) {
      this.metrics.duplicateDetected("idempotency_conflict");
      throw new IdempotencyConflictError(
        original.idempotencyKey === command.idempotencyKey
          ? "idempotency key already used with a different payload"
          : "externalTransactionId already used with a different idempotency key",
      );
    }
    this.metrics.duplicateDetected("idempotent_replay");
    return toResult(original, currentBalance, true);
  }
}
