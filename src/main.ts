import { createApp } from "./app";
import { LOGGER, type Logger } from "./shared/application/ports";

const app = await createApp({ runMigrations: process.env.RUN_MIGRATIONS === "true" });
await app.listen(Number(process.env.PORT ?? 3000));
const { port } = app.getHttpServer().address() as { port: number };
app.get<Logger>(LOGGER).info("http server listening", { port });
