import {
  TransientInfrastructureError,
  UniqueViolationError,
} from "../../application/errors";

/**
 * SQLSTATEs that mean "try again later": nothing was committed and the identical request can be
 * resubmitted safely.
 *  40001 serialization_failure · 40P01 deadlock_detected · 55P03 lock_not_available (lock_timeout)
 *  57014 query_canceled (statement_timeout) · 57P01..03 server shutting down / unavailable
 *  53300 too_many_connections · 08xxx connection exceptions
 */
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03", "53300"]);
const TRANSIENT_NODE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

interface PgLikeError {
  code?: string;
  constraint?: string;
  name?: string;
  message?: string;
}

export function isTransientDbError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, name, message } = error as PgLikeError;
  if (code && (TRANSIENT_SQLSTATES.has(code) || code.startsWith("08") || TRANSIENT_NODE_CODES.has(code))) return true;
  if (name === "ConnectionException" || name === "DeadlockException" || name === "LockWaitTimeoutException") return true;
  return /Connection terminated|connection timeout|timeout exceeded when trying to connect/i.test(message ?? "");
}

/**
 * Translates driver errors into application errors. Anything not recognised is re-thrown as is:
 * constraint/trigger violations other than uniqueness are invariant breaches (bugs), not
 * conditions to retry.
 */
export function translateDbError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const pg = error as PgLikeError;
  if (pg.code === "23505") return new UniqueViolationError(pg.constraint, { cause: error });
  if (isTransientDbError(error)) {
    return new TransientInfrastructureError("database temporarily unavailable", { cause: error });
  }
  return error;
}
