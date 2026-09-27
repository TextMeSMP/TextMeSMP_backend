BEGIN;
CREATE TABLE IF NOT EXISTS system_settings(key TEXT PRIMARY KEY,value JSONB NOT NULL,updated_by_admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
INSERT INTO system_settings(key,value)VALUES('platform','{"maintenanceMode":false,"analyticsEnabled":true,"emailNotifications":true,"pushNotifications":true,"autoSuspend":false,"trialExtend":true,"trialDurationDays":14,"dailyDigestTime":"09:00"}'::jsonb)ON CONFLICT DO NOTHING;
COMMIT;
