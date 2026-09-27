TRAINING MVP (Backend) — Express + TypeScript + Postgres
=======================================================

This backend powers the Training MVP app.

Tech stack:
- Node.js + Express
- TypeScript
- PostgreSQL
- Stripe (subscriptions)
- JWT auth (protected routes)

NOTE: This setup does NOT use Docker.


-------------------------------------------------------
1) Requirements
-------------------------------------------------------
- Node.js 18+ (Node 20+ recommended)
- PostgreSQL 13+ (local install or hosted)
- psql CLI (recommended)

If you don’t have psql:
- Install Postgres from official installer and make sure psql is added to PATH.


-------------------------------------------------------
2) Install dependencies
-------------------------------------------------------
Open terminal inside backend folder:

  npm install


-------------------------------------------------------
3) Environment variables (.env)
-------------------------------------------------------
Create a .env file in the backend root.

Minimum recommended:

  PORT=4001

  DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/training_mvp

  JWT_SECRET=some_super_secret_value

  APP_URL=http://localhost:5173


Stripe (required for billing):
  STRIPE_SECRET_KEY=sk_test_...

  STRIPE_PRICE_BRONZE=price_...
  STRIPE_PRICE_SILVER=price_...
  STRIPE_PRICE_GOLD=price_...

Optional (if your code still supports it):
  STRIPE_PRICE_SUBSCRIPTION=price_...


-------------------------------------------------------
4) Create local database (NO Docker)
-------------------------------------------------------
Option A: createdb
  createdb training_mvp

Option B: psql
  psql -U postgres -c "CREATE DATABASE training_mvp;"


-------------------------------------------------------
5) Run SQL migrations
-------------------------------------------------------
This project includes SQL files under /sql.
Run them in order (001, 002, 003...).

PowerShell example:
  psql $env:DATABASE_URL -f sql/001_schema.sql
  psql $env:DATABASE_URL -f sql/002_seed.sql
  psql $env:DATABASE_URL -f sql/003_auth_orgs.sql
  psql $env:DATABASE_URL -f sql/004_org_billing.sql
  psql $env:DATABASE_URL -f sql/007_admin_roles.sql

Bash example:
  psql "$DATABASE_URL" -f sql/001_schema.sql
  psql "$DATABASE_URL" -f sql/002_seed.sql
  psql "$DATABASE_URL" -f sql/003_auth_orgs.sql
  psql "$DATABASE_URL" -f sql/004_org_billing.sql
  psql "$DATABASE_URL" -f sql/007_admin_roles.sql


IMPORTANT: “column does not exist” errors
-----------------------------------------
If your backend crashes with something like:
  error: column "timezone" does not exist

That means your database schema is behind your code.

Fix it by adding a migration OR altering the table manually:

  ALTER TABLE organizations ADD COLUMN IF NOT EXISTS timezone TEXT;

Then restart backend.


-------------------------------------------------------
6) Run the backend locally
-------------------------------------------------------
Dev mode (hot reload):
  npm run dev

You should see:
  Backend running: http://localhost:4001

Production mode:
  npm run build
  npm start


-------------------------------------------------------
7) Test routes quickly
-------------------------------------------------------
Public demo request (guest):
  POST http://localhost:4001/api/public/demo-request

Billing status (auth required):
  GET http://localhost:4001/api/billing/status

If you are testing protected routes, make sure you:
- login first
- send auth token/cookie as your app expects


-------------------------------------------------------
8) Deploy setup (Separate repos)
-------------------------------------------------------
Recommended:
- Frontend in one GitHub repo → Deploy to Vercel
- Backend in one GitHub repo → Deploy to Render
- Database → Render Postgres (recommended)


-------------------------------------------------------
9) Deploy backend to Render
-------------------------------------------------------
1) Push backend to a GitHub repo.
2) On Render:
   - New → Web Service → Connect repo
3) Build Command:
     npm ci && npm run build
4) Start Command:
     npm start
5) Add environment variables in Render:
   - DATABASE_URL (Render Postgres connection string)
   - JWT_SECRET
   - APP_URL (your Vercel domain, ex: https://yourapp.vercel.app)
   - STRIPE_SECRET_KEY
   - STRIPE_PRICE_BRONZE / SILVER / GOLD

6) Run SQL migrations on Render database:
   - Use psql with Render DATABASE_URL, or Render’s DB console, and run:
     psql "YOUR_RENDER_DATABASE_URL" -f sql/001_schema.sql
     psql "YOUR_RENDER_DATABASE_URL" -f sql/002_seed.sql
     psql "YOUR_RENDER_DATABASE_URL" -f sql/003_auth_orgs.sql
   psql "YOUR_RENDER_DATABASE_URL" -f sql/004_org_billing.sql
   psql "YOUR_RENDER_DATABASE_URL" -f sql/007_admin_roles.sql

7) After migration, redeploy backend if needed.


-------------------------------------------------------
10) Deploy frontend to Vercel
-------------------------------------------------------
1) Push frontend to a GitHub repo.
2) On Vercel: New Project → import repo
3) Add environment variable in Vercel:
     VITE_API_URL=https://your-backend.onrender.com
4) Redeploy.

Make sure your frontend uses:
  (import.meta as any).env?.VITE_API_URL
as the API base.


-------------------------------------------------------
11) Common deployment issues
-------------------------------------------------------
A) CORS / cookies auth
If auth is cookie-based:
- Backend must allow your Vercel domain in CORS
- Frontend must send:
    credentials: "include"
- Cookies in production should be:
    SameSite=None; Secure

B) Stripe API version error
If you see:
  Invalid Stripe API version: 2025-12-18.clover
Use a real Stripe API version OR remove apiVersion from Stripe constructor.

C) White screen / UI not rendering after backend
Often caused by:
- blocking render on failed fetch
- throwing errors in useEffect without fallback UI
- incorrect image public paths
- CSS overridden / build not loading

(For UI issues, check console errors and network tab.)


-------------------------------------------------------
12) Notes / Good practices
-------------------------------------------------------
- Every schema change should become a new SQL file in /sql (example: sql/005_add_timezone.sql)
- Keep dev and prod env variables separate
- Keep APP_URL correct for Stripe success/cancel redirects


-------------------------------------------------------
END
-------------------------------------------------------
