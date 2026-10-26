import type { INestApplication } from "@nestjs/common";

process.env.LOG_LEVEL ??= "silent";

export interface RunningApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

export interface StartAppOptions {
  /** Extra environment for this app instance (queue names, timeouts…). */
  env?: Record<string, string>;
  /** Background workers are off by default so tests drive them step by step. */
  consumer?: boolean;
  publisher?: boolean;
  pendingReferenceWorker?: boolean;
}

/** Boots the real application (real Postgres, real SQS emulator, real modules) on a random port. */
export async function startApp(options: StartAppOptions = {}): Promise<RunningApp> {
  const overrides: Record<string, string> = {
    SQS_CONSUMER_ENABLED: String(options.consumer ?? false),
    OUTBOX_PUBLISHER_ENABLED: String(options.publisher ?? false),
    PENDING_REFERENCE_WORKER_ENABLED: String(options.pendingReferenceWorker ?? false),
    ...options.env,
  };
  // Config is read while the app is constructed; restore afterwards so suites don't leak settings.
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  Object.assign(process.env, overrides);
  const { createApp } = await import("../../src/app");
  let app: INestApplication;
  try {
    app = await createApp({ runMigrations: true });
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}
