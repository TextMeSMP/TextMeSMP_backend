import { z } from "zod";

const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());

export const demoRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email,
  company: z.string().trim().max(120).optional(),
  message: z.string().trim().max(2000).optional(),
}).strict();

export const subscribeSchema = z.object({
  plan: z.enum(["bronze", "silver", "gold"]),
  email,
  company: z.string().trim().max(120).optional(),
}).strict();

export const organizationUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactEmail: email,
  timezone: z.string().trim().min(1).max(100).refine((value) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Invalid timezone"),
}).strict();

export const behaviorUpdateSchema = z.object({
  behaviorObserved: z.boolean(),
}).strict();

export const billingPlanSchema = z.object({
  plan: z.enum(["bronze", "silver", "gold"]),
}).strict();
