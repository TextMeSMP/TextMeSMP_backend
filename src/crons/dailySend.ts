import { pool } from "../db/pool";
import { getSmsSender } from "../sms/getSender";

/**
 * Daily lesson sender (MVP)
 *
 * Key safety: we "reserve" a sent_messages row BEFORE sending, using the UNIQUE constraint.
 * That prevents duplicate sends if the job runs twice.
 */
export async function sendDailyLessons(): Promise<{ attempted: number; sent: number }> {
  const sms = getSmsSender();
  const client = await pool.connect();

  let attempted = 0;
  let sent = 0;

  try {
    // Compute day_number in SQL using CURRENT_DATE so timezones stay consistent.
    const rowsRes = await client.query(
      `
      SELECT
        cu.id AS cohort_user_id,
        u.phone_number,
        c.role_level,
        c.duration_days,
        (CURRENT_DATE - c.start_date + 1)::int AS day_number
      FROM cohort_users cu
      JOIN users u ON u.id = cu.user_id
      JOIN cohorts c ON c.id = cu.cohort_id
      WHERE u.status = 'active'
        AND CURRENT_DATE >= c.start_date
        AND CURRENT_DATE <= (c.start_date + (c.duration_days - 1))
      `
    );

    for (const row of rowsRes.rows as Array<{
      cohort_user_id: number;
      phone_number: string;
      role_level: string;
      duration_days: number;
      day_number: number;
    }>) {
      attempted += 1;

      const dayNumber = row.day_number;
      if (dayNumber < 1 || dayNumber > row.duration_days) continue;

      const lessonRes = await client.query(
        `SELECT id, day_number, title, lesson_text, action_text, reflection_question
         FROM lessons
         WHERE role_level = $1 AND day_number = $2`,
        [row.role_level, dayNumber]
      );

      if (lessonRes.rowCount === 0) continue;
      const lesson = lessonRes.rows[0] as {
        id: number;
        day_number: number;
        title: string;
        lesson_text: string;
        action_text: string;
        reflection_question: string;
      };

      // Reserve a row first (idempotency)
      const reserveRes = await client.query(
        `
        INSERT INTO sent_messages (cohort_user_id, lesson_id)
        VALUES ($1, $2)
        ON CONFLICT (cohort_user_id, lesson_id) DO NOTHING
        RETURNING id
        `,
        [row.cohort_user_id, lesson.id]
      );

      if (reserveRes.rowCount === 0) {
        // Already sent
        continue;
      }

      const sentMessageId = reserveRes.rows[0].id as number;

      const messageBody =
        `Day ${lesson.day_number}: ${lesson.title}\n` +
        `${lesson.lesson_text}\n` +
        `Action: ${lesson.action_text}\n` +
        `Reply: ${lesson.reflection_question}`;

      try {
        const result = await sms.sendSms({
          to: row.phone_number,
          body: messageBody,
        });

        await client.query(
          `UPDATE sent_messages SET message_sid = $1 WHERE id = $2`,
          [result.sid, sentMessageId]
        );

        sent += 1;
      } catch (err) {
        // If sending fails, delete reservation so the next run can retry.
        await client.query(`DELETE FROM sent_messages WHERE id = $1`, [sentMessageId]);
        console.error("Failed to send SMS:", err);
      }
    }

    return { attempted, sent };
  } finally {
    client.release();
  }
}
