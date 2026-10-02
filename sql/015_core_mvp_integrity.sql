BEGIN;

-- Keep the most recent response if historical retries created duplicate
-- reflections for the same learner/lesson pair.
DELETE FROM reflections older
USING reflections newer
WHERE older.cohort_user_id = newer.cohort_user_id
  AND older.lesson_id = newer.lesson_id
  AND (
    older.received_at < newer.received_at
    OR (older.received_at = newer.received_at AND older.id < newer.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS reflections_cohort_user_lesson_unique
  ON reflections(cohort_user_id, lesson_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cohorts_duration_positive'
  ) THEN
    ALTER TABLE cohorts
      ADD CONSTRAINT cohorts_duration_positive CHECK (duration_days > 0);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_cohort_membership_scope()
RETURNS TRIGGER AS $$
DECLARE
  learner_role TEXT;
  learner_org INTEGER;
  cohort_role TEXT;
  cohort_org INTEGER;
BEGIN
  SELECT role_level, organization_id INTO learner_role, learner_org
  FROM users WHERE id = NEW.user_id;

  SELECT role_level, organization_id INTO cohort_role, cohort_org
  FROM cohorts WHERE id = NEW.cohort_id;

  IF learner_org IS DISTINCT FROM cohort_org THEN
    RAISE EXCEPTION 'Learner and cohort must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;

  IF learner_role IS DISTINCT FROM cohort_role THEN
    RAISE EXCEPTION 'Learner role level must match cohort role level'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cohort_membership_scope_trigger ON cohort_users;
CREATE TRIGGER cohort_membership_scope_trigger
  BEFORE INSERT OR UPDATE OF cohort_id, user_id ON cohort_users
  FOR EACH ROW EXECUTE FUNCTION enforce_cohort_membership_scope();

COMMIT;
