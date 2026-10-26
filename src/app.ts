import "reflect-metadata";
import type { INestApplication, LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { AppModule } from "./app.module";
import { LOGGER, type Logger } from "./shared/application/ports";
import { HttpErrorFilter } from "./shared/http/error.filter";

/** Routes Nest's own framework logs through the structured logger. */
class NestLoggerBridge implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string) {
    this.logger.debug(String(message), { context });
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error(String(message), { context, trace });
  }
  warn(message: unknown, context?: string) {
    this.logger.warn(String(message), { context });
  }
}

export interface CreateAppOptions {
  runMigrations?: boolean;
}

export async function createApp(options: CreateAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get<Logger>(LOGGER);
  app.useLogger(new NestLoggerBridge(logger));
  app.useGlobalFilters(new HttpErrorFilter(logger));
  app.enableShutdownHooks();
  if (options.runMigrations) {
    const applied = await app.get(MikroORM).migrator.up();
    logger.info("migrations applied", { count: applied.length });
  }
  return app;
}
