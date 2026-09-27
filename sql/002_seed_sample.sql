BEGIN;

-- =========================
-- 0) Ensure required tables exist (light safety)
-- =========================
-- Assuming you've already executed:
-- users/cohorts/cohort_users/lessons/sent_messages/reflections schema
-- plus admin_users.sql, org_billing.sql, demo_request.sql, uniq_active_subscription_email.sql

-- =========================
-- 1) Cleanup previous sample rows (safe + specific)
-- =========================
-- delete app data first due to FKs


-- only remove cohorts/users we seed (by name/phone/email)
DELETE FROM cohorts WHERE name IN ('PaidCo Agent Cohort', 'PaidCo Manager Cohort', 'UnpaidCo Trial Cohort');

DELETE FROM users WHERE phone_number IN (
  '+15550000001', '+15550000002', '+15550000003', '+15550000004', '+15550000005'
);

-- demo requests

-- =========================
-- 2) Organizations (paid + unpaid)
-- =========================
-- NOTE: your organizations table does NOT include timezone/paid_until in the file you pasted.
-- Keep it aligned with your schema: (name, contact_email, is_paid, plan, stripe ids)
INSERT INTO organizations (name, contact_email, is_paid, plan, stripe_customer_id, stripe_subscription_id)
VALUES
  ('PaidCo',   'admin@paidco.com',   TRUE,  'gold',   NULL, NULL),
  ('UnpaidCo', 'admin@unpaidco.com', FALSE, 'bronze', NULL, NULL);

-- =========================
-- 3) Admin users (bcrypt hashes)
-- =========================
-- Passwords (example):
--   admin@paidco.com   => Paid123!
--   admin@unpaidco.com => Unpaid123!
--
-- IMPORTANT: If these hashes donÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢t match your bcrypt settings, generate them and replace.
INSERT INTO admin_users (email, password_hash, organization_id)
VALUES
(
  'admin@paidco.com',
  '$2b$10$GCTlhxuGKWkMOPYfXVeodOvUDtJBrE9ts8M27.tcWhpwntieXiyka',
  (SELECT id FROM organizations WHERE name='PaidCo')
),
(
  'admin@unpaidco.com',
  '$2b$10$e9gpImSbv863Xq0B72SdF.Y9jRdY7Q0Qv5.YEyQ2.DA6d88Rzo8b6',
  (SELECT id FROM organizations WHERE name='UnpaidCo')
)
ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  organization_id = EXCLUDED.organization_id;

-- =========================
-- 4) Learners (INTEGER schema) + attach organization_id
-- =========================
INSERT INTO users (name, phone_number, role_level, status, organization_id)
VALUES
  ('Ayesha Khan', '+15550000001', 'agent',   'active', (SELECT id FROM organizations WHERE name='PaidCo')),
  ('Ali Raza',    '+15550000002', 'agent',   'active', (SELECT id FROM organizations WHERE name='PaidCo')),
  ('Sara Malik',  '+15550000003', 'manager', 'active', (SELECT id FROM organizations WHERE name='PaidCo')),
  ('Usman Ahmed', '+15550000004', 'agent',   'active', (SELECT id FROM organizations WHERE name='UnpaidCo')),
  ('Hira Fatima', '+15550000005', 'agent',   'active', (SELECT id FROM organizations WHERE name='UnpaidCo'));

-- =========================
-- 5) Cohorts + attach organization_id
-- =========================
INSERT INTO cohorts (name, role_level, start_date, duration_days, organization_id)
VALUES
  ('PaidCo Agent Cohort',   'agent',   CURRENT_DATE - 15, 30, (SELECT id FROM organizations WHERE name='PaidCo')),
  ('PaidCo Manager Cohort', 'manager', CURRENT_DATE - 10, 21, (SELECT id FROM organizations WHERE name='PaidCo')),
  ('UnpaidCo Trial Cohort', 'agent',   CURRENT_DATE - 5,  14, (SELECT id FROM organizations WHERE name='UnpaidCo'));

