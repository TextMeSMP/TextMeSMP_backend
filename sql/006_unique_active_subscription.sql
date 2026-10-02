BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_subscription_email
ON organizations (lower(contact_email))
WHERE is_paid = true;

COMMIT;
