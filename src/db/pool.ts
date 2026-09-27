import { Pool } from "pg";
import { env } from "../config/env";

export const pool = new Pool({
  // pg currently treats these modes as verify-full; make that behavior explicit
  // so future pg upgrades do not silently weaken certificate verification.
  connectionString: env.DATABASE_URL.replace(
    /([?&])sslmode=(prefer|require|verify-ca)(?=&|$)/i,
    "$1sslmode=verify-full"
  ),
  max: env.NODE_ENV === "production" ? 20 : 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});
