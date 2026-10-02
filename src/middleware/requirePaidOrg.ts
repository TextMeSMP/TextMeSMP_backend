import type { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool"; // change this import to your actual pool file

export async function requirePaidOrg(req: Request, res: Response, next: NextFunction) {
  const orgId = req.auth?.organizationId;

  if (!orgId) {
    // orgId is null or missing -> treat as not allowed
    return res.status(402).json({ code: "PAYMENT_REQUIRED", message: "Organization not active" });
  }

  const { rows } = await pool.query(
    "SELECT is_paid FROM organizations WHERE id = $1",
    [orgId]
  );

  if (!rows.length) {
    return res.status(404).json({ code: "ORG_NOT_FOUND" });
  }

  if (!rows[0].is_paid) {
    return res.status(402).json({ code: "PAYMENT_REQUIRED" });
  }

  return next();
}
