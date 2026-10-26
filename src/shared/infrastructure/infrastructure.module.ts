import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { HealthCheck } from "../../health/health.controller";
import { ReferenceRetryPolicy } from "../../wagering/domain/reference-retry-policy";
import { REFERENCE_RETRY_POLICY } from "../../wagering/application/process-wager-transaction";
import {
  CLOCK,
  ID_GENERATOR,
  LOGGER,
  METRICS,
  UNIT_OF_WORK,
  type Clock,
  type Metrics,
} from "../application/ports";
import { createOrmConfig } from "./database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "./database/mikro-orm-unit-of-work";
import { createLogger } from "./observability/logger";
import { PrometheusMetrics } from "./observability/metrics";
import { SystemClock, UuidV7Generator } from "./system";

export const DATABASE_HEALTH_CHECK = Symbol("DatabaseHealthCheck");

/** Closes the connection pool after in-flight work has drained (Nest calls this on SIGTERM). */
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

/** Adapters for every application port. Global so feature modules only declare their use cases. */
@Global()
@Module({
  providers: [
    { provide: MikroORM, useFactory: () => MikroORM.init(createOrmConfig()) },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: METRICS, useFactory: () => new PrometheusMetrics() },
    { provide: LOGGER, useFactory: () => createLogger() },
    {
      provide: REFERENCE_RETRY_POLICY,
      useFactory: () =>
        new ReferenceRetryPolicy(
          Number(process.env.REFERENCE_MAX_ATTEMPTS ?? 10),
          Number(process.env.REFERENCE_BASE_DELAY_MS ?? 2_000),
          Number(process.env.REFERENCE_MAX_DELAY_MS ?? 300_000),
        ),
    },
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, CLOCK, METRICS],
      useFactory: (orm: MikroORM, clock: Clock, metrics: Metrics) =>
        new MikroOrmUnitOfWork(orm, clock, metrics, Number(process.env.DB_LOCK_TIMEOUT_MS ?? 5_000)),
    },
    {
      provide: DATABASE_HEALTH_CHECK,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): HealthCheck => ({
        name: "postgres",
        check: async () => {
          await orm.em.fork().execute("SELECT 1");
        },
      }),
    },
    DatabaseLifecycle,
  ],
  exports: [MikroORM, CLOCK, ID_GENERATOR, METRICS, LOGGER, REFERENCE_RETRY_POLICY, UNIT_OF_WORK, DATABASE_HEALTH_CHECK],
})
export class InfrastructureModule {}
