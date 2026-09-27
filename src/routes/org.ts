import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { asyncHandler } from "../middleware/asyncHandler";

const router = Router();

router.use(requireAuth);

/**
 * GET /api/org/me
 * Returns org profile for current user's org.
 */
router.get("/me", asyncHandler(async (req, res) => {
  const orgId = req.auth?.organizationId;
  if (!orgId) return res.status(401).json({ error: "Missing org in token" });

  const { rows } = await pool.query(
    `SELECT id, name, contact_email, timezone
     FROM organizations
     WHERE id = $1`,
    [orgId]
  );

  if (!rows.length) return res.status(404).json({ error: "Org not found" });

  res.json({
    id: rows[0].id,
    name: rows[0].name ?? "",
    contactEmail: rows[0].contact_email ?? "",
    timezone: rows[0].timezone ?? "",
  });
}));

/**
 * PUT /api/org/me
 * body: { name: string, contactEmail: string, timezone: string }
 */
router.put("/me", requireRole("org_admin"), asyncHandler(async (req, res) => {
  const orgId = req.auth?.organizationId;
  if (!orgId) return res.status(401).json({ error: "Missing org in token" });

  const name = String(req.body?.name ?? "").trim();
  const contactEmail = String(req.body?.contactEmail ?? "").trim().toLowerCase();
  const timezone = String(req.body?.timezone ?? "").trim();

  if (!name) return res.status(400).json({ error: "Organization name is required" });

  if (!contactEmail) return res.status(400).json({ error: "Contact email is required" });

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail);
  if (!emailOk) return res.status(400).json({ error: "Invalid email format" });

  const { rows } = await pool.query(
    `UPDATE organizations
     SET name = $1,
         contact_email = $2,
         timezone = $3,
         updated_at = NOW()
     WHERE id = $4
     RETURNING id, name, contact_email, timezone`,
    [name, contactEmail, timezone, orgId]
  );

  if (!rows.length) return res.status(404).json({ error: "Org not found" });

  res.json({
    ok: true,
    org: {
      id: rows[0].id,
      name: rows[0].name,
      contactEmail: rows[0].contact_email,
      timezone: rows[0].timezone,
    },
  });
}));

export default router;
