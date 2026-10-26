import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../src/shared/infrastructure/database/mikro-orm.config";

/** Usage: bun run scripts/migrate.ts up|down|pending */
const command = process.argv[2] ?? "up";
const orm = await MikroORM.init(createOrmConfig());
try {
  switch (command) {
    case "up": {
      const applied = await orm.migrator.up();
      console.log(JSON.stringify({ msg: "migrations applied", migrations: applied.map((m) => m.name) }));
      break;
    }
    case "down": {
      const reverted = await orm.migrator.down();
      console.log(JSON.stringify({ msg: "migration reverted", migrations: reverted.map((m) => m.name) }));
      break;
    }
    case "pending": {
      const pending = await orm.migrator.getPending();
      console.log(JSON.stringify({ msg: "pending migrations", migrations: pending.map((m) => m.name) }));
      break;
    }
    default:
      throw new Error(`unknown command "${command}" (expected up|down|pending)`);
  }
} finally {
  await orm.close(true);
}
