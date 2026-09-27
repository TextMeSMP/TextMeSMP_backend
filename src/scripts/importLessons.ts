// src/scripts/importLessons.ts
import "dotenv/config"; // MUST be first so DATABASE_URL is available before pool is imported

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pool } from "../db/pool";

/**
 * Accept day_number as number or numeric string.
 * Accept action as either action_text or action_step (we normalize to action_text).
 */
const LessonSchema = z
  .object({
    role_level: z.enum(["agent", "lead", "supervisor", "manager", "executive"]),
    day_number: z.union([z.number(), z.string()]),
    title: z.string().min(1),
    lesson_text: z.string().min(1),
    action_text: z.string().min(1).optional(),
    action_step: z.string().min(1).optional(),
    reflection_question: z.string().min(1),
  })
  .transform((l) => {
    const day =
      typeof l.day_number === "string"
        ? Number.parseInt(l.day_number, 10)
        : l.day_number;

    if (!Number.isInteger(day) || day < 1) {
      throw new Error(`Invalid day_number: ${l.day_number}`);
    }

    const action = (l.action_text ?? l.action_step ?? "").trim();
    if (!action) {
      throw new Error(
        `Missing action_text/action_step for role=${l.role_level} day=${day}`
      );
    }

    return {
      role_level: l.role_level,
      day_number: day,
      title: l.title.trim(),
      lesson_text: l.lesson_text.trim(),
      action_text: action,
      reflection_question: l.reflection_question.trim(),
    };
  });

const LessonsFileSchema = z.array(LessonSchema).min(1);

function usage() {
  console.log(`
Usage:
  npx tsx src/scripts/importLessons.ts <path-to-json> [--mode=upsert|skip]

Examples:
  npx tsx src/scripts/importLessons.ts data/lessons/agent.json
  npx tsx src/scripts/importLessons.ts data/lessons/lead.json --mode=skip
`);
}

async function ensureUniqueConstraint() {
  // ON CONFLICT (role_level, day_number) needs a unique index/constraint
  const res = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname='public'
      AND tablename='lessons'
      AND indexdef ILIKE '%(role_level, day_number)%'
      AND indexdef ILIKE '%unique%';
  `);

  if (res.rowCount === 0) {
    throw new Error(
      `Missing UNIQUE index on lessons(role_level, day_number).
Run this once:
psql "...sms_mvp" -c "CREATE UNIQUE INDEX IF NOT EXISTS lessons_role_day_unique ON lessons (role_level, day_number);"`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => !a.startsWith("--"));
  const modeArg = args.find((a) => a.startsWith("--mode="));
  const mode = (modeArg?.split("=")[1] ?? "upsert") as "upsert" | "skip";

  if (!fileArg) {
    usage();
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Check that your .env is in the backend root and has DATABASE_URL=..."
    );
  }

  await ensureUniqueConstraint();

  const filePath = path.resolve(process.cwd(), fileArg);
  const raw = await fs.readFile(filePath, "utf-8");

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${fileArg}: ${(e as Error).message}`);
  }

  let lessons: Array<{
    role_level: "agent" | "lead" | "supervisor" | "manager" | "executive";
    day_number: number;
    title: string;
    lesson_text: string;
    action_text: string;
    reflection_question: string;
  }>;

  try {
    lessons = LessonsFileSchema.parse(json);
  } catch (e: any) {
    console.error("JSON validation failed. Fix these issues in your lesson file:");
    console.error(e?.errors ?? e);
    process.exit(1);
    return;
  }

  // Prevent duplicates in the JSON file itself
  const seen = new Set<string>();
  for (const l of lessons) {
    const key = `${l.role_level}:${l.day_number}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate lesson in JSON: ${key}`);
    }
    seen.add(key);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const l of lessons) {
      if (mode === "skip") {
        const res = await client.query(
          `
          INSERT INTO lessons (role_level, day_number, title, lesson_text, action_text, reflection_question)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (role_level, day_number) DO NOTHING
          RETURNING id
          `,
          [
            l.role_level,
            l.day_number,
            l.title,
            l.lesson_text,
            l.action_text,
            l.reflection_question,
          ]
        );

        if (res.rowCount === 1) inserted++;
        else skipped++;
      } else {
        const res = await client.query(
          `
          INSERT INTO lessons (role_level, day_number, title, lesson_text, action_text, reflection_question)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (role_level, day_number)
          DO UPDATE SET
            title = EXCLUDED.title,
            lesson_text = EXCLUDED.lesson_text,
            action_text = EXCLUDED.action_text,
            reflection_question = EXCLUDED.reflection_question
          RETURNING (xmax = 0) AS inserted
          `,
          [
            l.role_level,
            l.day_number,
            l.title,
            l.lesson_text,
            l.action_text,
            l.reflection_question,
          ]
        );

        const wasInserted = !!res.rows[0]?.inserted;
        if (wasInserted) inserted++;
        else updated++;
      }
    }

    await client.query("COMMIT");

    console.log("Import complete:", {
      file: fileArg,
      total: lessons.length,
      inserted,
      updated,
      skipped,
      mode,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

main().catch((err) => {
  console.error("Import failed:", err?.message ?? err);
  process.exit(1);
});
