import type { InboxRepository, OutboxRepository } from "../../messaging/application/ports";
import type { WagerTransactionRepository } from "../../wagering/application/ports";
import type { LedgerRepository, WalletRepository } from "../../wallet/application/ports";

export const CLOCK = Symbol("Clock");
export interface Clock {
  now(): Date;
}

export const ID_GENERATOR = Symbol("IdGenerator");
export interface IdGenerator {
  /** Time-ordered unique id (UUIDv7). */
  next(): string;
}

/** Repositories bound to one database transaction. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export const UNIT_OF_WORK = Symbol("UnitOfWork");
/**
 * Runs `work` inside ONE database transaction. Everything written through the given repositories
 * is committed atomically when `work` resolves, or rolled back when it throws.
 * Infrastructure failures surface as TransientInfrastructureError.
 */
export interface UnitOfWork {
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const METRICS = Symbol("Metrics");
export type ProcessingSource = "http" | "sqs" | "worker";
export interface Metrics {
  transactionOutcome(status: string, kind: string, source: ProcessingSource): void;
  duplicateDetected(type: "idempotent_replay" | "inbox_redelivery" | "idempotency_conflict"): void;
  lockConflict(resource: "wallet"): void;
  processingDuration(source: ProcessingSource, seconds: number): void;
  retry(component: "uow" | "sqs_consumer" | "outbox" | "pending_reference"): void;
  deadLettered(reason: string): void;
  reconciliation(consistent: boolean): void;
  outboxLag(seconds: number): void;
  outboxPublished(count: number): void;
}

export const LOGGER = Symbol("Logger");
/** Structured logger. Fields must never contain full financial payloads or personal data. */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
