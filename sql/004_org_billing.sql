BEGIN;

-- 1) Organizations (billing source of truth)
CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact_email TEXT,
  is_paid BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT CHECK (
    plan IN ('subscription','per_learner','cohort','bronze','silver','gold')
    OR plan IS NULL
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Ensure columns exist if table already existed (safe)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 3) Add org_id columns to existing tables
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS organization_id INT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INT;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS organization_id INT;

-- 4) Create default org (prevents FK failure)
INSERT INTO organizations (id, name, is_paid)
VALUES (1, 'Default Org', FALSE)
ON CONFLICT (id) DO NOTHING;

-- 5) Backfill existing rows so org_id is never null
UPDATE admin_users SET organization_id = 1 WHERE organization_id IS NULL;
UPDATE users SET organization_id = 1 WHERE organization_id IS NULL;
UPDATE cohorts SET organization_id = 1 WHERE organization_id IS NULL;

-- 6) Add foreign keys safely (only if not already present)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_admin_users_org') THEN
    ALTER TABLE admin_users
      ADD CONSTRAINT fk_admin_users_org
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_org') THEN
    ALTER TABLE users
      ADD CONSTRAINT fk_users_org
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_cohorts_org') THEN
    ALTER TABLE cohorts
      ADD CONSTRAINT fk_cohorts_org
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

COMMIT;
