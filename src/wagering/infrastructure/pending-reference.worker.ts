import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { LOGGER, type Logger } from "../../shared/application/ports";
import { PollingLoop } from "../../shared/infrastructure/polling-loop";
import { ResolvePendingReferences } from "../application/resolve-pending-references";

const BATCH_SIZE = 50;

/** Scheduled worker for PENDING_REFERENCE transactions (enabled on every instance by default). */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(@Inject(ResolvePendingReferences) resolver: ResolvePendingReferences, @Inject(LOGGER) logger: Logger) {
    this.loop = new PollingLoop(
      "pending-reference-worker",
      async () => (await resolver.runOnce(BATCH_SIZE)).checked >= BATCH_SIZE,
      Number(process.env.PENDING_REFERENCE_POLL_MS ?? 500),
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if ((process.env.PENDING_REFERENCE_WORKER_ENABLED ?? "true") === "true") this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop(Number(process.env.SHUTDOWN_GRACE_MS ?? 15_000));
  }
}
