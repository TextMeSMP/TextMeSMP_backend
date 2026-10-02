alter table organizations
  add column if not exists pilot_paid boolean default false,
  add column if not exists pilot_amount_cents integer,
  add column if not exists pilot_paid_at timestamptz,
  add column if not exists subscription_started_at timestamptz,
  add column if not exists price_locked_until timestamptz,
  add column if not exists founding_partner boolean default false;
