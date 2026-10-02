BEGIN;

CREATE TABLE IF NOT EXISTS demo_requests (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_demo_requests_email_created_at
  ON demo_requests (email, created_at DESC);

COMMIT;
