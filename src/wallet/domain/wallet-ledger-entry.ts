import { InvalidArgumentError, LedgerImbalanceError } from "../../shared/domain/errors";
import { Money } from "../../shared/domain/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * One immutable line of a wallet's ledger. There are no mutable fields and no transition
 * methods: once created, an entry can only be read. The database enforces the same
 * (append-only trigger + arithmetic CHECK).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.money.isPositive()) {
      throw new InvalidArgumentError("ledger entry amount must be positive");
    }
    if (entry.balanceAfter.isNegative()) {
      throw new LedgerImbalanceError("ledger entry would leave a negative balance");
    }
    if (!entry.isBalanced()) {
      throw new LedgerImbalanceError(
        `ledger entry does not balance: ${entry.balanceBefore} ${entry.direction} ${entry.money} != ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** The signed effect of this entry on the balance: +money for credits, -money for debits. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  /** balanceBefore ± money === balanceAfter (also implies all three share one currency). */
  isBalanced(): boolean {
    return this.balanceBefore.add(this.signedAmount()).equals(this.balanceAfter);
  }
}
