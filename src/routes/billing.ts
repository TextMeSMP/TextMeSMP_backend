import { Router } from "express";
import Stripe from "stripe";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { asyncHandler } from "../middleware/asyncHandler";

const router = Router();

function mustGetEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment (.env)`);
  return v;
}


const stripe = new Stripe(mustGetEnv("STRIPE_SECRET_KEY"));

function resolvePriceId(plan: string) {
  // You can drive these from your Landing plans (bronze/silver/gold)
  // OR your internal spec (subscription/per_learner/cohort).
  const p = String(plan || "").toLowerCase();

  if (p === "bronze") return process.env.STRIPE_PRICE_BRONZE;
  if (p === "silver") return process.env.STRIPE_PRICE_SILVER;
  if (p === "gold") return process.env.STRIPE_PRICE_GOLD;

  // Backwards compatible
  if (p === "subscription") return process.env.STRIPE_PRICE_SUBSCRIPTION;

  // default fallback
  return process.env.STRIPE_PRICE_SUBSCRIPTION ?? process.env.STRIPE_PRICE_GOLD;
}

router.use(requireAuth);

/**
 * GET /api/billing/status
 */
router.get("/status", asyncHandler(async (req, res) => {
  const orgId = req.auth?.organizationId;
  if (!orgId) return res.json({ isPaid: false });

  const { rows } = await pool.query(
    "SELECT is_paid, plan FROM organizations WHERE id = $1",
    [orgId]
  );

  if (!rows.length) return res.status(404).json({ error: "Org not found" });

  res.json({
    isPaid: rows[0].is_paid,
    plan: rows[0].plan ?? undefined,
  });
}));

// Every organization member may read access status so clients can enforce the
// same paid-organization gate. Only organization admins may mutate billing.
router.use(requireRole("org_admin"));

/**
 * POST /api/billing/pilot-checkout
 * body: { plan?: "bronze" | "silver" | "gold" }
 *
 * Creates a one-time 99 USD Checkout Session for the pilot.
 */
router.post("/pilot-checkout", asyncHandler(async (req, res) => {
  const orgId = req.auth?.organizationId;
  if (!orgId) return res.status(401).json({ error: "Missing org in token" });

  const plan = (req.body?.plan ?? "gold") as string;

  const appUrl = mustGetEnv("APP_URL");

  // pull org info (same as in /checkout-session)
  const orgRes = await pool.query(
    `SELECT id, name, contact_email, stripe_customer_id
     FROM organizations
     WHERE id = $1`,
    [orgId]
  );
  if (!orgRes.rows.length) {
    return res.status(404).json({ error: "Org not found" });
  }

  const org = orgRes.rows[0];

  // ensure Stripe customer exists
  let customerId: string | undefined = org.stripe_customer_id ?? undefined;

  if (!customerId) {
    const customer = await stripe.customers.create({
      name: org.name ?? `Org ${orgId}`,
      email: org.contact_email ?? undefined,
      metadata: { organization_id: String(orgId) },
    });

    customerId = customer.id;

    await pool.query(
      `UPDATE organizations
       SET stripe_customer_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [customerId, orgId]
    );
  }

  // create Checkout Session in PAYMENT mode for the 99 pilot fee
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [
      {
        price: mustGetEnv("STRIPE_PILOT_PRICE_ID"),
        quantity: 1,
      },
    ],
    success_url: `${appUrl}/settings?pilot=success`,
    cancel_url: `${appUrl}/settings?pilot=cancel`,
    client_reference_id: String(orgId),
   subscription_data: {
  metadata: {
    organization_id: String(orgId),
    plan,
  },
},
  });

  res.json({ url: session.url });
}));



/**
 * POST /api/billing/checkout-session
 * body: { plan: "bronze" | "silver" | "gold" | "subscription" }
 */
