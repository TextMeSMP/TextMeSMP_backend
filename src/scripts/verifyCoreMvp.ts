import "dotenv/config";
import bcrypt from "bcryptjs";
import twilio from "twilio";
import Stripe from "stripe";
import { app } from "../app";
import { pool } from "../db/pool";
import { sendDailyLessons } from "../crons/dailySend";
import type { SmsSender } from "../sms/sender";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const suffix = `${Date.now()}`;
  const orgIds: number[] = [];
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const base = `http://127.0.0.1:${address.port}`;

  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
  const json = (body: unknown) => JSON.stringify(body);

  try {
    async function createOrg(label: string, paid: boolean, active = true) {
      const result = await pool.query(
        `INSERT INTO organizations(name,contact_email,is_paid,is_active) VALUES($1,$2,$3,$4) RETURNING id`,
        [`MVP Verify ${label} ${suffix}`, `${label}.${suffix}@example.test`, paid, active]
      );
      const id = result.rows[0].id as number; orgIds.push(id); return id;
    }
    async function createAdmin(orgId: number, label: string) {
      const email = `${label}.${suffix}@example.test`;
      const password = "Verification-2026!";
      const result = await pool.query(
        `INSERT INTO admin_users(email,password_hash,organization_id,role,is_active) VALUES($1,$2,$3,'org_admin',TRUE) RETURNING id`,
        [email, await bcrypt.hash(password, 4), orgId]
      );
      return { id: result.rows[0].id as number, email, password };
    }
    async function login(email: string, password: string) {
      const response = await request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      const body = await response.json() as { token?: string };
      assert(response.status === 200 && body.token, `Login failed with ${response.status}`);
      return body.token;
    }
    const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

    const paidOrg = await createOrg("paid", true);
    const unpaidOrg = await createOrg("unpaid", false);
    const disabledOrg = await createOrg("disabled", true, false);
    const paidAdmin = await createAdmin(paidOrg, "paid");
    const unpaidAdmin = await createAdmin(unpaidOrg, "unpaid");
    const disabledAdmin = await createAdmin(disabledOrg, "disabled");
    const paidToken = await login(paidAdmin.email, paidAdmin.password);
    const unpaidToken = await login(unpaidAdmin.email, unpaidAdmin.password);

    let response = await request("/auth/me", { headers: auth(paidToken) });
    assert(response.status === 200, "Active account /auth/me must succeed");
    await pool.query(`UPDATE admin_users SET is_active=FALSE WHERE id=$1`, [paidAdmin.id]);
    response = await request("/auth/me", { headers: auth(paidToken) });
    assert(response.status === 401, "Disabled account retained token access");
    await pool.query(`UPDATE admin_users SET is_active=TRUE WHERE id=$1`, [paidAdmin.id]);
    const refreshedPaidToken = await login(paidAdmin.email, paidAdmin.password);

    response = await request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: disabledAdmin.email, password: disabledAdmin.password }) });
    assert(response.status === 401, "Disabled organization login was not rejected");
    await pool.query(`UPDATE organizations SET is_active=FALSE WHERE id=$1`, [paidOrg]);
    response = await request("/auth/me", { headers: auth(refreshedPaidToken) });
    assert(response.status === 401, "Disabled organization retained token access");
    await pool.query(`UPDATE organizations SET is_active=TRUE WHERE id=$1`, [paidOrg]);
    const token = await login(paidAdmin.email, paidAdmin.password);

    response = await request("/api/cohorts", { method: "POST", headers: auth(unpaidToken), body: json({ name: "Blocked", roleLevel: "agent", startDate: "2026-10-02", durationDays: 5 }) });
    assert(response.status === 402, "Unpaid organization created a cohort");
    response = await request("/api/cohorts", { method: "POST", headers: auth(token), body: json({ name: "Bad role", roleLevel: "org_admin", startDate: "2026-10-02", durationDays: 5 }) });
    assert(response.status === 400, "Authentication role was accepted as curriculum role");
    response = await request("/api/cohorts", { method: "POST", headers: auth(token), body: json({ name: "Too long", roleLevel: "manager", startDate: "2026-10-02", durationDays: 31 }) });
    assert(response.status === 400, "Duration beyond lesson coverage was accepted");

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    async function cohort(orgId: number, name: string, start: string, duration: number, status = "active") {
      const result = await pool.query(`INSERT INTO cohorts(name,role_level,start_date,duration_days,organization_id,status) VALUES($1,'agent',$2,$3,$4,$5) RETURNING id`, [name, start, duration, orgId, status]);
      return result.rows[0].id as number;
    }
    const activeCohort = await cohort(paidOrg, `Active ${suffix}`, today, 5);
    await cohort(paidOrg, `Upcoming ${suffix}`, tomorrow, 5);
    await cohort(paidOrg, `Completed ${suffix}`, "2020-01-01", 5);
    await cohort(paidOrg, `Archived ${suffix}`, today, 5, "archived");
    const unpaidCohort = await cohort(unpaidOrg, `Unpaid ${suffix}`, today, 5);
    const disabledCohort = await cohort(disabledOrg, `Disabled ${suffix}`, today, 5);
    const leadCohort = await pool.query(`INSERT INTO cohorts(name,role_level,start_date,duration_days,organization_id,status) VALUES($1,'lead',$2,5,$3,'active') RETURNING id`, [`Lead ${suffix}`, today, paidOrg]);

    async function learner(orgId: number, phone: string, status = "active") {
      const result = await pool.query(`INSERT INTO users(name,phone_number,role_level,status,organization_id) VALUES($1,$2,'agent',$3,$4) RETURNING id`, [`Verify ${suffix}`, phone, status, orgId]);
      return result.rows[0].id as number;
    }
    const paidUser = await learner(paidOrg, `+1999${suffix.slice(-7)}`);
    const inactiveUser = await learner(paidOrg, `+1888${suffix.slice(-7)}`, "inactive");
    const unpaidUser = await learner(unpaidOrg, `+1777${suffix.slice(-7)}`);
    const disabledUser = await learner(disabledOrg, `+1666${suffix.slice(-7)}`);
    const paidMembership = (await pool.query(`INSERT INTO cohort_users(cohort_id,user_id) VALUES($1,$2) RETURNING id`, [activeCohort, paidUser])).rows[0].id as number;
    await pool.query(`INSERT INTO cohort_users(cohort_id,user_id) VALUES($1,$2)`, [activeCohort, inactiveUser]);
    await pool.query(`INSERT INTO cohort_users(cohort_id,user_id) VALUES($1,$2)`, [unpaidCohort, unpaidUser]);
    await pool.query(`INSERT INTO cohort_users(cohort_id,user_id) VALUES($1,$2)`, [disabledCohort, disabledUser]);
    let mismatchRejected = false;
    try { await pool.query(`INSERT INTO cohort_users(cohort_id,user_id) VALUES($1,$2)`, [leadCohort.rows[0].id, paidUser]); } catch (error: any) { mismatchRejected = error?.code === "23514"; }
    assert(mismatchRejected, "Cross-role membership was accepted");

    const deliveries: string[] = [];
    const fakeSms: SmsSender = { sendSms: async ({ to }) => { deliveries.push(to); return { sid: `test-${suffix}` }; } };
    const paidSend = await sendDailyLessons({ sms: fakeSms, organizationId: paidOrg });
    const unpaidSend = await sendDailyLessons({ sms: fakeSms, organizationId: unpaidOrg });
    const disabledSend = await sendDailyLessons({ sms: fakeSms, organizationId: disabledOrg });
    assert(paidSend.sent === 1 && unpaidSend.sent === 0 && disabledSend.sent === 0 && deliveries.length === 1, "Daily SMS eligibility rules failed");

    const inboundUrl = `${base}/twilio/inbound`;
    const params = { From: `+1999${suffix.slice(-7)}`, Body: "I learned that clear ownership improves the result." };
    const signature = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, inboundUrl, params);
    response = await request("/twilio/inbound", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body: new URLSearchParams(params).toString() });
    assert(response.status === 200, `Signed Twilio webhook failed with ${response.status}`);
    const reflection = await pool.query(`SELECT response_text,quality_score FROM reflections WHERE cohort_user_id=$1`, [paidMembership]);
    assert(reflection.rowCount === 1, "Twilio reflection was not persisted");

    response = await request("/api/cohorts", { headers: auth(token) });
    const cohortBody = await response.json() as { cohorts: Array<{ lifecycle_status: string }> };
    const statuses = new Set(cohortBody.cohorts.map(item => item.lifecycle_status));
    assert(response.status === 200 && statuses.has("upcoming") && statuses.has("active") && statuses.has("completed"), "Cohort lifecycle statuses are incomplete");

    const stripeEvent = JSON.stringify({
      id: `evt_verify_${suffix}`,
      object: "event",
      api_version: "2025-12-18.clover",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed",
      data: { object: { id: `cs_verify_${suffix}`, object: "checkout.session", mode: "subscription", client_reference_id: String(unpaidOrg), customer: `cus_verify_${suffix}`, subscription: `sub_verify_${suffix}`, metadata: { organization_id: String(unpaidOrg), plan: "bronze" } } },
    });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const stripeSignature = stripe.webhooks.generateTestHeaderString({ payload: stripeEvent, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    response = await request("/api/billing/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": stripeSignature }, body: stripeEvent });
    assert(response.status === 200, `Stripe webhook failed with ${response.status}`);
    const activated = await pool.query(`SELECT is_paid,plan FROM organizations WHERE id=$1`, [unpaidOrg]);
    assert(activated.rows[0].is_paid === true && activated.rows[0].plan === "bronze", "Stripe webhook did not activate the organization");
    response = await request("/api/cohorts", { method: "POST", headers: auth(unpaidToken), body: json({ name: `Activated ${suffix}`, roleLevel: "agent", startDate: today, durationDays: 5 }) });
    assert(response.status === 201, "Webhook-activated organization did not gain dashboard cohort access");

    console.log(JSON.stringify({ login: true, staleAccountRejected: true, staleOrganizationRejected: true, unpaidBlocked: true, roleConsistency: true, durationCoverage: true, lifecycleStatuses: [...statuses], dailySmsEligibility: true, inboundReflection: true, stripeWebhookActivation: true }, null, 2));
  } finally {
    for (const orgId of orgIds) {
      await pool.query(`DELETE FROM admin_users WHERE organization_id=$1`, [orgId]);
      await pool.query(`DELETE FROM cohorts WHERE organization_id=$1`, [orgId]);
      await pool.query(`DELETE FROM users WHERE organization_id=$1`, [orgId]);
      await pool.query(`DELETE FROM organizations WHERE id=$1`, [orgId]);
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
