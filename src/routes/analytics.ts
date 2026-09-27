import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { requirePaidOrg } from "../middleware/requirePaidOrg";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireOrgPermission } from "../middleware/requireOrgPermission";

const router = Router();

// All analytics routes require an authenticated admin
router.use(requireAuth, requireRole("manager", "org_admin"), requirePaidOrg, requireOrgPermission("view_analytics"));

// -------------------------------
// Helpers
// -------------------------------
function clamp01to100(n: number) {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Convert avg quality_score (1..3) -> percent (0..100)
 * If null, returns 0 for readiness computation (keeps score stable).
 */
function qualityToPercent(avgQuality: number | null): number {
  if (avgQuality === null || Number.isNaN(avgQuality)) return 0;
  // quality_score is 1..3 in your system; map to 0..100
  return clamp01to100(Math.round((avgQuality / 3) * 100));
}

/**
 * Compute readiness using:
 * completion% (0..100)
 * quality% (0..100)
 * behavior% (0..100)
 * weights: 40/40/20
 */
function computeReadiness(args: {
  completionPercent: number;
  avgQuality: number | null;
  reflectionsSubmitted: number;
  behaviorsObserved: number;
}): number {
  const completion = clamp01to100(args.completionPercent);
  const quality = qualityToPercent(args.avgQuality);

  const behavior =
    args.reflectionsSubmitted > 0
      ? clamp01to100(
          Math.round((args.behaviorsObserved / args.reflectionsSubmitted) * 100)
        )
      : 0;

  const readiness = Math.round(0.4 * completion + 0.4 * quality + 0.2 * behavior);
  return clamp01to100(readiness);
}

// -------------------------------
// GET /api/cohorts/:cohortId/summary
// -------------------------------
router.get("/cohorts/:cohortId/summary", asyncHandler(async (req, res) => {
  const cohortId = Number(req.params.cohortId);
  const orgId = req.auth!.organizationId;
  if (!orgId) return res.status(403).json({ error: "Organization access required" });
  if (!cohortId || Number.isNaN(cohortId)) {
    return res.status(400).json({ error: "Invalid cohort id" });
  }

  const client = await pool.connect();

  try {
    // Load cohort + computed todayDayNumber
    const cohortRes = await client.query(
      `
      SELECT
        id,
        name,
        role_level,
        start_date,
        duration_days,
        CASE
          WHEN CURRENT_DATE < start_date
            OR CURRENT_DATE > (start_date + (duration_days - 1))
          THEN NULL
          ELSE (CURRENT_DATE - start_date + 1)::int
        END AS today_day_number
      FROM cohorts
      WHERE id = $1 AND organization_id = $2
      `,
      [cohortId, orgId]
    );

    if (cohortRes.rowCount === 0) {
      return res.status(404).json({ error: "Cohort not found" });
    }

    const cohort = cohortRes.rows[0];

    // Aggregate metrics for this cohort
    const metricsRes = await client.query(
      `
      SELECT
        -- Number of learners
        (SELECT COUNT(*)::int
         FROM cohort_users cu
         WHERE cu.cohort_id = $1) AS learner_count,

        -- Total messages sent
        (SELECT COUNT(*)::int
         FROM sent_messages sm
         JOIN cohort_users cu ON cu.id = sm.cohort_user_id
         WHERE cu.cohort_id = $1) AS messages_sent,

        -- Total reflections
        (SELECT COUNT(*)::int
         FROM reflections r
         JOIN cohort_users cu ON cu.id = r.cohort_user_id
         WHERE cu.cohort_id = $1) AS reflections_count,

        -- Average reflection quality
        (SELECT AVG(r.quality_score)::float
         FROM reflections r
         JOIN cohort_users cu ON cu.id = r.cohort_user_id
         WHERE cu.cohort_id = $1
           AND r.quality_score IS NOT NULL) AS avg_quality
      `,
      [cohortId]
    );

    const m = metricsRes.rows[0];

    const learnerCount = m.learner_count as number;
    const messagesSent = m.messages_sent as number;
    const reflectionsCount = m.reflections_count as number;
    const avgQuality = (m.avg_quality as number | null) ?? null;

    const completionRate =
      messagesSent > 0
        ? Math.round((reflectionsCount / messagesSent) * 100)
        : null;

    // Daily reflections count for mini chart
    const dailyRes = await client.query(
      `
      SELECT
        l.day_number,
        (r.received_at::date) AS day,
        COUNT(*)::int AS reflections_count
      FROM reflections r
      JOIN cohort_users cu ON cu.id = r.cohort_user_id
      JOIN lessons l       ON l.id = r.lesson_id
      WHERE cu.cohort_id = $1
      GROUP BY l.day_number, day
      ORDER BY day ASC
      `,
      [cohortId]
    );

    const dailyReflections = dailyRes.rows.map((row) => ({
      dayNumber: row.day_number as number,
      date: row.day instanceof Date
        ? row.day.toISOString().slice(0, 10)
        : String(row.day),
      reflectionsCount: row.reflections_count as number,
    }));

    return res.json({
      cohort: {
        id: cohort.id,
        name: cohort.name,
        roleLevel: cohort.role_level,
        startDate: cohort.start_date,
        durationDays: cohort.duration_days,
        todayDayNumber: cohort.today_day_number,
      },
      metrics: {
        learnerCount,
        messagesSent,
        reflectionsCount,
        completionRate,
        averageReflectionQuality: avgQuality,
      },
      dailyReflections,
    });
  } catch (err) {
    console.error("Error in GET /api/cohorts/:id/summary:", err);
    return res.status(500).json({ error: "Failed to load cohort summary" });
  } finally {
    client.release();
  }
}));

// -------------------------------
// GET /api/cohort-users/:cohortUserId/progress
// -------------------------------
router.get("/cohort-users/:cohortUserId/progress", asyncHandler(async (req, res) => {
  const cohortUserId = Number(req.params.cohortUserId);
  const orgId = req.auth!.organizationId;
  if (!orgId) return res.status(403).json({ error: "Organization access required" });
  if (!cohortUserId || Number.isNaN(cohortUserId)) {
    return res.status(400).json({ error: "Invalid cohort user id" });
  }

  const client = await pool.connect();

  try {
    // 1) Load learner + cohort info
    const learnerRes = await client.query(
      `
      SELECT
        cu.id           AS cohort_user_id,
        cu.cohort_id    AS cohort_id,
        u.id            AS user_id,
        u.name          AS learner_name,
        u.phone_number,
        c.name          AS cohort_name,
        c.role_level,
        c.start_date,
        c.duration_days
      FROM cohort_users cu
      JOIN users   u ON u.id = cu.user_id
      JOIN cohorts c ON c.id = cu.cohort_id
      WHERE cu.id = $1 AND c.organization_id = $2
      `,
      [cohortUserId, orgId]
    );

    if (learnerRes.rowCount === 0) {
      return res.status(404).json({ error: "Learner not found" });
    }

    const learner = learnerRes.rows[0];

    // 2) Basic counts + behavior observed count
    const countsRes = await client.query(
      `
      SELECT
        (SELECT COUNT(*)::int
         FROM sent_messages sm
         WHERE sm.cohort_user_id = $1) AS lessons_sent,

        (SELECT COUNT(*)::int
         FROM reflections r
         WHERE r.cohort_user_id = $1) AS reflections_submitted,

        (SELECT AVG(r.quality_score)::float
         FROM reflections r
         WHERE r.cohort_user_id = $1
           AND r.quality_score IS NOT NULL) AS avg_quality,

        (SELECT COUNT(*)::int
         FROM reflections r
         WHERE r.cohort_user_id = $1
           AND r.behavior_observed = TRUE) AS behaviors_observed
      `,
      [cohortUserId]
    );

    const counts = countsRes.rows[0];
    const lessonsSent = counts.lessons_sent as number;
    const reflectionsSubmitted = counts.reflections_submitted as number;
    const avgQuality = (counts.avg_quality as number | null) ?? null;
    const behaviorsObserved = counts.behaviors_observed as number;

    const completionPercent =
      lessonsSent > 0
        ? Math.round((reflectionsSubmitted / lessonsSent) * 100)
        : 0;

    const readinessScore = computeReadiness({
      completionPercent,
      avgQuality,
      reflectionsSubmitted,
      behaviorsObserved,
    });

    // 3) Day-by-day engagement across all lessons in this role_level
    const engagementRes = await client.query(
      `
      SELECT
        l.day_number,
        l.title,
        sm.id                 IS NOT NULL AS sent,
        sm.sent_at,
        r.id                  IS NOT NULL AS reflected,
        r.received_at         AS reflection_at,
        r.quality_score,
        r.behavior_observed,
        CASE
          WHEN r.response_text IS NULL THEN NULL
          ELSE SUBSTRING(r.response_text FROM 1 FOR 160)
        END AS reflection_snippet
      FROM lessons l
      LEFT JOIN sent_messages sm
        ON sm.lesson_id = l.id
       AND sm.cohort_user_id = $1
      LEFT JOIN reflections r
        ON r.lesson_id = l.id
       AND r.cohort_user_id = $1
      WHERE l.role_level = $2
      ORDER BY l.day_number ASC
      `,
      [cohortUserId, learner.role_level]
    );

    const engagementByDay = engagementRes.rows.map((row) => ({
      dayNumber: row.day_number as number,
      title: row.title as string,
      sent: row.sent as boolean,
      sentAt: row.sent_at,
      reflectionSubmitted: row.reflected as boolean,
      reflectionAt: row.reflection_at,
      qualityScore: row.quality_score === null ? null : (row.quality_score as number),
      behaviorObserved: row.behavior_observed === null ? false : (row.behavior_observed as boolean),
      reflectionSnippet:
        row.reflection_snippet === null ? null : (row.reflection_snippet as string),
    }));

    // 4) Quality score trend: only days with a score
    const qualityTrend = engagementByDay
      .filter((d) => d.qualityScore !== null)
      .map((d) => ({
        dayNumber: d.dayNumber,
        qualityScore: d.qualityScore as number,
      }));

    return res.json({
      learner: {
        cohortUserId: learner.cohort_user_id,
        cohortId: learner.cohort_id,
        userId: learner.user_id,
        name: learner.learner_name,
        phoneNumber: learner.phone_number,
        cohortName: learner.cohort_name,
        roleLevel: learner.role_level,
        startDate: learner.start_date,
        durationDays: learner.duration_days,
      },
      stats: {
        lessonsSent,
        reflectionsSubmitted,
        completionPercent,
        averageReflectionQuality: avgQuality,
        behaviorsObserved,
        behaviorPercent:
          reflectionsSubmitted > 0
            ? Math.round((behaviorsObserved / reflectionsSubmitted) * 100)
            : 0,
        readinessScore, // ✅ Step 9 implemented
      },
      engagementByDay,
      qualityTrend,
    });
  } catch (err) {
    console.error("Error in GET /api/cohort-users/:id/progress:", err);
    return res.status(500).json({ error: "Failed to load learner progress" });
  } finally {
    client.release();
  }
}));

// -------------------------------
// GET /api/cohorts/:id/learners
// -------------------------------
router.get("/cohorts/:id/learners", asyncHandler(async (req, res) => {
  const cohortId = Number(req.params.id);
  const orgId = req.auth!.organizationId;
  if (!orgId) return res.status(403).json({ error: "Organization access required" });
  if (!cohortId || Number.isNaN(cohortId)) {
    return res.status(400).json({ error: "Invalid cohort id" });
  }

  const client = await pool.connect();
  try {
    // basic cohort info
    const cohortRes = await client.query(
      `SELECT id, name, role_level
       FROM cohorts
       WHERE id = $1 AND organization_id = $2`,
      [cohortId, orgId]
    );

    if (cohortRes.rowCount === 0) {
      return res.status(404).json({ error: "Cohort not found" });
    }

    const cohort = cohortRes.rows[0] as {
      id: number;
      name: string;
      role_level: string;
    };

    // learners + metrics
    const learnersRes = await client.query(
      `
      SELECT
        cu.id AS cohort_user_id,
        u.id AS user_id,
        u.name,
        u.role_level,
        COUNT(DISTINCT sm.id) AS messages_sent,
        COUNT(DISTINCT r.id) AS reflections_received,
        CASE
          WHEN COUNT(DISTINCT sm.id) = 0 THEN 0
          ELSE ROUND(100.0 * COUNT(DISTINCT r.id) / COUNT(DISTINCT sm.id))::int
        END AS completion_percent,
        AVG(r.quality_score)::numeric(10,2) AS avg_quality_score,
        SUM(CASE WHEN r.behavior_observed THEN 1 ELSE 0 END)::int AS behaviors_observed,
        MAX(r.received_at) AS last_reflection_at
      FROM cohort_users cu
      JOIN users u ON u.id = cu.user_id
      LEFT JOIN sent_messages sm ON sm.cohort_user_id = cu.id
      LEFT JOIN reflections r ON r.cohort_user_id = cu.id
      WHERE cu.cohort_id = $1
      GROUP BY cu.id, u.id, u.name, u.role_level
      ORDER BY u.name
      `,
      [cohortId]
    );

    const learners = learnersRes.rows.map((row) => {
      const completionPercent = Number(row.completion_percent ?? 0);
      const reflectionsSubmitted = Number(row.reflections_received ?? 0);
      const avgQuality =
        row.avg_quality_score === null ? null : Number(row.avg_quality_score);
      const behaviorsObserved = Number(row.behaviors_observed ?? 0);

      const readiness = computeReadiness({
        completionPercent,
        avgQuality,
        reflectionsSubmitted,
        behaviorsObserved,
      });

      return {
        cohort_user_id: row.cohort_user_id,
        user_id: row.user_id,
        name: row.name,
        role_level: row.role_level,
        messages_sent: Number(row.messages_sent ?? 0),
        reflections_received: reflectionsSubmitted,
        completion_percent: completionPercent,
        readiness_score:
          Number(row.messages_sent ?? 0) === 0 && reflectionsSubmitted === 0 && avgQuality === null
            ? null
            : readiness, // ✅ 0..100 score
        last_reflection_at: row.last_reflection_at,
      };
    });

    return res.json({
      cohort: {
        id: cohort.id,
        name: cohort.name,
        roleLevel: cohort.role_level,
      },
      learners,
    });
  } catch (err) {
    console.error("Error GET /api/cohorts/:id/learners", err);
    return res.status(500).json({ error: "Failed to load cohort learners" });
  } finally {
    client.release();
  }
}));
router.patch("/reflections/:reflectionId/behavior", asyncHandler(async (req, res) => {
  const reflectionId = Number(req.params.reflectionId);
  const orgId = req.auth?.organizationId;

  if (!orgId) return res.status(401).json({ error: "Missing org in token" });
  if (!reflectionId || Number.isNaN(reflectionId)) {
    return res.status(400).json({ error: "Invalid reflection id" });
  }

  const behaviorObserved = !!req.body?.behaviorObserved;

  try {
    // security: ensure this reflection belongs to this org
    const result = await pool.query(
      `
      UPDATE reflections r
      SET behavior_observed = $2
      FROM cohort_users cu
      JOIN cohorts c ON c.id = cu.cohort_id
      WHERE r.id = $1
        AND r.cohort_user_id = cu.id
        AND c.organization_id = $3
      RETURNING r.id, r.behavior_observed
      `,
      [reflectionId, behaviorObserved, orgId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Reflection not found for this org" });
    }

    return res.json({
      reflectionId: result.rows[0].id,
      behaviorObserved: result.rows[0].behavior_observed,
    });
  } catch (e) {
    console.error("PATCH /reflections/:id/behavior failed", e);
    return res.status(500).json({ error: "Failed to update behavior" });
  }
}));


export default router;
