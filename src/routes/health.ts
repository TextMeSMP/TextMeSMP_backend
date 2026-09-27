import { Router } from "express";
import { pool } from "../db/pool";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const db = await pool.query("SELECT 1 AS ok");
  res.json({ ok: true, db: db.rows[0]?.ok === 1 });
});