router.post("/checkout-session", asyncHandler(async (req, res) => {
  const orgId = req.auth?.organizationId;
  if (!orgId) return res.status(401).json({ error: "Missing org in token" });

  const plan = (req.body?.plan ?? "gold") as string;

  const priceId = resolvePriceId(plan);
  if (!priceId) {
    return res.status(500).json({
      error:
        "Stripe price is not configured. Set STRIPE_PRICE_BRONZE/SILVER/GOLD (or STRIPE_PRICE_SUBSCRIPTION) in .env",
    });
  }

  const appUrl = mustGetEnv("APP_URL");

  // pull org info
  const orgRes = await pool.query(
    `SELECT id, name, contact_email, stripe_customer_id
     FROM organizations
     WHERE id = $1`,
    [orgId]
  );
  if (!orgRes.rows.length) return res.status(404).json({ error: "Org not found" });

  const org = orgRes.rows[0];

  // create customer if missing
  let customerId: string | undefined = org.stripe_customer_id ?? undefined;

  if (!customerId) {
    const customer = await stripe.customers.create({
      name: org.name ?? `Org ${orgId}`,
      email: org.contact_email ?? undefined,
      metadata: { organization_id: String(orgId) },
    });

    customerId = customer.id;

    await pool.query(
      `UPDATE organizations
       SET stripe_customer_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [customerId, orgId]
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],

    success_url: `${appUrl}/settings?billing=success`,
    cancel_url: `${appUrl}/payment-required?billing=cancel`,

    // Stripe -> Org mapping
    client_reference_id: String(orgId),
    metadata: { organization_id: String(orgId), plan },
  });

  res.json({ url: session.url });
}));

/**
 * POST /api/billing/portal-session (optional)
 */
router.post("/portal-session", asyncHandler(async (req, res) => {
  const orgId = req.auth?.organizationId;
  if (!orgId) return res.status(401).json({ error: "Missing org in token" });

  const { rows } = await pool.query(
    "SELECT stripe_customer_id FROM organizations WHERE id = $1",
    [orgId]
  );
  if (!rows.length) return res.status(404).json({ error: "Org not found" });
  if (!rows[0].stripe_customer_id) {
    return res.status(400).json({ error: "No Stripe customer yet (pay first)" });
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: rows[0].stripe_customer_id,
    return_url: `${mustGetEnv("APP_URL")}/settings`,
  });

  res.json({ url: portal.url });
}));

/**
 * POST /api/billing/change-plan
 * body: { plan: "bronze" | "silver" | "gold" }
 */
router.post("/change-plan", asyncHandler(async (req, res) => {
  const orgId = req.auth?.organizationId;
  if (!orgId) return res.status(401).json({ error: "Missing org in token" });

  const plan = String(req.body?.plan || "").toLowerCase();
  if (!["bronze", "silver", "gold"].includes(plan)) {
    return res.status(400).json({ error: "Invalid plan. Use bronze, silver, or gold." });
  }

  const priceId = resolvePriceId(plan);
  if (!priceId) {
    return res.status(500).json({
      error:
        "Stripe price not configured. Set STRIPE_PRICE_BRONZE / STRIPE_PRICE_SILVER / STRIPE_PRICE_GOLD in .env",
    });
  }

  // load org
  const orgRes = await pool.query(
    `SELECT id, stripe_customer_id, price_locked_until FROM organizations WHERE id = $1`,
    [orgId]
  );

  if (!orgRes.rows.length) return res.status(404).json({ error: "Org not found" });
const org = orgRes.rows[0];
if (org.price_locked_until && new Date(org.price_locked_until) > new Date()) {
return res.status(400).json({
error: `Founding Partner pricing is locked until ${new Date( org.price_locked_until ).toISOString().slice(0, 10)}`,
});
}

  const customerId = orgRes.rows[0].stripe_customer_id;
  if (!customerId) {
    return res.status(400).json({ error: "No Stripe customer yet. Subscribe first." });
  }

  // find active subscription
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "active",
    limit: 1,
  });

  const sub = subs.data[0];
  if (!sub) {
    return res.status(400).json({ error: "No active subscription found." });
  }

  const itemId = sub.items.data[0]?.id;
  if (!itemId) {
    return res.status(500).json({ error: "Subscription has no items to update." });
  }

  // swap price (this is the plan change)
  await stripe.subscriptions.update(sub.id, {
    items: [{ id: itemId, price: priceId }],
    metadata: { plan },
    proration_behavior: "create_prorations",
  });

  // persist plan on org
  await pool.query(
    `UPDATE organizations
     SET plan = $1, updated_at = NOW()
     WHERE id = $2`,
    [plan, orgId]
  );

  res.json({ ok: true, plan });
}));


export default router;
