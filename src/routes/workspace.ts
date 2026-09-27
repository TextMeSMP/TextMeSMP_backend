import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { requirePaidOrg } from "../middleware/requirePaidOrg";
import { requireOrgPermission } from "../middleware/requireOrgPermission";

const router = Router();
const messageSchema=z.object({body:z.string().trim().min(1).max(1000),cohortId:z.number().int().positive().optional(),userId:z.number().int().positive().optional()}).strict().refine(v=>!!v.cohortId!==!!v.userId,{message:"Choose either a cohort or learner."});
const recommendationSchema=z.object({cohortId:z.number().int().positive(),userId:z.number().int().positive(),rationale:z.string().trim().min(10).max(2000)}).strict();
const workspaceUserBase=z.object({name:z.string().trim().min(2).max(120),phoneNumber:z.string().trim().min(7).max(30),roleLevel:z.enum(["agent","lead","supervisor","manager","executive"]),status:z.enum(["active","inactive"]).default("active"),cohortIds:z.array(z.number().int().positive()).max(50).default([]),email:z.string().trim().email().max(254).optional(),password:z.string().min(8).max(128).optional(),accountRole:z.enum(["learner","manager"]).default("learner")}).strict();
const workspaceUserSchema=workspaceUserBase.refine(v=>(v.email&&v.password)||(!v.email&&!v.password),{message:"Email and password must be provided together."});
const workspaceUserUpdateSchema=workspaceUserBase;
const permissionsSchema=z.object({role:z.enum(["learner","manager","org_admin"]),permissions:z.record(z.boolean()),allowUserInvitations:z.boolean(),ssoEnabled:z.boolean(),mfaRequired:z.boolean()}).strict();
const reportQuerySchema=z.object({cohortId:z.coerce.number().int().positive().optional(),from:z.string().date().optional(),to:z.string().date().optional()});
const csvCell=(value:unknown)=>`"${String(value??"").replace(/"/g,'""')}"`;
router.use(requireAuth);
router.use(["/overview", "/users", "/messages", "/permissions"], requirePaidOrg);

