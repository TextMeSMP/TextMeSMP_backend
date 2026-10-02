import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/pool";

async function main() {
  const migration = process.argv[2];

  if (!migration) {
    throw new Error("Usage: tsx src/scripts/runMigration.ts <sql-file>");
  }

  const migrationPath = path.resolve(process.cwd(), migration);
  const sql = await readFile(migrationPath, "utf8");

  await pool.query(sql);
  console.log(`Applied migration: ${migration}`);
}

main()
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
