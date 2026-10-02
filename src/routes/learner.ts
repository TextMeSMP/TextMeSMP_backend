import { Router } from "express";
import { randomBytes } from "crypto";
import { z } from "zod";
import { pool } from "../db/pool";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { requirePaidOrg } from "../middleware/requirePaidOrg";

const router = Router();
router.use(requireAuth, requireRole("learner"), requirePaidOrg);

const reflectionSchema = z.object({ responseText: z.string().trim().min(1).max(2000) }).strict();
const leaderboardPeriodSchema = z.enum(["week", "month", "all_time"]);
const referralSchema = z.object({ email: z.string().trim().email().max(254).transform((value)=>value.toLowerCase()) }).strict();

function identity(req: Express.Request) {
  const userId = req.auth!.userId;
  const organizationId = req.auth!.organizationId;
  if (userId === null || organizationId === null) return null;
  return { userId, organizationId };
}

const membershipSql = `
  SELECT cu.id AS cohort_user_id, c.id AS cohort_id, c.name AS cohort_name,
         c.role_level, c.start_date, c.duration_days
  FROM users u
  JOIN cohort_users cu ON cu.user_id = u.id
  JOIN cohorts c ON c.id = cu.cohort_id AND c.organization_id = u.organization_id
  WHERE u.id = $1 AND u.organization_id = $2
  ORDER BY
    CASE WHEN CURRENT_DATE BETWEEN c.start_date AND c.start_date + (c.duration_days - 1) THEN 0 ELSE 1 END,
    c.start_date DESC, cu.id DESC
  LIMIT 1`;

router.get("/me", asyncHandler(async (req, res) => {
  const ids = identity(req);
  if (!ids) return res.status(403).json({ error: "Linked learner identity is required." });
  const result = await pool.query(`
    SELECT u.id, u.name, u.phone_number, u.role_level, u.status, u.created_at,
      COALESCE(json_agg(json_build_object(
        'cohortUserId', cu.id, 'id', c.id, 'name', c.name, 'startDate', c.start_date,
        'durationDays', c.duration_days
      ) ORDER BY c.start_date DESC) FILTER (WHERE c.id IS NOT NULL), '[]') AS cohorts
    FROM users u
    LEFT JOIN cohort_users cu ON cu.user_id = u.id
    LEFT JOIN cohorts c ON c.id = cu.cohort_id AND c.organization_id = $2
    WHERE u.id = $1 AND u.organization_id = $2
    GROUP BY u.id`, [ids.userId, ids.organizationId]);
  if (!result.rowCount) return res.status(404).json({ error: "Learner profile not found." });
  const row = result.rows[0];
  return res.json({ learner: { id: row.id, name: row.name, phoneNumber: row.phone_number, roleLevel: row.role_level, status: row.status, createdAt: row.created_at, cohorts: row.cohorts } });
}));

router.get("/dashboard", asyncHandler(async (req, res) => {
  const ids = identity(req);
  if (!ids) return res.status(403).json({ error: "Linked learner identity is required." });
  const learner = await pool.query(`SELECT id, name, role_level, status FROM users WHERE id=$1 AND organization_id=$2`, [ids.userId, ids.organizationId]);
  if (!learner.rowCount) return res.status(404).json({ error: "Learner profile not found." });
  const membership = await pool.query(membershipSql, [ids.userId, ids.organizationId]);
  const metrics = await pool.query(`
    SELECT COUNT(DISTINCT sm.id)::int AS lessons_sent,
      COUNT(DISTINCT r.id)::int AS reflections_submitted,
      AVG(r.quality_score)::float AS average_quality,
      COUNT(DISTINCT CASE WHEN r.behavior_observed THEN r.id END)::int AS behaviors_observed,
      MAX(r.received_at) AS last_reflection_at
    FROM users u
    LEFT JOIN cohort_users cu ON cu.user_id=u.id
    LEFT JOIN cohorts c ON c.id=cu.cohort_id AND c.organization_id=u.organization_id
    LEFT JOIN sent_messages sm ON sm.cohort_user_id=cu.id
    LEFT JOIN reflections r ON r.cohort_user_id=cu.id
    WHERE u.id=$1 AND u.organization_id=$2`, [ids.userId, ids.organizationId]);
  const m = metrics.rows[0];
  const completion = m.lessons_sent ? Math.round(100 * m.reflections_submitted / m.lessons_sent) : 0;
  return res.json({ learner: learner.rows[0], activeCohort: membership.rows[0] ?? null, metrics: { lessonsSent: m.lessons_sent, reflectionsSubmitted: m.reflections_submitted, completionPercent: completion, averageQuality: m.average_quality, behaviorsObserved: m.behaviors_observed, lastReflectionAt: m.last_reflection_at } });
}));

