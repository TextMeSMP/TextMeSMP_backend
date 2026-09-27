import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { asyncHandler } from "../middleware/asyncHandler";

const router = Router();

router.use(requireAuth, requireRole("manager", "org_admin"));

/**
 * PATCH /api/reflections/:id
 * body: { behaviorObserved: boolean }
 *
 * Marks a reflection as "behavior observed" (manager input).
 * Enforces org ownership.
 */
router.patch("/:id", asyncHandler(async (req, res) => {
  const reflectionId = Number(req.params.id);
  const orgId = req.auth?.organizationId;

  if (!reflectionId || Number.isNaN(reflectionId)) {
    return res.status(400).json({ error: "Invalid reflection id" });
  }
  if (!orgId) return res.status(401).json({ error: "Missing org in token" });

  const behaviorObserved = req.body?.behaviorObserved;
  if (typeof behaviorObserved !== "boolean") {
    return res.status(400).json({ error: "behaviorObserved must be boolean" });
  }

  const client = await pool.connect();
  try {
    const upd = await client.query(
      `
      UPDATE reflections r
      SET behavior_observed = $2
      FROM cohort_users cu
      JOIN cohorts c ON c.id = cu.cohort_id
      WHERE r.id = $1
        AND r.cohort_user_id = cu.id
        AND c.organization_id = $3
      RETURNING r.id, r.cohort_user_id, r.lesson_id, r.behavior_observed
      `,
      [reflectionId, behaviorObserved, orgId]
    );

    if (!upd.rowCount) {
      return res.status(404).json({ error: "Reflection not found" });
    }

    return res.json({ reflection: upd.rows[0] });
  } catch (e) {
    console.error("Error PATCH /api/reflections/:id", e);
    return res.status(500).json({ error: "Failed to update reflection" });
  } finally {
    client.release();
  }
}));

export default router;
