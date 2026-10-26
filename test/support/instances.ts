import { join } from "node:path";
import type { Subprocess } from "bun";

const ROOT = join(import.meta.dir, "..", "..");

export interface Instance {
  name: string;
  baseUrl: string;
  proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Parsed JSON log lines emitted so far. */
  logs: Record<string, any>[];
  /** Resolves with the exit code, or the terminating signal name (e.g. "SIGKILL"). */
  exited: Promise<number | string>;
  /** Hard kill (no graceful shutdown). */
  kill(): void;
  /** SIGTERM and wait for a graceful exit. */
  stop(): Promise<number | string>;
}

/**
 * Starts the real service as a separate OS process (own event loop, own DB pool, own workers),
 * exactly like a production replica. Resolves once it listens and reports ready.
 */
export async function startInstance(name: string, env: Record<string, string>): Promise<Instance> {
  const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: "0", LOG_LEVEL: "info", INSTANCE_ID: name, DB_POOL_MAX: "10", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const logs: Record<string, any>[] = [];
  let portResolve!: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => (portResolve = resolve));

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const entry = JSON.parse(line);
          logs.push(entry);
          if (entry.msg === "http server listening") portResolve(entry.port);
        } catch {
          // non-JSON output (should not happen) is ignored
        }
      }
    }
  })();
  void (async () => {
    for await (const _ of proc.stderr) {
      // drain so the child never blocks on a full pipe
    }
  })();

  const exited = proc.exited.then(() => proc.signalCode ?? proc.exitCode ?? -1);
  const port = await Promise.race([
    portPromise,
    exited.then((code) => {
      throw new Error(`instance ${name} exited during startup (${code})`);
    }),
    Bun.sleep(30_000).then(() => {
      throw new Error(`instance ${name} did not start in 30s`);
    }),
  ]);
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    const ready = await fetch(`${baseUrl}/health/ready`).then((r) => r.ok).catch(() => false);
    if (ready) break;
    await Bun.sleep(100);
  }
  return {
    name,
    baseUrl,
    proc,
    logs,
    exited,
    kill: () => proc.kill("SIGKILL"),
    stop: async () => {
      proc.kill("SIGTERM");
      return exited;
    },
  };
}
