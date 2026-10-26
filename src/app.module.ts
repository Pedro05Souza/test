import { Inject, Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { HEALTH_CHECKS, HealthController, type HealthCheck } from "./health/health.controller";
import { MetricsController } from "./health/metrics.controller";
import { MessagingModule, SQS_HEALTH_CHECK } from "./messaging/messaging.module";
import { LOGGER, type Logger } from "./shared/application/ports";
import { correlationMiddleware } from "./shared/http/correlation.middleware";
import { DATABASE_HEALTH_CHECK, InfrastructureModule } from "./shared/infrastructure/infrastructure.module";
import { WageringModule } from "./wagering/wagering.module";
import { WalletModule } from "./wallet/wallet.module";

@Module({
  imports: [InfrastructureModule, WalletModule, WageringModule, MessagingModule],
  controllers: [HealthController, MetricsController],
  providers: [
    {
      provide: HEALTH_CHECKS,
      inject: [DATABASE_HEALTH_CHECK, SQS_HEALTH_CHECK],
      useFactory: (...checks: HealthCheck[]) => checks,
    },
  ],
})
export class AppModule implements NestModule {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware(this.logger)).forRoutes("*");
  }
}
