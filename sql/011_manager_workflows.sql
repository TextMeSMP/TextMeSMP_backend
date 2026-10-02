BEGIN;

CREATE TABLE IF NOT EXISTS manager_messages (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sender_admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  cohort_id INTEGER REFERENCES cohorts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cohort_id IS NOT NULL OR user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_manager_messages_scope ON manager_messages(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS promotion_recommendations (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submitted_by_admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewed_by_admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_promotion ON promotion_recommendations(organization_id,cohort_id,user_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_promotion_scope_status ON promotion_recommendations(organization_id,status,created_at DESC);

COMMIT;