router.get("/lessons/today", asyncHandler(async (req, res) => {
  const ids = identity(req);
  if (!ids) return res.status(403).json({ error: "Linked learner identity is required." });
  const result = await pool.query(`
    SELECT l.id, l.day_number, l.title, l.lesson_text, l.action_text, l.reflection_question,
      cu.id AS cohort_user_id, c.id AS cohort_id, c.name AS cohort_name,
      sm.sent_at, r.id AS reflection_id, r.response_text, r.received_at
    FROM users u
    JOIN cohort_users cu ON cu.user_id=u.id
    JOIN cohorts c ON c.id=cu.cohort_id AND c.organization_id=u.organization_id
    JOIN lessons l ON l.role_level=c.role_level AND l.day_number=(CURRENT_DATE-c.start_date+1)::int
    LEFT JOIN sent_messages sm ON sm.cohort_user_id=cu.id AND sm.lesson_id=l.id
    LEFT JOIN reflections r ON r.cohort_user_id=cu.id AND r.lesson_id=l.id
    WHERE u.id=$1 AND u.organization_id=$2
      AND CURRENT_DATE BETWEEN c.start_date AND c.start_date+(c.duration_days-1)
    ORDER BY c.start_date DESC, r.received_at DESC NULLS LAST LIMIT 1`, [ids.userId, ids.organizationId]);
  const row = result.rows[0];
  return res.json({ lesson: row ? { id: row.id, dayNumber: row.day_number, title: row.title, lessonText: row.lesson_text, actionText: row.action_text, reflectionQuestion: row.reflection_question, cohortId: row.cohort_id, cohortUserId: row.cohort_user_id, cohortName: row.cohort_name, sentAt: row.sent_at, reflection: row.reflection_id ? { id: row.reflection_id, responseText: row.response_text, receivedAt: row.received_at } : null } : null });
}));

router.post("/lessons/:lessonId/reflections", asyncHandler(async (req, res) => {
  const ids = identity(req);
  if (!ids) return res.status(403).json({ error: "Linked learner identity is required." });
  const lessonId = Number(req.params.lessonId);
  const parsed = reflectionSchema.safeParse(req.body);
  if (!Number.isInteger(lessonId) || lessonId <= 0 || !parsed.success) return res.status(400).json({ error: "Invalid reflection details." });
  const target = await pool.query(`
    SELECT cu.id AS cohort_user_id FROM users u
    JOIN cohort_users cu ON cu.user_id=u.id
    JOIN cohorts c ON c.id=cu.cohort_id AND c.organization_id=u.organization_id
    JOIN lessons l ON l.id=$3 AND l.role_level=c.role_level
    WHERE u.id=$1 AND u.organization_id=$2
      AND CURRENT_DATE BETWEEN c.start_date AND c.start_date+(c.duration_days-1)
    ORDER BY c.start_date DESC LIMIT 1`, [ids.userId, ids.organizationId, lessonId]);
  if (!target.rowCount) return res.status(404).json({ error: "Lesson is not assigned to this learner." });
  const existing = await pool.query(`SELECT id FROM reflections WHERE cohort_user_id=$1 AND lesson_id=$2 LIMIT 1`, [target.rows[0].cohort_user_id, lessonId]);
  if (existing.rowCount) return res.status(409).json({ error: "A reflection was already submitted for this lesson." });
  const result = await pool.query(`INSERT INTO reflections (cohort_user_id, lesson_id, response_text) VALUES ($1,$2,$3) RETURNING id, response_text, received_at`, [target.rows[0].cohort_user_id, lessonId, parsed.data.responseText]);
  return res.status(201).json({ reflection: { id: result.rows[0].id, responseText: result.rows[0].response_text, receivedAt: result.rows[0].received_at } });
}));

