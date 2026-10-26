import type { MikroORM } from "@mikro-orm/postgresql";
import {
  MikroOrmInboxRepository,
  MikroOrmOutboxRepository,
} from "../../../messaging/infrastructure/messaging.repositories";
import { MikroOrmWagerTransactionRepository } from "../../../wagering/infrastructure/wager-transaction.repository";
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from "../../../wallet/infrastructure/wallet.repositories";
import type { Clock, Metrics, TransactionalRepositories, UnitOfWork } from "../../application/ports";
import { translateDbError } from "./db-errors";

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/**
 * One `run` = one forked EntityManager (isolated identity map) + one SQL transaction.
 * MikroORM's Unit of Work flushes every tracked change (wallet, transaction, ledger, inbox,
 * outbox) at the end of `transactional`, in FK order, and commits — or rolls everything back.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  ) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // Bound the wait for a hot wallet's row lock; exceeding it is a transient (retryable) failure.
        await em.execute(`SET LOCAL lock_timeout = '${Math.trunc(this.lockTimeoutMs)}ms'`);
        return work({
          wallets: new MikroOrmWalletRepository(em, this.metrics),
          ledger: new MikroOrmLedgerRepository(em),
          transactions: new MikroOrmWagerTransactionRepository(em, () => this.clock.now()),
          inbox: new MikroOrmInboxRepository(em),
          outbox: new MikroOrmOutboxRepository(em),
        });
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }
}
