import { InvalidArgumentError, InvalidTransactionStateError } from "../../shared/domain/errors";
import { Money } from "../../shared/domain/money";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import type { ReferenceRetryPolicy } from "./reference-retry-policy";

export enum WagerTransactionKind {
  Opening = "OPENING", // internal: wallet opening credit
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // accepted, not applied yet (only ever lives inside the processing transaction)
  PendingReference = "PENDING_REFERENCE", // waiting for the referenced transaction
  Processed = "PROCESSED", // applied (terminal)
  Rejected = "REJECTED", // business rule violation (terminal)
  Failed = "FAILED", // permanent infrastructure error (terminal, auditable)
}

/** Kinds a provider may submit. OPENING is internal only. */
export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;
export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

/** Which kinds each kind may reference. */
const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, "kind"> {
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Wallet balance observed when the transaction reached its outcome — returned on replay. */
  resultBalance?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
}

export type ReferenceCheck =
  | { outcome: "ok" }
  | { outcome: "reject"; code: FailureCode }
  | { outcome: "wait" };

/**
 * One provider operation (or the internal OPENING credit) and its processing lifecycle.
 *
 * Valid transitions:
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (another retry scheduled)
 *   PROCESSED, REJECTED, FAILED → (none — terminal; any attempt throws InvalidTransactionStateError)
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceCheckAt?: Date,
  ) {}

  /** Born PENDING. Validates the reference requirement and amount rules per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if ((props.kind as WagerTransactionKind) === WagerTransactionKind.Opening) {
      throw new InvalidArgumentError("OPENING transactions are internal and cannot be submitted");
    }
    for (const field of ["id", "providerId", "externalTransactionId", "idempotencyKey", "payloadHash", "walletId", "playerId", "roundId", "gameId"] as const) {
      if (!props[field]) throw new InvalidArgumentError(`${field} is required`);
    }

    const tx = WagerTransaction.rehydrate({ ...props, status: WagerTransactionStatus.Pending, referenceAttempts: 0 });

    if (tx.requiresReference() && !tx.referenceExternalTransactionId) {
      throw new InvalidArgumentError(`${tx.kind} requires referenceExternalTransactionId`);
    }
    if (tx.referenceExternalTransactionId && ALLOWED_REFERENCE_KINDS[tx.kind].length === 0) {
      throw new InvalidArgumentError(`${tx.kind} cannot reference another transaction`);
    }
    if (tx.referenceExternalTransactionId === tx.externalTransactionId) {
      throw new InvalidArgumentError("a transaction cannot reference itself");
    }
    // LOSS records an outcome and may carry 0.00; every balance-moving kind needs a positive amount.
    if (tx.affectsBalance() ? !tx.money.isPositive() : tx.money.isNegative()) {
      throw new InvalidArgumentError(`${tx.kind} amount must be ${tx.affectsBalance() ? "positive" : "non-negative"}`);
    }
    return tx;
  }

  /** The internal credit that funds a wallet at opening. Created already PROCESSED. */
  static createOpening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    const tx = WagerTransaction.rehydrate({
      id: props.id,
      providerId: "internal",
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash: "-",
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: "-",
      gameId: "-",
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
    tx.markProcessed({ referenceTransactionId: undefined, balanceAfter: props.money, at: props.at });
    return tx;
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  /** When the transaction reached a terminal state (processed, rejected or failed). */
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transitions

  markProcessed(props: { referenceTransactionId: string | undefined; balanceAfter: Money; at: Date }): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._resultBalance = props.balanceAfter;
    this._processedAt = props.at;
    this._nextReferenceCheckAt = undefined;
  }

  /** Records one more failed reference lookup and schedules the next check with backoff. */
  markPendingReference(now: Date, policy: ReferenceRetryPolicy): void {
    this.assertNotTerminal("markPendingReference");
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = new Date(now.getTime() + policy.delayFor(this._referenceAttempts));
  }

  reject(code: FailureCode, props: { balance: Money; at: Date }): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = props.balance;
    this._processedAt = props.at;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidArgumentError("ROLLBACK direction depends on its reference");
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidArgumentError("LOSS does not move balance");
    }
  }

  /**
   * Validates a resolved reference against section 7 rules.
   * `alreadyReversed`: whether a PROCESSED REFUND/ROLLBACK already points to this reference.
   */
  checkReference(reference: WagerTransaction, opts: { alreadyReversed: boolean }): ReferenceCheck {
    if (!ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind)) {
      return { outcome: "reject", code: FailureCode.InvalidReferenceKind };
    }
    const sameScope =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameScope) return { outcome: "reject", code: FailureCode.ReferenceMismatch };

    if (!reference.isTerminal()) return { outcome: "wait" };
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { outcome: "reject", code: FailureCode.ReferenceNotProcessed };
    }
    if (this.isReversal()) {
      if (!reference.money.equals(this.money)) return { outcome: "reject", code: FailureCode.AmountMismatch };
      if (opts.alreadyReversed) return { outcome: "reject", code: FailureCode.AlreadyReversed };
    }
    return { outcome: "ok" };
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `cannot ${transition}: transaction ${this.id} is already ${this._status}`,
      );
    }
  }
}
