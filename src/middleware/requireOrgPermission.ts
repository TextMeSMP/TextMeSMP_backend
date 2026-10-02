import type {Request,Response,NextFunction} from "express";
import {pool} from "../db/pool";

export function requireOrgPermission(permission:string){
 return async(req:Request,res:Response,next:NextFunction)=>{
  if(req.auth?.role==="super_admin"||req.auth?.role==="org_admin")return next();
  const orgId=req.auth?.organizationId,role=req.auth?.role;
  if(!orgId||!role)return res.status(403).json({error:"Organization access required"});
  const result=await pool.query(`SELECT COALESCE((permissions ->> $3)::boolean,FALSE) AS allowed FROM organization_role_permissions WHERE organization_id=$1 AND role=$2`,[orgId,role,permission]);
  if(!result.rows[0]?.allowed)return res.status(403).json({error:"This action is disabled by organization permissions."});
  return next();
 };
}