-- =========================
-- 6) Enrollments (cohort_users)
-- =========================
INSERT INTO cohort_users (cohort_id, user_id)
SELECT c.id, u.id
FROM cohorts c
JOIN users u ON (
  (c.name = 'PaidCo Agent Cohort' AND u.phone_number IN ('+15550000001', '+15550000002'))
  OR
  (c.name = 'PaidCo Manager Cohort' AND u.phone_number IN ('+15550000003'))
  OR
  (c.name = 'UnpaidCo Trial Cohort' AND u.phone_number IN ('+15550000004', '+15550000005'))
)
ON CONFLICT DO NOTHING;

-- =========================
-- 7) Lessons (INTEGER schema)
-- =========================
-- your lessons table requires: lesson_text, action_text, reflection_question
INSERT INTO lessons (role_level, day_number, title, lesson_text, action_text, reflection_question)
VALUES
  ('agent', 1, 'Clear expectations',
    'Before delegating, make expectations explicit.',
    'Pick one task today and state success criteria clearly.',
    'Where could clarity have prevented rework today?'),
  ('agent', 2, 'Ask one great question',
    'Use one open question to unblock progress.',
    'Ask: ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œWhatÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢s the biggest blocker right now?ÃƒÂ¢Ã¢â€šÂ¬Ã¯Â¿Â½',
    'What did you learn by asking instead of telling?'),
  ('agent', 3, 'Confirm understanding',
    'Repeat back what you heard to confirm.',
    'Summarize the ask in your own words before you start.',
    'What changed when you confirmed understanding?'),
  ('manager', 1, 'Coach in the moment',
    'Give feedback closest to the behavior.',
    'Give one piece of feedback within 24 hours of a key moment.',
    'How did timing affect the outcome?'),
  ('manager', 2, 'Create accountability',
    'Agree on next steps and a check-in date.',
    'End one conversation with: ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œWhatÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢s next and by when?ÃƒÂ¢Ã¢â€šÂ¬Ã¯Â¿Â½',
    'Did clarity change follow-through?')
ON CONFLICT (role_level, day_number) DO NOTHING;

-- =========================
-- 8) Sent messages (INTEGER schema)
-- =========================
-- table: sent_messages(cohort_user_id INT, lesson_id INT, sent_at, message_sid)
WITH cu AS (
  SELECT
    cu.id AS cohort_user_id,
    c.role_level AS cohort_role
  FROM cohort_users cu
  JOIN cohorts c ON c.id = cu.cohort_id
),
ls AS (
  SELECT id AS lesson_id, role_level, day_number, title
  FROM lessons
  WHERE (role_level='agent' AND day_number IN (1,2,3))
     OR (role_level='manager' AND day_number IN (1,2))
)
INSERT INTO sent_messages (cohort_user_id, lesson_id, sent_at, message_sid)
SELECT
  cu.cohort_user_id,
  ls.lesson_id,
  NOW() - INTERVAL '3 days' + (ls.day_number || ' days')::INTERVAL,
  NULL
FROM cu
JOIN ls ON ls.role_level = cu.cohort_role
ON CONFLICT DO NOTHING;

-- =========================
-- 9) Reflections (INTEGER schema)
-- =========================
-- reflections: (cohort_user_id INT, lesson_id INT, response_text, received_at, quality_score, behavior_observed)
INSERT INTO reflections (cohort_user_id, lesson_id, response_text, received_at, quality_score, behavior_observed)
SELECT
  sm.cohort_user_id,
  sm.lesson_id,
  CASE WHEN random() < 0.5 THEN 'Tried this today and it helped.'
       ELSE 'Noticed where I usually skip this step.' END,
  sm.sent_at + INTERVAL '2 hours',
  (1 + floor(random()*3))::int,
  (random() < 0.4)
FROM sent_messages sm
WHERE random() < 0.7;

-- =========================
-- 10) Demo request sample
-- =========================
INSERT INTO demo_requests (name, email, company, message)
VALUES
  ('Paid Admin', 'demo@paidco.com', 'PaidCo', 'Please schedule a demo this week.');

COMMIT;
