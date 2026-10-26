import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

/**
 * Private Decimal constructor so the global decimal.js configuration is never touched.
 * Amounts have scale 2 and at most 18 integer digits (NUMERIC(20,2)), so add/subtract are always exact;
 * precision 40 leaves ample headroom and no operation here ever needs rounding.
 */
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 });
type Dec = InstanceType<typeof Dec>;

export const MONEY_SCALE = 2;

/** Non-negative decimal, no leading zeros, up to 18 integer digits and up to 2 fractional digits. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Immutable monetary value. Every operation returns a new instance.
 *
 * Input contract (`from`): decimal string, non-negative, at most 2 fractional digits, no exponent,
 * no sign, no whitespace. Values with more than 2 decimals are rejected rather than rounded —
 * silently rounding money is a correctness bug, not a convenience.
 * Output (`toJSON`): always fixed scale 2, e.g. "25.00".
 */
export class Money {
  private constructor(
    private readonly value: Dec,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("money must be an object with amount and currency");
    }
    const { amount, currency } = props;
    Money.assertCurrencyCode(currency);
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        "amount must be a non-negative decimal string with at most 2 decimal places",
      );
    }
    return new Money(new Dec(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrencyCode(currency);
    return new Money(new Dec(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(MONEY_SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(MONEY_SCALE)} ${this.currency}`;
  }

  /** Normalizes -0 to 0 so serialization never yields "-0.00". */
  private static of(value: Dec, currency: string): Money {
    return new Money(value.isZero() ? new Dec(0) : value, currency);
  }

  private static assertCurrencyCode(currency: unknown): asserts currency is string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError("currency must be an ISO-4217 code (3 uppercase letters)");
    }
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
