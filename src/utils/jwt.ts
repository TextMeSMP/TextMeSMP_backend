// src/utils/jwt.ts
import jwt from "jsonwebtoken";

const JWT_EXPIRES_IN = "7d";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }

  return secret;
}

export interface AuthTokenPayload {
  adminId: number;
  userId: number | null;
  organizationId: number | null;
  role: AuthRole;
}

export type AuthRole = "learner" | "manager" | "org_admin" | "super_admin";

const AUTH_ROLES: AuthRole[] = [
  "learner",
  "manager",
  "org_admin",
  "super_admin",
];

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, getJwtSecret(), {
    algorithm: "HS256",
    expiresIn: JWT_EXPIRES_IN,
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const payload = jwt.verify(token, getJwtSecret(), {
    algorithms: ["HS256"],
  });

  if (
    typeof payload === "string" ||
    !Number.isInteger(payload.adminId) ||
    !(payload.userId === null || Number.isInteger(payload.userId)) ||
    !(payload.organizationId === null || Number.isInteger(payload.organizationId)) ||
    !AUTH_ROLES.includes(payload.role as AuthRole)
  ) {
    throw new jwt.JsonWebTokenError("Invalid token payload");
  }

  return {
    adminId: payload.adminId,
    userId: payload.userId,
    organizationId: payload.organizationId,
    role: payload.role as AuthRole,
  };
}