router.get("/progress", asyncHandler(async (req, res) => {
  const ids = identity(req);
  if (!ids) return res.status(403).json({ error: "Linked learner identity is required." });
  const membership = await pool.query(membershipSql, [ids.userId, ids.organizationId]);
  if (!membership.rowCount) return res.json({ cohort: null, stats: { lessonsSent: 0, reflectionsSubmitted: 0, completionPercent: 0, averageQuality: null, behaviorsObserved: 0 }, days: [] });
  const member = membership.rows[0];
  const days = await pool.query(`
    SELECT l.id AS lesson_id,l.day_number,l.title,sm.sent_at,r.response_text,r.received_at,r.quality_score,r.behavior_observed
    FROM users u JOIN cohort_users cu ON cu.user_id=u.id
    JOIN cohorts c ON c.id=cu.cohort_id AND c.organization_id=u.organization_id
    JOIN lessons l ON l.role_level=c.role_level
    LEFT JOIN sent_messages sm ON sm.cohort_user_id=cu.id AND sm.lesson_id=l.id
    LEFT JOIN reflections r ON r.cohort_user_id=cu.id AND r.lesson_id=l.id
    WHERE u.id=$1 AND u.organization_id=$2 AND cu.id=$3 ORDER BY l.day_number`, [ids.userId, ids.organizationId, member.cohort_user_id]);
  const sent = days.rows.filter((d) => d.sent_at).length;
  const reflected = days.rows.filter((d) => d.received_at).length;
  const scored = days.rows.filter((d) => d.quality_score !== null);
  return res.json({ cohort: member, stats: { lessonsSent: sent, reflectionsSubmitted: reflected, completionPercent: sent ? Math.round(100*reflected/sent) : 0, averageQuality: scored.length ? scored.reduce((s,d)=>s+Number(d.quality_score),0)/scored.length : null, behaviorsObserved: days.rows.filter((d)=>d.behavior_observed).length }, days: days.rows.map((d)=>({ lessonId:d.lesson_id,dayNumber:d.day_number,title:d.title,sentAt:d.sent_at,responseText:d.response_text,reflectionAt:d.received_at,qualityScore:d.quality_score,behaviorObserved:!!d.behavior_observed })) });
}));

router.get("/messages", asyncHandler(async (req, res) => {
  const ids = identity(req);
  if (!ids) return res.status(403).json({ error: "Linked learner identity is required." });
  const result = await pool.query(`
    SELECT sm.id,sm.sent_at,l.id AS lesson_id,l.day_number,l.title,l.lesson_text,l.action_text,c.id AS cohort_id,c.name AS cohort_name
    FROM users u JOIN cohort_users cu ON cu.user_id=u.id
    JOIN cohorts c ON c.id=cu.cohort_id AND c.organization_id=u.organization_id
    JOIN sent_messages sm ON sm.cohort_user_id=cu.id JOIN lessons l ON l.id=sm.lesson_id
    WHERE u.id=$1 AND u.organization_id=$2 ORDER BY sm.sent_at DESC`, [ids.userId, ids.organizationId]);
  return res.json({ messages: result.rows.map((r)=>({id:r.id,sentAt:r.sent_at,lessonId:r.lesson_id,dayNumber:r.day_number,title:r.title,lessonText:r.lesson_text,actionText:r.action_text,cohortId:r.cohort_id,cohortName:r.cohort_name})) });
}));

