/**
 * Base class for errors raised when a domain rule refuses an operation.
 * `code` is stable and machine-readable; adapters map it to transport-level responses.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, actual: string) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

export class InvalidArgumentError extends DomainError {
  readonly code = "INVALID_ARGUMENT";
}

export class LedgerImbalanceError extends DomainError {
  readonly code = "LEDGER_IMBALANCE";
}

/**
 * Raised when code tries to move an aggregate through a transition that its current state forbids
 * (e.g. touching a terminal transaction). This is a programming error, not a business outcome.
 */
export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransactionStateError";
  }
}
