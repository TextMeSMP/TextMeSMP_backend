import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/pool";

async function main() {
  const sqlDirectory = path.resolve(process.cwd(), "sql");
  const migrations = (await readdir(sqlDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name) && name !== "002_seed_sample.sql")
    .sort((a, b) => a.localeCompare(b));

  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  for (const name of migrations) {
    const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
    if (exists.rowCount) continue;
    const sql = await readFile(path.join(sqlDirectory, name), "utf8");
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    console.log(`Applied migration: ${name}`);
  }
}

main()
  .catch((error) => { console.error("Migration failed:", error); process.exitCode = 1; })
  .finally(async () => pool.end());
