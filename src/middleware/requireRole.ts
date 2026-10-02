import { NextFunction, Request, Response } from "express";
import type { AuthRole } from "../utils/jwt";

export function requireRole(...allowedRoles: AuthRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    return next();
  };
}
