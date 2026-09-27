import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool";
import { signAuthToken } from "../utils/jwt";
import { learnerAccountSchema, loginSchema, signupSchema } from "../schemas/auth.schema";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { asyncHandler } from "../middleware/asyncHandler";

const router = Router();
router.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid signup details." });
  }

  const { name: trimmedName, email: trimmedEmail, password, referralCode } = parsed.data;

  try {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 1) Check if email already exists
      const existing = await client.query(
        `
        SELECT id FROM admin_users
        WHERE email = $1
        LIMIT 1
        `,
        [trimmedEmail]
      );

      if (existing.rowCount != null && existing.rowCount > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Email already in use." });
      }

      // 2) Create organization
      const orgRes = await client.query(
        `
        INSERT INTO organizations (name, contact_email, is_paid)
        VALUES ($1, $2, FALSE)
        RETURNING id
        `,
        [trimmedName, trimmedEmail]
      );

      const orgId = orgRes.rows[0].id as number;

      // 3) Hash password and create admin user
      const passwordHash = await bcrypt.hash(password, 10);

      const adminRes = await client.query(
        `
        INSERT INTO admin_users (email, password_hash, organization_id)
        VALUES ($1, $2, $3)
        RETURNING id, email, organization_id, role
        `,
        [trimmedEmail, passwordHash, orgId]
      );

      const admin = adminRes.rows[0];

      if (referralCode) {
        const referral = await client.query(
          `SELECT rc.user_id,rc.organization_id FROM learner_referral_codes rc WHERE UPPER(rc.code)=UPPER($1) LIMIT 1`,
          [referralCode]
        );
        if (!referral.rowCount) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Referral code is invalid." });
        }
        await client.query(
          `UPDATE learner_referrals SET status='active',reward_xp=500,updated_at=NOW()
           WHERE referrer_user_id=$1 AND organization_id=$2 AND referred_email=$3 AND status IN ('invited','joined')`,
          [referral.rows[0].user_id,referral.rows[0].organization_id,trimmedEmail]
        );
      }

      // 4) Sign JWT
      const token = signAuthToken({
        adminId: admin.id,
        userId: null,
        organizationId: admin.organization_id,
        role: admin.role,
      });

      await client.query("COMMIT");

      // 5) Respond to frontend
      return res.json({
        token,
        admin: {
          id: admin.id,
          userId: null,
          email: admin.email,
          organizationId: admin.organization_id,
          role: admin.role,
        },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error in /auth/signup:", err);
      return res.status(500).json({ error: "Internal server error." });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("DB connection error in /auth/signup:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});
/**
 * POST /auth/login
 * Existing admin login route (unchanged)
 *
 * Body: { email, password }
 * Response: { token, admin: { id, email, organizationId } }
 */
router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid login details." });
  }

  const { email, password } = parsed.data;

  try {
    const client = await pool.connect();

    try {
    // 1) Find ADMIN user by email
    const userRes = await client.query(
      `
      SELECT a.id, a.email, a.password_hash, a.organization_id, a.user_id, a.role
      FROM admin_users a LEFT JOIN organizations o ON o.id=a.organization_id
      WHERE a.email = $1 AND a.is_active=TRUE AND (a.organization_id IS NULL OR o.is_active=TRUE)
      LIMIT 1
      `,
      [email]
    );

    if (userRes.rowCount === 0) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const admin = userRes.rows[0] as {
      id: number;
      email: string;
      password_hash: string;
      organization_id: number | null;
      user_id: number | null;
      role: "learner" | "manager" | "org_admin" | "super_admin";
    };

    // 2) Compare password
    const passwordOk = await bcrypt.compare(password, admin.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    if (admin.role === "learner" && admin.user_id === null) {
      return res.status(403).json({ error: "Learner account is not linked to a learner profile." });
    }

    // 3) Create JWT for this admin
    const token = signAuthToken({
      adminId: admin.id,
      userId: admin.user_id,
      organizationId: admin.organization_id,
      role: admin.role,
    });

    // 4) Respond to the frontend
    return res.json({
      token,
      admin: {
        id: admin.id,
        userId: admin.user_id,
        email: admin.email,
        organizationId: admin.organization_id,
        role: admin.role,
      },
    });
    } catch (err) {
      console.error("Error in /auth/login:", err);
      return res.status(500).json({ error: "Internal server error." });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("DB connection error in /auth/login:", err);
    return res.status(503).json({ error: "Authentication service is temporarily unavailable." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, organization_id, user_id, role
       FROM admin_users
       WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2
       LIMIT 1`,
      [req.auth!.adminId, req.auth!.organizationId]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Account is no longer available" });
    }

    const admin = result.rows[0];
    if (admin.role !== req.auth!.role) {
      return res.status(401).json({ error: "Session permissions changed" });
    }
    if (admin.user_id !== req.auth!.userId) {
      return res.status(401).json({ error: "Session learner assignment changed" });
    }

    return res.json({
      admin: {
        id: admin.id,
        userId: admin.user_id,
        email: admin.email,
        organizationId: admin.organization_id,
        role: admin.role,
      },
    });
  } catch (err) {
    console.error("Error in /auth/me:", err);
    return res.status(503).json({ error: "Authentication service is temporarily unavailable." });
  }
});

router.post(
  "/learner-account",
  requireAuth,
  requireRole("org_admin"),
  asyncHandler(async (req, res) => {
    const parsed = learnerAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid learner account details." });
    }

    const organizationId = req.auth!.organizationId;
    if (organizationId === null) {
      return res.status(403).json({ error: "Organization access is required." });
    }

    const { userId, email, password } = parsed.data;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const learner = await client.query(
        `SELECT id FROM users WHERE id = $1 AND organization_id = $2 LIMIT 1 FOR UPDATE`,
        [userId, organizationId]
      );
      if (learner.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Learner was not found in this organization." });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const result = await client.query(
        `INSERT INTO admin_users (email, password_hash, organization_id, user_id, role)
         VALUES ($1, $2, $3, $4, 'learner')
         RETURNING id, email, organization_id, user_id, role`,
        [email, passwordHash, organizationId, userId]
      );
      await client.query("COMMIT");
      const account = result.rows[0];
      return res.status(201).json({
        admin: {
          id: account.id,
          email: account.email,
          organizationId: account.organization_id,
          userId: account.user_id,
          role: account.role,
        },
      });
    } catch (error: any) {
      await client.query("ROLLBACK");
      if (error?.code === "23505") {
        return res.status(409).json({ error: "Email or learner account is already in use." });
      }
      throw error;
    } finally {
      client.release();
    }
  })
);

export default router;