router.get("/achievements", asyncHandler(async (req, res) => {
  const ids = identity(req);
  if (!ids) return res.status(403).json({ error: "Linked learner identity is required." });
  const result = await pool.query(`
    SELECT COUNT(DISTINCT r.id)::int AS reflections,COUNT(DISTINCT sm.id)::int AS messages,
      COUNT(DISTINCT CASE WHEN r.behavior_observed THEN r.id END)::int AS behaviors
    FROM users u LEFT JOIN cohort_users cu ON cu.user_id=u.id
    LEFT JOIN cohorts c ON c.id=cu.cohort_id AND c.organization_id=u.organization_id
    LEFT JOIN sent_messages sm ON sm.cohort_user_id=cu.id LEFT JOIN reflections r ON r.cohort_user_id=cu.id
    WHERE u.id=$1 AND u.organization_id=$2`, [ids.userId, ids.organizationId]);
  const v=result.rows[0];
  const definitions=[['first-reflection','First Reflection','Submit your first reflection',v.reflections>=1],['five-reflections','Consistent Learner','Submit five reflections',v.reflections>=5],['behavior-builder','Behavior Builder','Record an observed behavior',v.behaviors>=1],['ten-lessons','Ten Lessons','Receive ten leadership lessons',v.messages>=10]];
  return res.json({ achievements: definitions.map(([id,title,description,unlocked])=>({id,title,description,unlocked})) });
}));

router.get("/notifications", asyncHandler(async (req, res) => {
  const ids = identity(req);
  if (!ids) return res.status(403).json({ error: "Linked learner identity is required." });
  const result=await pool.query(`SELECT id,title,body,notification_type,read_at,created_at FROM learner_notifications WHERE user_id=$1 AND organization_id=$2 ORDER BY created_at DESC LIMIT 100`,[ids.userId,ids.organizationId]);
  return res.json({ notifications: result.rows.map((r)=>({id:r.id,title:r.title,body:r.body,type:r.notification_type,readAt:r.read_at,createdAt:r.created_at})) });
}));

router.patch("/notifications/:notificationId/read", asyncHandler(async (req, res) => {
  const ids = identity(req);
  if (!ids) return res.status(403).json({ error: "Linked learner identity is required." });
  const notificationId = Number(req.params.notificationId);
  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    return res.status(400).json({ error: "Invalid notification." });
  }
  const result = await pool.query(
    `UPDATE learner_notifications SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND user_id = $2 AND organization_id = $3
     RETURNING id, read_at`,
    [notificationId, ids.userId, ids.organizationId]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Notification not found." });
  return res.json({ id: result.rows[0].id, readAt: result.rows[0].read_at });
}));

