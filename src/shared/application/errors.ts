/**
 * Errors raised by use cases. `category` drives the transport mapping consistently across all
 * endpoints and the SQS consumer:
 *
 * | category    | HTTP | SQS consumer                     | provider should…            |
 * |-------------|------|----------------------------------|-----------------------------|
 * | validation  | 400  | permanent → DLQ                  | fix the payload             |
 * | not_found   | 404  | permanent → DLQ                  | check ids                   |
 * | conflict    | 409  | permanent → DLQ                  | not resend this key/payload |
 * | transient   | 503  | retry with backoff (no ack)      | retry the same request      |
 *
 * Business rejections are NOT errors: they are persisted REJECTED transactions (HTTP 422, SQS ack).
 */
export type ErrorCategory = "validation" | "not_found" | "conflict" | "transient";

export abstract class ApplicationError extends Error {
  abstract readonly category: ErrorCategory;
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly category = "validation";
  readonly code = "INVALID_PAYLOAD";

  constructor(
    message: string,
    readonly issues: readonly { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly category = "not_found";
  readonly code = "WALLET_NOT_FOUND";
}

export class TransactionNotFoundError extends ApplicationError {
  readonly category = "not_found";
  readonly code = "TRANSACTION_NOT_FOUND";
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly category = "conflict";
  readonly code = "WALLET_ALREADY_EXISTS";
}

/** Same idempotency key (or same provider + external id) with a different payload. Never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly category = "conflict";
  readonly code = "IDEMPOTENCY_CONFLICT";
}

/**
 * A database uniqueness constraint fired. Use cases decide what it means (e.g. a concurrent
 * insert of the same idempotency key → re-run and replay).
 */
export class UniqueViolationError extends ApplicationError {
  readonly category = "conflict";
  readonly code = "UNIQUE_VIOLATION";

  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`unique constraint violated: ${constraint ?? "unknown"}`, options);
  }
}

/** Database/broker unavailable, lock timeout, deadlock, … — safe to retry the identical request. */
export class TransientInfrastructureError extends ApplicationError {
  readonly category = "transient";
  readonly code = "TEMPORARILY_UNAVAILABLE";
}
