import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { requirePaidOrg } from "../middleware/requirePaidOrg";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireOrgPermission } from "../middleware/requireOrgPermission";

const router = Router();
const roleLevel = z.enum(["agent", "lead", "supervisor", "manager", "executive"]);
const createCohortSchema = z.object({
  name: z.string().trim().min(2).max(120),
  roleLevel,
  startDate: z.string().date(),
  durationDays: z.number().int().min(1).max(365),
}).strict();

router.use(requireAuth, requireRole("manager", "org_admin"), requirePaidOrg);

router.get("/", requireOrgPermission("view_cohort_data"), asyncHandler(async (req, res) => {
  const orgId = req.auth!.organizationId;
  if (!orgId) return res.status(403).json({ error: "Organization access required" });
  const result = await pool.query(
    `SELECT c.id,c.name,c.role_level,c.start_date,c.duration_days,
            CASE WHEN c.status='archived' THEN 'completed'
                 WHEN CURRENT_DATE<c.start_date THEN 'upcoming'
                 WHEN CURRENT_DATE>c.start_date+(c.duration_days-1) THEN 'completed'
                 ELSE 'active' END AS lifecycle_status,
            COUNT(DISTINCT cu.id)::int AS learner_count,
            COUNT(DISTINCT sm.id)::int AS messages_sent,
            COUNT(DISTINCT r.id)::int AS reflections_count,
            CASE WHEN COUNT(DISTINCT sm.id)=0 THEN 0
                 ELSE ROUND(100.0*COUNT(DISTINCT r.id)/COUNT(DISTINCT sm.id))::int END AS completion_rate,
            AVG(r.quality_score)::float AS average_reflection_quality
     FROM cohorts c
     LEFT JOIN cohort_users cu ON cu.cohort_id=c.id
     LEFT JOIN sent_messages sm ON sm.cohort_user_id=cu.id
     LEFT JOIN reflections r ON r.cohort_user_id=cu.id AND r.lesson_id=sm.lesson_id
     WHERE c.organization_id=$1
     GROUP BY c.id ORDER BY c.start_date DESC,c.id DESC`,
    [orgId]
  );
  return res.json({ cohorts: result.rows });
}));

router.post("/", requireRole("org_admin"), asyncHandler(async (req, res) => {
  const orgId = req.auth!.organizationId;
  const parsed = createCohortSchema.safeParse(req.body);
  if (!orgId) return res.status(403).json({ error: "Organization access required" });
  if (!parsed.success) return res.status(400).json({ error: "Invalid cohort details." });
  const input = parsed.data;
  const coverage = await pool.query(
    `SELECT COALESCE(MAX(day_number),0)::int AS available_days FROM lessons WHERE role_level=$1`,
    [input.roleLevel]
  );
  const availableDays = coverage.rows[0].available_days as number;
  if (input.durationDays > availableDays) {
    return res.status(400).json({ error: `Duration exceeds the ${availableDays} available ${input.roleLevel} lessons.` });
  }
  const result = await pool.query(
    `INSERT INTO cohorts(name,role_level,start_date,duration_days,organization_id,status)
     VALUES($1,$2,$3,$4,$5,'active') RETURNING id`,
    [input.name, input.roleLevel, input.startDate, input.durationDays, orgId]
  );
  return res.status(201).json({ id: result.rows[0].id });
}));

router.patch("/:cohortId/archive", requireRole("org_admin"), asyncHandler(async (req, res) => {
  const orgId = req.auth!.organizationId;
  const cohortId = Number(req.params.cohortId);
  if (!orgId || !Number.isInteger(cohortId)) return res.status(400).json({ error: "Invalid cohort." });
  const result = await pool.query(
    `UPDATE cohorts SET status='archived' WHERE id=$1 AND organization_id=$2 RETURNING id`,
    [cohortId, orgId]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Cohort not found." });
  return res.json({ ok: true });
}));

export default router;
