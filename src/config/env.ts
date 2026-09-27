import { z } from "zod";

/**
 * Centralized env validation so the app fails fast with a clear error.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().min(1).default("http://localhost:8081"),
  APP_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),

  SMS_PROVIDER: z.enum(["mock", "twilio"]).default("mock"),

  // Twilio only required if SMS_PROVIDER=twilio
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_NUMBER: z.string().optional(),
  TWILIO_WEBHOOK_URL: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRICE_BRONZE: z.string().min(1).optional(),
  STRIPE_PRICE_SILVER: z.string().min(1).optional(),
  STRIPE_PRICE_GOLD: z.string().min(1).optional(),
  STRIPE_PRICE_SUBSCRIPTION: z.string().min(1).optional(),
  STRIPE_PILOT_PRICE_ID: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.SMS_PROVIDER === "twilio") {
    for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_NUMBER", "TWILIO_WEBHOOK_URL"] as const) {
      if (!value[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when SMS_PROVIDER=twilio` });
    }
  }
  if (value.NODE_ENV === "production") {
    if (!value.APP_URL?.startsWith("https://")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["APP_URL"], message: "Production APP_URL must use HTTPS" });
    if (!value.STRIPE_SECRET_KEY || !value.STRIPE_WEBHOOK_SECRET) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["STRIPE_SECRET_KEY"], message: "Stripe secrets are required in production" });
    for (const key of ["STRIPE_PRICE_BRONZE", "STRIPE_PRICE_SILVER", "STRIPE_PRICE_GOLD"] as const) {
      if (!value[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required in production` });
    }
  }
});

export const env = EnvSchema.parse(process.env);
