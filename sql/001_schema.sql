BEGIN;

-- USERS (learners)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL UNIQUE,
  role_level TEXT NOT NULL CHECK (role_level IN ('agent', 'lead', 'supervisor', 'manager', 'executive')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- COHORTS (group of learners in a program instance)
CREATE TABLE IF NOT EXISTS cohorts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role_level TEXT NOT NULL CHECK (role_level IN ('agent', 'lead', 'supervisor', 'manager', 'executive')),
  start_date DATE NOT NULL,
  duration_days INT NOT NULL DEFAULT 30,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- COHORT MEMBERSHIP
CREATE TABLE IF NOT EXISTS cohort_users (
  id SERIAL PRIMARY KEY,
  cohort_id INT NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (cohort_id, user_id)
);

-- LESSONS (for each level)
CREATE TABLE IF NOT EXISTS lessons (
  id SERIAL PRIMARY KEY,
  role_level TEXT NOT NULL CHECK (role_level IN ('agent', 'lead', 'supervisor', 'manager', 'executive')),
  day_number INT NOT NULL CHECK (day_number >= 1),
  title TEXT NOT NULL,
  lesson_text TEXT NOT NULL,          -- short SMS â€œlessonâ€�
  action_text TEXT NOT NULL,          -- what to do today
  reflection_question TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (role_level, day_number)
);

-- SENT MESSAGES (tracking what was sent to whom)
CREATE TABLE IF NOT EXISTS sent_messages (
  id SERIAL PRIMARY KEY,
  cohort_user_id INT NOT NULL REFERENCES cohort_users(id) ON DELETE CASCADE,
  lesson_id INT NOT NULL REFERENCES lessons(id),
  sent_at TIMESTAMP NOT NULL DEFAULT NOW(),
  message_sid TEXT,  -- Twilio SID (null for mock)
  UNIQUE (cohort_user_id, lesson_id)
);

-- REFLECTIONS (incoming replies)
CREATE TABLE IF NOT EXISTS reflections (
  id SERIAL PRIMARY KEY,
  cohort_user_id INT NOT NULL REFERENCES cohort_users(id) ON DELETE CASCADE,
  lesson_id INT NOT NULL REFERENCES lessons(id),
  response_text TEXT NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT NOW(),
  quality_score INT CHECK (quality_score IN (1, 2, 3) OR quality_score IS NULL),
  behavior_observed BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_reflections_quality_score ON reflections(quality_score);
CREATE INDEX IF NOT EXISTS idx_reflections_behavior_observed ON reflections(behavior_observed);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_sent_messages_cohort_user_sent_at
  ON sent_messages (cohort_user_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_reflections_cohort_user_received_at
  ON reflections (cohort_user_id, received_at DESC);

COMMIT;
