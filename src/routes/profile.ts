import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();
router.use(requireAuth);

const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  phoneNumber: z.string().trim().min(7).max(30).optional(),
}).strict();
const preferencesSchema = z.object({ smsNotifications: z.boolean(), emailNotifications: z.boolean() }).strict();
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(8).max(128) }).strict();

router.get("/me", asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT a.id,a.email,a.role,a.display_name,a.sms_notifications,a.email_notifications,a.user_id,
      u.name AS learner_name,u.phone_number,o.id AS organization_id,o.name AS organization_name,o.plan,o.is_paid
    FROM admin_users a
    LEFT JOIN users u ON u.id=a.user_id AND u.organization_id=a.organization_id
    LEFT JOIN organizations o ON o.id=a.organization_id
    WHERE a.id=$1 LIMIT 1`, [req.auth!.adminId]);
  if (!result.rowCount) return res.status(404).json({ error: "Profile not found." });
  const row=result.rows[0];
  return res.json({ profile:{ id:row.id,email:row.email,role:row.role,displayName:row.learner_name??row.display_name??row.email.split("@")[0],phoneNumber:row.phone_number??"",smsNotifications:row.sms_notifications,emailNotifications:row.email_notifications,organization:{id:row.organization_id,name:row.organization_name??"",plan:row.plan,isPaid:!!row.is_paid} } });
}));

router.put("/me", asyncHandler(async (req,res)=>{
  const parsed=profileSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"Invalid profile details."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const account=await client.query(`UPDATE admin_users SET display_name=$1 WHERE id=$2 RETURNING user_id,organization_id`,[parsed.data.displayName,req.auth!.adminId]);
    if(!account.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Profile not found."});}
    const row=account.rows[0];
    if(row.user_id){
      if(!parsed.data.phoneNumber){await client.query("ROLLBACK");return res.status(400).json({error:"Phone number is required for learner profiles."});}
      await client.query(`UPDATE users SET name=$1,phone_number=$2 WHERE id=$3 AND organization_id=$4`,[parsed.data.displayName,parsed.data.phoneNumber,row.user_id,row.organization_id]);
    }
    await client.query("COMMIT");
    return res.json({ok:true});
  }catch(error:any){
    await client.query("ROLLBACK");
    if(error?.code==="23505")return res.status(409).json({error:"Phone number is already in use."});
    throw error;
  }finally{client.release();}
}));

router.put("/preferences", asyncHandler(async(req,res)=>{
  const parsed=preferencesSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"Invalid notification preferences."});
  const result=await pool.query(`UPDATE admin_users SET sms_notifications=$1,email_notifications=$2 WHERE id=$3 RETURNING id`,[parsed.data.smsNotifications,parsed.data.emailNotifications,req.auth!.adminId]);
  if(!result.rowCount)return res.status(404).json({error:"Profile not found."});
  return res.json({ok:true});
}));

router.put("/password", asyncHandler(async(req,res)=>{
  const parsed=passwordSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"New password must be at least 8 characters."});
  const result=await pool.query(`SELECT password_hash FROM admin_users WHERE id=$1`,[req.auth!.adminId]);
  if(!result.rowCount)return res.status(404).json({error:"Account not found."});
  if(!await bcrypt.compare(parsed.data.currentPassword,result.rows[0].password_hash))return res.status(400).json({error:"Current password is incorrect."});
  const hash=await bcrypt.hash(parsed.data.newPassword,10);
  await pool.query(`UPDATE admin_users SET password_hash=$1 WHERE id=$2`,[hash,req.auth!.adminId]);
  return res.json({ok:true});
}));

export default router;
