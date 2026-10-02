import { Router } from "express";
import { pool } from "../db/pool";
import { asyncHandler } from "../middleware/asyncHandler";
import twilio from "twilio";

const router = Router();

/**
 * Simple heuristic: quality_score = 1..3
 * 1 = very short/low effort
 * 2 = normal response
 * 3 = thoughtful (longer or includes reflective keywords)
 */
function autoQualityScore(text: string): 1 | 2 | 3 {
  const t = text.trim().toLowerCase();
  const len = t.length;

  const keywords = [
    "because",
    "so that",
    "next time",
    "i will",
    "i'll",
    "learned",
    "i learned",
    "i realised",
    "i realized",
    "my plan",
    "i plan",
    "i tried",
    "i did",
  ];

  const hasKeyword = keywords.some((k) => t.includes(k));

  if (len > 80 || hasKeyword) return 3;
  if (len >= 20) return 2;
  return 1;
}

// Twilio sends application/x-www-form-urlencoded
// Make sure app.ts has: app.use(express.urlencoded({ extended: false }));
router.post("/inbound", asyncHandler(async (req, res) => {
  const signature = req.get("x-twilio-signature");
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const configuredUrl = process.env.TWILIO_WEBHOOK_URL;
  const requestUrl =
    configuredUrl ?? `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  if (
    !signature ||
    !authToken ||
    !twilio.validateRequest(authToken, signature, requestUrl, req.body)
  ) {
    return res.status(403).type("text/xml").send("<Response></Response>");
  }

  const fromRaw = String(req.body.From || "");
  const bodyRaw = String(req.body.Body || "");

  // Normalize phone number (handle whatsapp: prefix)
  const fromPhone = fromRaw.startsWith("whatsapp:")
    ? fromRaw.replace("whatsapp:", "")
    : fromRaw;

  const reflectionText = bodyRaw.trim();

  if (!fromPhone || !reflectionText) {
    res.type("text/xml").send("<Response></Response>");
    return;
  }

  const qualityScore = autoQualityScore(reflectionText);

  const client = await pool.connect();

  try {
    // 1) Find user by phone_number
    const userRes = await client.query(
      `
      SELECT id
      FROM users
      WHERE phone_number = $1
      LIMIT 1
      `,
      [fromPhone]
    );

    if (userRes.rowCount === 0) {
      res.type("text/xml").send("<Response></Response>");
      return;
    }

    const userId: number = userRes.rows[0].id;

    // 2) Find MOST RECENT sent message for this user
    const sentRes = await client.query(
      `
      SELECT sm.id        AS sent_message_id,
             sm.cohort_user_id,
             sm.lesson_id
      FROM sent_messages sm
      JOIN cohort_users cu ON cu.id = sm.cohort_user_id
      WHERE cu.user_id = $1
      ORDER BY sm.sent_at DESC
      LIMIT 1
      `,
      [userId]
    );

    if (sentRes.rowCount === 0) {
      res.type("text/xml").send("<Response></Response>");
      return;
    }

    const sent = sentRes.rows[0] as {
      sent_message_id: number;
      cohort_user_id: number;
      lesson_id: number;
    };

    // 3) Insert reflection with auto quality_score
   

    // Option B (recommended): ONLY one reflection per lesson (requires UNIQUE constraint)
    // If you add:
    //   CREATE UNIQUE INDEX reflections_one_per_lesson
    //   ON reflections (cohort_user_id, lesson_id);
    //
    // Then use this UPSERT instead of Option A:
    //
    await client.query(
      `
      INSERT INTO reflections (cohort_user_id, lesson_id, response_text, quality_score)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (cohort_user_id, lesson_id)
      DO UPDATE SET
        response_text = EXCLUDED.response_text,
        quality_score = EXCLUDED.quality_score,
        received_at = NOW()
      `,
      [sent.cohort_user_id, sent.lesson_id, reflectionText, qualityScore]
    );

    // 4) Return TwiML acknowledgement
    const twiml =
      "<Response>" +
      "<Message>Thanks for your reflection. Keep going – one day at a time.</Message>" +
      "</Response>";

    res.type("text/xml").send(twiml);
  } catch (err) {
    console.error("Error in /twilio/inbound:", err);
    res.type("text/xml").status(200).send("<Response></Response>");
  } finally {
    client.release();
  }
}));

export default router;
