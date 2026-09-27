import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import authRoutes from "./routes/auth";
import twilioRoutes from "./routes/twilio";
import cohortsRoutes from "./routes/cohorts";
import analyticsRoutes from "./routes/analytics";
import billingRouter from "./routes/billing";
import stripeWebhookRouter from "./routes/stripeWebhook";
import reflectionsRouter from "./routes/reflections";
import publicRouter from "./routes/public";
import orgRouter from "./routes/org";
import workspaceRouter from "./routes/workspace";
import learnerRouter from "./routes/learner";
import profileRouter from "./routes/profile";
import adminRouter from "./routes/admin";
import { pool } from "./db/pool";
import { rateLimit } from "express-rate-limit";

dotenv.config();

export const app = express();
app.set("trust proxy", 1);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: "draft-8", legacyHeaders: false });
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: "draft-8", legacyHeaders: false });

const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin: string) => origin.trim())
  .filter(Boolean);

app.use("/api/billing", stripeWebhookRouter);

app.use(helmet());
app.use(cors({
  credentials: true,
  origin(
    origin: string | undefined,
    callback: (error: Error | null, allow?: boolean) => void
  ) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error("Origin not allowed by CORS"));
  },
}));
app.use(morgan("dev"));
app.use(express.urlencoded({ extended: false, limit: "16kb" })); // REQUIRED for Twilio
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Public routes
app.use("/api/public", publicLimiter, publicRouter);

// ✅ Auth routes – now available under /api/auth as well
app.use("/auth", authLimiter, authRoutes);      // legacy/basic
app.use("/api/auth", authLimiter, authRoutes);  // what your frontend is calling

// Twilio webhook (keep at /twilio so it matches your Twilio config)
app.use("/twilio", twilioRoutes);

// Protected-ish API routes
app.use("/api/cohorts", cohortsRoutes);
app.use("/api/reflections", reflectionsRouter);
app.use("/api/billing", billingRouter);
app.use("/api/org", orgRouter);
app.use("/api/workspace", workspaceRouter);
app.use("/api/learner", learnerRouter);
app.use("/api/profile", profileRouter);
app.use("/api/admin", adminRouter);
// Analytics owns legacy /api/cohorts/:id/* and /api/cohort-users/* paths.
// Keep it after the specific API routers so its role middleware cannot reject
// learner, billing, or super-admin requests before their router is reached.
app.use("/api", analyticsRoutes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error:", err);
  if (res.headersSent) return;
  res.status(503).json({ error: "Service temporarily unavailable" });
});
