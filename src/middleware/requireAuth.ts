// src/middleware/requireAuth.ts
import { Request, Response, NextFunction } from "express";
import { verifyAuthToken, AuthTokenPayload } from "../utils/jwt";
import { pool } from "../db/pool";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthTokenPayload;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers["authorization"];

  // 👇 TEMP debug: see which routes are going through requireAuth

  if (!header) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  const [scheme, token, extra] = header.split(" ");

  if (scheme !== "Bearer" || !token || extra) {
    return res.status(401).json({ error: "Invalid Authorization header" });
  }

  let payload: AuthTokenPayload;
  try {
    payload = verifyAuthToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  try {
    const account = await pool.query(
      `SELECT a.id,a.user_id,a.organization_id,a.role,a.is_active,
              o.is_active AS organization_active,u.status AS learner_status
       FROM admin_users a
       LEFT JOIN organizations o ON o.id=a.organization_id
       LEFT JOIN users u ON u.id=a.user_id
       WHERE a.id=$1`,
      [payload.adminId]
    );
    const current = account.rows[0];
    const sessionChanged = !current
      || !current.is_active
      || current.role !== payload.role
      || current.user_id !== payload.userId
      || current.organization_id !== payload.organizationId
      || (current.role !== "super_admin" && current.organization_active !== true)
      || (current.role === "learner" && current.learner_status !== "active");

    if (sessionChanged) {
      return res.status(401).json({ error: "Account or organization access is no longer active" });
    }
    req.auth = payload;
    res.setHeader("Cache-Control", "no-store");
    return next();
  } catch (error) {
    console.error("Authentication state check failed:", error);
    return res.status(503).json({ error: "Authentication service is temporarily unavailable" });
  }
}
