import { Controller, Get, Header, Inject } from "@nestjs/common";
import { METRICS } from "../shared/application/ports";
import type { PrometheusMetrics } from "../shared/infrastructure/observability/metrics";

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4")
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
