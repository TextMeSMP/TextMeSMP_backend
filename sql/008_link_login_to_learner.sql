BEGIN;

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS user_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_users_user_id_key'
      AND conrelid = 'admin_users'::regclass
  ) THEN
    ALTER TABLE admin_users
      ADD CONSTRAINT admin_users_user_id_key UNIQUE (user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_admin_users_user'
      AND conrelid = 'admin_users'::regclass
  ) THEN
    ALTER TABLE admin_users
      ADD CONSTRAINT fk_admin_users_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_admin_users_user_id
  ON admin_users(user_id);

COMMIT;