router.get("/overview", requireRole("manager", "org_admin"),requireOrgPermission("view_analytics"), asyncHandler(async (req, res) => {
  const orgId = req.auth!.organizationId;
  if (!orgId) return res.status(403).json({ error: "Organization access required" });

  const [orgResult, metricsResult, cohortsResult, atRiskResult] = await Promise.all([
    pool.query(`SELECT id, name, contact_email, timezone, plan, is_paid FROM organizations WHERE id = $1`, [orgId]),
    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE organization_id = $1 AND status = 'active') AS total_learners,
        (SELECT COUNT(*)::int FROM cohorts WHERE organization_id = $1) AS active_cohorts,
        (SELECT COUNT(*)::int FROM sent_messages sm JOIN cohort_users cu ON cu.id = sm.cohort_user_id JOIN cohorts c ON c.id = cu.cohort_id WHERE c.organization_id = $1) AS messages_sent,
        (SELECT COUNT(*)::int FROM reflections r JOIN cohort_users cu ON cu.id = r.cohort_user_id JOIN cohorts c ON c.id = cu.cohort_id WHERE c.organization_id = $1) AS reflections_count,
        (SELECT AVG(r.quality_score)::float FROM reflections r JOIN cohort_users cu ON cu.id = r.cohort_user_id JOIN cohorts c ON c.id = cu.cohort_id WHERE c.organization_id = $1 AND r.quality_score IS NOT NULL) AS average_quality
    `, [orgId]),
    pool.query(`
      SELECT c.id, c.name, c.role_level, c.start_date, c.duration_days,
        COUNT(DISTINCT cu.id)::int AS learner_count,
        COUNT(DISTINCT sm.id)::int AS messages_sent,
        COUNT(DISTINCT r.id)::int AS reflections_count
      FROM cohorts c
      LEFT JOIN cohort_users cu ON cu.cohort_id = c.id
      LEFT JOIN sent_messages sm ON sm.cohort_user_id = cu.id
      LEFT JOIN reflections r ON r.cohort_user_id = cu.id
      WHERE c.organization_id = $1
      GROUP BY c.id ORDER BY c.start_date DESC, c.id DESC
    `, [orgId]),
    pool.query(`
      SELECT cu.id AS cohort_user_id, u.id AS user_id, u.name, c.id AS cohort_id, c.name AS cohort_name,
        COUNT(DISTINCT sm.id)::int AS messages_sent,
        COUNT(DISTINCT r.id)::int AS reflections_count,
        MAX(r.received_at) AS last_reflection_at
      FROM cohort_users cu
      JOIN users u ON u.id = cu.user_id
      JOIN cohorts c ON c.id = cu.cohort_id
      LEFT JOIN sent_messages sm ON sm.cohort_user_id = cu.id
      LEFT JOIN reflections r ON r.cohort_user_id = cu.id
      WHERE c.organization_id = $1
      GROUP BY cu.id, u.id, u.name, c.id, c.name
      HAVING COUNT(DISTINCT sm.id) > 0 AND COUNT(DISTINCT r.id)::float / COUNT(DISTINCT sm.id) < 0.5
      ORDER BY (COUNT(DISTINCT r.id)::float / COUNT(DISTINCT sm.id)) ASC LIMIT 20
    `, [orgId]),
  ]);

  if (!orgResult.rows.length) return res.status(404).json({ error: "Organization not found" });
  const metrics = metricsResult.rows[0];
  const cohorts = cohortsResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    roleLevel: row.role_level,
    startDate: row.start_date,
    durationDays: row.duration_days,
    learnerCount: row.learner_count,
    messagesSent: row.messages_sent,
    reflectionsCount: row.reflections_count,
    completionRate: row.messages_sent > 0 ? Math.round(100 * row.reflections_count / row.messages_sent) : null,
  }));
  res.json({
    organization: {
      id: orgResult.rows[0].id,
      name: orgResult.rows[0].name,
      contactEmail: orgResult.rows[0].contact_email ?? "",
      timezone: orgResult.rows[0].timezone ?? "",
      plan: orgResult.rows[0].plan,
      isPaid: orgResult.rows[0].is_paid,
    },
    metrics: {
      totalLearners: metrics.total_learners,
      activeCohorts: metrics.active_cohorts,
      messagesSent: metrics.messages_sent,
      reflectionsCount: metrics.reflections_count,
      completionRate: metrics.messages_sent > 0 ? Math.round(100 * metrics.reflections_count / metrics.messages_sent) : null,
      averageQuality: metrics.average_quality ?? null,
    },
    cohorts,
    atRiskLearners: atRiskResult.rows.map((row) => ({
      cohortUserId: row.cohort_user_id,
      userId: row.user_id,
      name: row.name,
      cohortId: row.cohort_id,
      cohortName: row.cohort_name,
      completionPercent: row.messages_sent > 0 ? Math.round(100 * row.reflections_count / row.messages_sent) : 0,
      lastReflectionAt: row.last_reflection_at,
    })),
  });
}));

router.get("/users", requireRole("manager", "org_admin"),requireOrgPermission("manage_learners"), asyncHandler(async (req, res) => {
  const orgId = req.auth!.organizationId;
  if (!orgId) return res.status(403).json({ error: "Organization access required" });
  const result = await pool.query(`
    SELECT u.id, u.name, u.phone_number, u.role_level, u.status,a.email,a.role AS account_role,
      COALESCE(json_agg(json_build_object('id', c.id, 'name', c.name)) FILTER (WHERE c.id IS NOT NULL), '[]') AS cohorts
    FROM users u
    LEFT JOIN cohort_users cu ON cu.user_id = u.id
    LEFT JOIN cohorts c ON c.id = cu.cohort_id AND c.organization_id = $1
    LEFT JOIN admin_users a ON a.user_id=u.id AND a.organization_id=$1
    WHERE u.organization_id = $1
    GROUP BY u.id,a.email,a.role ORDER BY u.name
  `, [orgId]);
  res.json({ users: result.rows.map((row) => ({ id: row.id, name: row.name, phoneNumber: row.phone_number, roleLevel: row.role_level, status: row.status, email:row.email??null,accountRole:row.account_role??null, cohorts: row.cohorts })) });
}));

router.post("/users", requireRole("org_admin"), asyncHandler(async(req,res)=>{
  const orgId=req.auth!.organizationId;const parsed=workspaceUserSchema.safeParse(req.body);
  if(!orgId)return res.status(403).json({error:"Organization access required"});
  if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message??"Invalid user details."});
  const d=parsed.data;const client=await pool.connect();try{await client.query("BEGIN");
    if(d.cohortIds.length){const valid=await client.query(`SELECT id FROM cohorts WHERE organization_id=$1 AND id=ANY($2::int[])`,[orgId,d.cohortIds]);if(valid.rowCount!==new Set(d.cohortIds).size){await client.query("ROLLBACK");return res.status(400).json({error:"One or more cohorts are invalid."});}}
    const user=await client.query(`INSERT INTO users(name,phone_number,role_level,status,organization_id) VALUES($1,$2,$3,$4,$5) RETURNING id`,[d.name,d.phoneNumber,d.roleLevel,d.status,orgId]);const userId=user.rows[0].id;
    for(const cohortId of d.cohortIds)await client.query(`INSERT INTO cohort_users(cohort_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[cohortId,userId]);
    if(d.email&&d.password){const hash=await bcrypt.hash(d.password,10);await client.query(`INSERT INTO admin_users(email,password_hash,organization_id,user_id,role,display_name) VALUES($1,$2,$3,$4,$5,$6)`,[d.email.toLowerCase(),hash,orgId,d.accountRole==='learner'?userId:null,d.accountRole,d.name]);}
    await client.query("COMMIT");return res.status(201).json({id:userId});
  }catch(e:any){await client.query("ROLLBACK");if(e?.code==="23505")return res.status(409).json({error:"Email, phone number, or learner account is already in use."});throw e;}finally{client.release();}
}));

