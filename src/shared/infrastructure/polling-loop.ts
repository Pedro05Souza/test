import type { Logger } from "../application/ports";

/**
 * Runs `step` repeatedly until stopped. `step` returns true when it did a full batch of work
 * (so the next iteration starts immediately) and false when idle (sleep `idleMs`).
 * Errors are logged and followed by a short pause; the loop never dies on its own.
 */
export class PollingLoop {
  private running?: Promise<void>;
  private stopping = false;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly step: () => Promise<boolean>,
    private readonly idleMs: number,
    private readonly logger: Logger,
    private readonly errorPauseMs = 1_000,
  ) {}

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.loop();
    this.logger.info("worker started", { worker: this.name });
  }

  /** Lets the current iteration finish (up to graceMs), then resolves. */
  async stop(graceMs: number): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.wake?.();
    const finished = await Promise.race([
      this.running.then(() => true),
      Bun.sleep(graceMs).then(() => false),
    ]);
    this.logger.info("worker stopped", { worker: this.name, drained: finished });
    this.running = undefined;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let busy = false;
      try {
        busy = await this.step();
      } catch (error) {
        this.logger.error("worker iteration failed", {
          worker: this.name,
          err: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
        await this.pause(this.errorPauseMs);
        continue;
      }
      if (!busy) await this.pause(this.idleMs);
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
