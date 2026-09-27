BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS allow_user_invitations BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sso_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mfa_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS organization_role_permissions (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('learner','manager','org_admin')),
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, role)
);

INSERT INTO organization_role_permissions(organization_id,role,permissions)
SELECT id,'learner','{"view_own_progress":true,"complete_lessons":true}'::jsonb FROM organizations
ON CONFLICT DO NOTHING;
INSERT INTO organization_role_permissions(organization_id,role,permissions)
SELECT id,'manager','{"view_cohort_data":true,"manage_learners":true,"send_team_messages":true,"view_analytics":true,"submit_recommendations":true}'::jsonb FROM organizations
ON CONFLICT DO NOTHING;
INSERT INTO organization_role_permissions(organization_id,role,permissions)
SELECT id,'org_admin','{"manage_users":true,"billing_access":true,"edit_org_settings":true,"export_reports":true,"review_recommendations":true}'::jsonb FROM organizations
ON CONFLICT DO NOTHING;

COMMIT;