router.put("/users/:userId", requireRole("org_admin"), asyncHandler(async(req,res)=>{
  const orgId=req.auth!.organizationId,userId=Number(req.params.userId),parsed=workspaceUserUpdateSchema.safeParse(req.body);
  if(!orgId)return res.status(403).json({error:"Organization access required"});if(!Number.isInteger(userId)||userId<=0||!parsed.success)return res.status(400).json({error:parsed.success?"Invalid user.":parsed.error.issues[0]?.message??"Invalid user details."});
  const d=parsed.data,client=await pool.connect();try{await client.query("BEGIN");const updated=await client.query(`UPDATE users SET name=$1,phone_number=$2,role_level=$3,status=$4 WHERE id=$5 AND organization_id=$6 RETURNING id`,[d.name,d.phoneNumber,d.roleLevel,d.status,userId,orgId]);if(!updated.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"User not found."});}
    if(d.cohortIds.length){const valid=await client.query(`SELECT id FROM cohorts WHERE organization_id=$1 AND id=ANY($2::int[])`,[orgId,d.cohortIds]);if(valid.rowCount!==new Set(d.cohortIds).size){await client.query("ROLLBACK");return res.status(400).json({error:"One or more cohorts are invalid."});}}
    await client.query(`DELETE FROM cohort_users cu USING cohorts c WHERE cu.cohort_id=c.id AND cu.user_id=$1 AND c.organization_id=$2`,[userId,orgId]);for(const cohortId of d.cohortIds)await client.query(`INSERT INTO cohort_users(cohort_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[cohortId,userId]);
    const account=await client.query(`SELECT id FROM admin_users WHERE organization_id=$1 AND user_id=$2`,[orgId,userId]);if(d.email){if(account.rowCount){await client.query(`UPDATE admin_users SET email=$1,role=$2,display_name=$3 WHERE id=$4`,[d.email.toLowerCase(),d.accountRole,d.name,account.rows[0].id]);if(d.password){await client.query(`UPDATE admin_users SET password_hash=$1 WHERE id=$2`,[await bcrypt.hash(d.password,10),account.rows[0].id]);}}else if(d.password){await client.query(`INSERT INTO admin_users(email,password_hash,organization_id,user_id,role,display_name) VALUES($1,$2,$3,$4,$5,$6)`,[d.email.toLowerCase(),await bcrypt.hash(d.password,10),orgId,d.accountRole==='learner'?userId:null,d.accountRole,d.name]);}}
    await client.query("COMMIT");return res.json({ok:true});
  }catch(e:any){await client.query("ROLLBACK");if(e?.code==="23505")return res.status(409).json({error:"Email or phone number is already in use."});throw e;}finally{client.release();}
}));

router.patch("/users/:userId/status",requireRole("org_admin"),asyncHandler(async(req,res)=>{const orgId=req.auth!.organizationId,userId=Number(req.params.userId),parsed=z.object({status:z.enum(["active","inactive"])}).strict().safeParse(req.body);if(!orgId)return res.status(403).json({error:"Organization access required"});if(!Number.isInteger(userId)||!parsed.success)return res.status(400).json({error:"Invalid status update."});const result=await pool.query(`UPDATE users SET status=$1 WHERE id=$2 AND organization_id=$3 RETURNING id`,[parsed.data.status,userId,orgId]);if(!result.rowCount)return res.status(404).json({error:"User not found."});return res.json({ok:true});}));

router.get("/messages", requireRole("manager", "org_admin"), asyncHandler(async (req, res) => {
  const orgId = req.auth!.organizationId;
  if (!orgId) return res.status(403).json({ error: "Organization access required" });
  const result = await pool.query(`
    SELECT sm.id,sm.sent_at,u.id AS user_id,u.name AS learner_name,c.id AS cohort_id,
      c.name AS cohort_name,l.id AS lesson_id,l.day_number,l.title,l.lesson_text
    FROM sent_messages sm JOIN cohort_users cu ON cu.id=sm.cohort_user_id
    JOIN users u ON u.id=cu.user_id AND u.organization_id=$1
    JOIN cohorts c ON c.id=cu.cohort_id AND c.organization_id=$1
    JOIN lessons l ON l.id=sm.lesson_id ORDER BY sm.sent_at DESC LIMIT 200`, [orgId]);
  return res.json({ messages: result.rows.map((r)=>({id:r.id,sentAt:r.sent_at,userId:r.user_id,learnerName:r.learner_name,cohortId:r.cohort_id,cohortName:r.cohort_name,lessonId:r.lesson_id,dayNumber:r.day_number,title:r.title,lessonText:r.lesson_text})) });
}));

router.post("/messages", requireRole("manager","org_admin"),requireOrgPermission("send_team_messages"), asyncHandler(async(req,res)=>{
  const orgId=req.auth!.organizationId;const parsed=messageSchema.safeParse(req.body);
  if(!orgId)return res.status(403).json({error:"Organization access required"});
  if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message??"Invalid message."});
  const {body,cohortId,userId}=parsed.data;
  if(cohortId){const target=await pool.query(`SELECT id FROM cohorts WHERE id=$1 AND organization_id=$2`,[cohortId,orgId]);if(!target.rowCount)return res.status(404).json({error:"Cohort not found."});}
  if(userId){const target=await pool.query(`SELECT id FROM users WHERE id=$1 AND organization_id=$2`,[userId,orgId]);if(!target.rowCount)return res.status(404).json({error:"Learner not found."});}
  const client=await pool.connect();try{await client.query("BEGIN");const result=await client.query(`INSERT INTO manager_messages(organization_id,sender_admin_id,cohort_id,user_id,body) VALUES($1,$2,$3,$4,$5) RETURNING id,created_at`,[orgId,req.auth!.adminId,cohortId??null,userId??null,body]);if(userId){await client.query(`INSERT INTO learner_notifications(user_id,organization_id,title,body,notification_type) VALUES($1,$2,'Message from your manager',$3,'manager_message')`,[userId,orgId,body]);}else{await client.query(`INSERT INTO learner_notifications(user_id,organization_id,title,body,notification_type) SELECT DISTINCT cu.user_id,$2,'Message from your manager',$3,'manager_message' FROM cohort_users cu JOIN users u ON u.id=cu.user_id AND u.organization_id=$2 WHERE cu.cohort_id=$1`,[cohortId,orgId,body]);}await client.query("COMMIT");return res.status(201).json({message:{id:result.rows[0].id,createdAt:result.rows[0].created_at}});}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}));

router.get("/recommendations", requireRole("manager","org_admin"), asyncHandler(async(req,res)=>{const orgId=req.auth!.organizationId;if(!orgId)return res.status(403).json({error:"Organization access required"});const result=await pool.query(`SELECT pr.id,pr.cohort_id,pr.user_id,pr.rationale,pr.status,pr.created_at,u.name AS learner_name,c.name AS cohort_name FROM promotion_recommendations pr JOIN users u ON u.id=pr.user_id AND u.organization_id=pr.organization_id JOIN cohorts c ON c.id=pr.cohort_id AND c.organization_id=pr.organization_id WHERE pr.organization_id=$1 ORDER BY pr.created_at DESC`,[orgId]);return res.json({recommendations:result.rows.map(r=>({id:r.id,cohortId:r.cohort_id,userId:r.user_id,rationale:r.rationale,status:r.status,createdAt:r.created_at,learnerName:r.learner_name,cohortName:r.cohort_name}))});}));

router.post("/recommendations", requireRole("manager","org_admin"), asyncHandler(async(req,res)=>{const orgId=req.auth!.organizationId;const parsed=recommendationSchema.safeParse(req.body);if(!orgId)return res.status(403).json({error:"Organization access required"});if(!parsed.success)return res.status(400).json({error:"Select a learner and enter at least 10 characters of rationale."});const target=await pool.query(`SELECT cu.id FROM cohort_users cu JOIN users u ON u.id=cu.user_id AND u.organization_id=$3 JOIN cohorts c ON c.id=cu.cohort_id AND c.organization_id=$3 WHERE cu.cohort_id=$1 AND cu.user_id=$2`,[parsed.data.cohortId,parsed.data.userId,orgId]);if(!target.rowCount)return res.status(404).json({error:"Learner is not assigned to this cohort."});try{const result=await pool.query(`INSERT INTO promotion_recommendations(organization_id,cohort_id,user_id,submitted_by_admin_id,rationale) VALUES($1,$2,$3,$4,$5) RETURNING id,status,created_at`,[orgId,parsed.data.cohortId,parsed.data.userId,req.auth!.adminId,parsed.data.rationale]);return res.status(201).json({recommendation:{id:result.rows[0].id,status:result.rows[0].status,createdAt:result.rows[0].created_at}});}catch(e:any){if(e?.code==="23505")return res.status(409).json({error:"A pending recommendation already exists for this learner."});throw e;}}));

router.patch("/recommendations/:id/status",requireRole("org_admin"),asyncHandler(async(req,res)=>{const orgId=req.auth!.organizationId,id=Number(req.params.id),parsed=z.object({status:z.enum(["approved","rejected"])}).strict().safeParse(req.body);if(!orgId)return res.status(403).json({error:"Organization access required"});if(!Number.isInteger(id)||!parsed.success)return res.status(400).json({error:"Invalid recommendation decision."});const result=await pool.query(`UPDATE promotion_recommendations SET status=$1,reviewed_by_admin_id=$2,reviewed_at=NOW(),updated_at=NOW() WHERE id=$3 AND organization_id=$4 AND status='pending' RETURNING user_id`,[parsed.data.status,req.auth!.adminId,id,orgId]);if(!result.rowCount)return res.status(404).json({error:"Pending recommendation not found."});await pool.query(`INSERT INTO learner_notifications(user_id,organization_id,title,body,notification_type)VALUES($1,$2,'Promotion recommendation updated',$3,'promotion')`,[result.rows[0].user_id,orgId,`Your promotion recommendation was ${parsed.data.status}.`]);return res.json({ok:true});}));

router.get("/permissions", requireRole("org_admin"), asyncHandler(async (req, res) => {
  const orgId = req.auth!.organizationId;
  if (!orgId) return res.status(403).json({ error: "Organization access required" });
  const result = await pool.query(`SELECT id, email, role, created_at FROM admin_users WHERE organization_id = $1 ORDER BY email`, [orgId]);
  res.json({ members: result.rows.map((row) => ({ id: row.id, email: row.email, role: row.role, createdAt: row.created_at })) });
}));

router.get("/permission-settings",requireRole("org_admin"),asyncHandler(async(req,res)=>{const orgId=req.auth!.organizationId;if(!orgId)return res.status(403).json({error:"Organization access required"});const[org,roles]=await Promise.all([pool.query(`SELECT allow_user_invitations,sso_enabled,mfa_required FROM organizations WHERE id=$1`,[orgId]),pool.query(`SELECT role,permissions FROM organization_role_permissions WHERE organization_id=$1`,[orgId])]);return res.json({allowUserInvitations:org.rows[0]?.allow_user_invitations??true,ssoEnabled:org.rows[0]?.sso_enabled??false,mfaRequired:org.rows[0]?.mfa_required??false,roles:Object.fromEntries(roles.rows.map(r=>[r.role,r.permissions]))});}));

router.put("/permission-settings",requireRole("org_admin"),asyncHandler(async(req,res)=>{const orgId=req.auth!.organizationId,parsed=permissionsSchema.safeParse(req.body);if(!orgId)return res.status(403).json({error:"Organization access required"});if(!parsed.success)return res.status(400).json({error:"Invalid permission settings."});const client=await pool.connect();try{await client.query("BEGIN");await client.query(`INSERT INTO organization_role_permissions(organization_id,role,permissions,updated_at) VALUES($1,$2,$3::jsonb,NOW()) ON CONFLICT(organization_id,role) DO UPDATE SET permissions=EXCLUDED.permissions,updated_at=NOW()`,[orgId,parsed.data.role,JSON.stringify(parsed.data.permissions)]);await client.query(`UPDATE organizations SET allow_user_invitations=$1,sso_enabled=$2,mfa_required=$3,updated_at=NOW() WHERE id=$4`,[parsed.data.allowUserInvitations,parsed.data.ssoEnabled,parsed.data.mfaRequired,orgId]);await client.query("COMMIT");return res.json({ok:true});}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}}));

router.get("/reports/export",requireRole("org_admin"),requireOrgPermission("export_reports"),asyncHandler(async(req,res)=>{const orgId=req.auth!.organizationId,parsed=reportQuerySchema.safeParse(req.query);if(!orgId)return res.status(403).json({error:"Organization access required"});if(!parsed.success)return res.status(400).json({error:"Invalid report filters."});const {cohortId,from,to}=parsed.data;if(from&&to&&from>to)return res.status(400).json({error:"From date must be before to date."});const result=await pool.query(`SELECT c.name AS cohort,u.name AS learner,u.phone_number,l.day_number,l.title,sm.sent_at,r.received_at,r.quality_score,r.behavior_observed FROM users u JOIN cohort_users cu ON cu.user_id=u.id JOIN cohorts c ON c.id=cu.cohort_id AND c.organization_id=u.organization_id LEFT JOIN sent_messages sm ON sm.cohort_user_id=cu.id LEFT JOIN lessons l ON l.id=sm.lesson_id LEFT JOIN reflections r ON r.cohort_user_id=cu.id AND r.lesson_id=l.id WHERE u.organization_id=$1 AND ($2::int IS NULL OR c.id=$2) AND ($3::date IS NULL OR COALESCE(r.received_at,sm.sent_at)::date >= $3::date) AND ($4::date IS NULL OR COALESCE(r.received_at,sm.sent_at)::date <= $4::date) ORDER BY c.name,u.name,l.day_number`,[orgId,cohortId??null,from??null,to??null]);const headers=['Cohort','Learner','Phone','Lesson Day','Lesson','Sent At','Reflection At','Quality','Behavior Observed'];const lines=[headers.map(csvCell).join(','),...result.rows.map(r=>[r.cohort,r.learner,r.phone_number,r.day_number,r.title,r.sent_at?.toISOString?.()??r.sent_at,r.received_at?.toISOString?.()??r.received_at,r.quality_score,r.behavior_observed].map(csvCell).join(','))];return res.json({filename:`textmesmp-report-${new Date().toISOString().slice(0,10)}.csv`,mimeType:'text/csv',content:lines.join('\n'),rowCount:result.rowCount});}));

router.get("/admin/cohorts", requireRole("super_admin"), asyncHandler(async (_req, res) => {
  const result = await pool.query(`
    SELECT c.id, c.name, c.role_level, c.start_date, c.duration_days,c.status, o.id AS organization_id, o.name AS organization_name,
      COUNT(cu.id)::int AS learner_count
    FROM cohorts c JOIN organizations o ON o.id = c.organization_id
    LEFT JOIN cohort_users cu ON cu.cohort_id = c.id
    GROUP BY c.id, o.id ORDER BY c.start_date DESC, c.id DESC
  `);
  res.json({ cohorts: result.rows.map((row) => ({ id: row.id, name: row.name, roleLevel: row.role_level, startDate: row.start_date, durationDays: row.duration_days,status:row.status, organizationId: row.organization_id, organizationName: row.organization_name, learnerCount: row.learner_count })) });
}));

router.get("/admin/overview", requireRole("super_admin"), asyncHandler(async (_req, res) => {
  const [organizations, users, accounts, lessons, totals] = await Promise.all([
    pool.query(`SELECT o.id,o.name,o.contact_email,o.is_paid,o.plan,o.is_active,o.created_at,
      COUNT(DISTINCT u.id)::int AS user_count,COUNT(DISTINCT c.id)::int AS cohort_count
      FROM organizations o LEFT JOIN users u ON u.organization_id=o.id
      LEFT JOIN cohorts c ON c.organization_id=o.id GROUP BY o.id ORDER BY o.created_at DESC`),
    pool.query(`SELECT u.id,u.name,u.phone_number,u.role_level,u.status,u.organization_id,o.name AS organization_name
      FROM users u JOIN organizations o ON o.id=u.organization_id ORDER BY u.created_at DESC`),
    pool.query(`SELECT a.id,a.email,a.role,a.user_id,a.organization_id,a.is_active,o.name AS organization_name,a.created_at
      FROM admin_users a LEFT JOIN organizations o ON o.id=a.organization_id ORDER BY a.created_at DESC`),
    pool.query(`SELECT id,role_level,day_number,title,lesson_text,action_text,reflection_question FROM lessons ORDER BY role_level,day_number`),
    pool.query(`SELECT (SELECT COUNT(*)::int FROM organizations) AS organizations,
      (SELECT COUNT(*)::int FROM users) AS users,(SELECT COUNT(*)::int FROM cohorts) AS cohorts,
      (SELECT COUNT(*)::int FROM sent_messages) AS messages,(SELECT COUNT(*)::int FROM reflections) AS reflections`),
  ]);
  return res.json({ totals:totals.rows[0], organizations:organizations.rows, users:users.rows, accounts:accounts.rows, lessons:lessons.rows });
}));

export default router;
