import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { requirePaidOrg } from "../middleware/requirePaidOrg";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireOrgPermission } from "../middleware/requireOrgPermission";

const router = Router();

// All routes here require auth
router.use(requireAuth, requireRole("manager", "org_admin"), requirePaidOrg, requireOrgPermission("view_cohort_data"));

// GET /api/cohorts
router.get("/", asyncHandler(async (req, res) => {
  const orgId = req.auth!.organizationId;
  if (!orgId) return res.status(403).json({ error: "Organization access required" });

  const client = await pool.connect();

  try {
    const result = await client.query(
      `
      SELECT
        id,
        name,
        role_level,
        start_date,
        duration_days
      FROM cohorts
      WHERE organization_id = $1
      ORDER BY id ASC
      `,
      [orgId]
    );

    return res.json({
      cohorts: result.rows,
    });
  } catch (err) {
    console.error("Error in GET /api/cohorts:", err);
    return res.status(500).json({ error: "Failed to load cohorts" });
  } finally {
    client.release();
  }
}));

export default router;