router.get("/leaderboard", asyncHandler(async (req, res) => {
  const ids = identity(req);
  if (!ids) return res.status(403).json({ error: "Linked learner identity is required." });
  const parsedPeriod = leaderboardPeriodSchema.safeParse(req.query.period ?? "week");
  if (!parsedPeriod.success) return res.status(400).json({ error: "Invalid leaderboard period." });
  const since = parsedPeriod.data === "week"
    ? "NOW() - INTERVAL '7 days'"
    : parsedPeriod.data === "month"
      ? "NOW() - INTERVAL '30 days'"
      : null;
  const dateFilter = since ? `AND r.received_at >= ${since}` : "";
  const result = await pool.query(`
    SELECT u.id AS user_id, u.name AS display_name,
      COUNT(DISTINCT r.id)::int AS reflections,
      COUNT(DISTINCT CASE WHEN r.behavior_observed THEN r.id END)::int AS behaviors,
      COALESCE(SUM(CASE WHEN r.quality_score IS NOT NULL THEN r.quality_score ELSE 0 END), 0)::int AS quality_points,
      MAX(r.received_at) AS last_reflection_at
    FROM users u
    LEFT JOIN cohort_users cu ON cu.user_id = u.id
    LEFT JOIN cohorts c ON c.id = cu.cohort_id AND c.organization_id = u.organization_id
    LEFT JOIN reflections r ON r.cohort_user_id = cu.id ${dateFilter}
    WHERE u.organization_id = $1 AND u.status = 'active'
    GROUP BY u.id
    ORDER BY (COUNT(DISTINCT r.id) * 100 +
      COUNT(DISTINCT CASE WHEN r.behavior_observed THEN r.id END) * 25 +
      COALESCE(SUM(CASE WHEN r.quality_score IS NOT NULL THEN r.quality_score ELSE 0 END), 0)) DESC,
      u.name ASC`, [ids.organizationId]);
  return res.json({
    period: parsedPeriod.data,
    entries: result.rows.map((row, index) => ({
      rank: index + 1,
      userId: row.user_id,
      displayName: row.display_name,
      score: row.reflections * 100 + row.behaviors * 25 + row.quality_points,
      reflections: row.reflections,
      behaviors: row.behaviors,
      isCurrentUser: row.user_id === ids.userId,
      lastReflectionAt: row.last_reflection_at,
    })),
  });
}));

router.get("/referrals", asyncHandler(async(req,res)=>{
  const ids=identity(req);
  if(!ids)return res.status(403).json({error:"Linked learner identity is required."});
  let codeResult=await pool.query(`SELECT code FROM learner_referral_codes WHERE user_id=$1 AND organization_id=$2`,[ids.userId,ids.organizationId]);
  if(!codeResult.rowCount){
    const code=`TMS-${ids.userId}-${randomBytes(3).toString("hex").toUpperCase()}`;
    codeResult=await pool.query(`INSERT INTO learner_referral_codes(user_id,organization_id,code) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET organization_id=EXCLUDED.organization_id RETURNING code`,[ids.userId,ids.organizationId,code]);
  }
  const history=await pool.query(`SELECT id,referred_email,status,reward_xp,created_at,updated_at FROM learner_referrals WHERE referrer_user_id=$1 AND organization_id=$2 ORDER BY created_at DESC`,[ids.userId,ids.organizationId]);
  return res.json({code:codeResult.rows[0].code,shareLink:`https://textmesmp.com/join?ref=${encodeURIComponent(codeResult.rows[0].code)}`,summary:{total:history.rowCount,active:history.rows.filter(r=>r.status==="active").length,rewardXp:history.rows.reduce((sum,r)=>sum+Number(r.reward_xp),0)},history:history.rows.map(r=>({id:r.id,email:r.referred_email,status:r.status,rewardXp:r.reward_xp,createdAt:r.created_at,updatedAt:r.updated_at}))});
}));

router.post("/referrals", asyncHandler(async(req,res)=>{
  const ids=identity(req);
  if(!ids)return res.status(403).json({error:"Linked learner identity is required."});
  const parsed=referralSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"Enter a valid email address."});
  const own=await pool.query(`SELECT email FROM admin_users WHERE id=$1`,[req.auth!.adminId]);
  if(own.rows[0]?.email===parsed.data.email)return res.status(400).json({error:"You cannot refer your own email address."});
  try{
    const result=await pool.query(`INSERT INTO learner_referrals(referrer_user_id,organization_id,referred_email) VALUES($1,$2,$3) RETURNING id,referred_email,status,reward_xp,created_at,updated_at`,[ids.userId,ids.organizationId,parsed.data.email]);
    const r=result.rows[0];
    return res.status(201).json({referral:{id:r.id,email:r.referred_email,status:r.status,rewardXp:r.reward_xp,createdAt:r.created_at,updatedAt:r.updated_at}});
  }catch(error:any){if(error?.code==="23505")return res.status(409).json({error:"This email has already been referred."});throw error;}
}));

export default router;
