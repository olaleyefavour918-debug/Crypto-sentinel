import { getDb } from "../src/lib/db";
import { runMigrations } from "../src/lib/migrations";

async function main() {
  const db = getDb();
  const applied = await runMigrations(db);
  console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database already up to date.");
  await db.close();
}

main().catch((e) => {
  console.error("Migration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
