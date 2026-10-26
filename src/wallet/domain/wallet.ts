import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidArgumentError,
} from "../../shared/domain/errors";
import { Money } from "../../shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identifiers and timestamp for the ledger line a balance movement produces. */
export interface MovementContext {
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Required when initialBalance > 0: the internal OPENING transaction and its ledger line. */
  opening?: { transactionId: string; ledgerEntryId: string };
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry?: WalletLedgerEntry;
}

/**
 * Aggregate root for a player's balance in one currency.
 *
 * Invariants:
 * - balance is never negative;
 * - every balance change produces exactly one ledger entry (debit/credit return it);
 * - operations must be in the wallet's currency;
 * - version starts at 1 and increments only when the balance changes.
 *
 * Concurrency (no lost updates across instances) is enforced by the repository: the wallet row is
 * locked (SELECT … FOR UPDATE) for the whole transaction, and updates are additionally guarded by
 * `version`.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { id, playerId, initialBalance, opening, at } = props;
    if (!playerId) throw new InvalidArgumentError("playerId is required");
    if (initialBalance.isNegative()) throw new InvalidArgumentError("initial balance cannot be negative");

    const wallet = new Wallet(id, playerId, initialBalance.currency, initialBalance, 1, at, at);
    if (initialBalance.isZero()) return { wallet };

    if (!opening) {
      throw new InvalidArgumentError("a positive initial balance requires an OPENING transaction");
    }
    const openingEntry = WalletLedgerEntry.create({
      id: opening.ledgerEntryId,
      walletId: id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(`insufficient funds in wallet ${this.id}`);
    }
    return this.move(LedgerDirection.Debit, money, ctx);
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.move(LedgerDirection.Credit, money, ctx);
  }

  /** Applies a movement in the given direction (used by ROLLBACK, whose direction is derived). */
  apply(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(money, ctx) : this.credit(money, ctx);
  }

  private move(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    if (!money.isPositive()) throw new InvalidArgumentError("movement amount must be positive");

    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);

    // Builds and validates the entry before mutating, so a failure leaves the wallet untouched.
    const entry = WalletLedgerEntry.create({
      id: ctx.ledgerEntryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: ctx.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
