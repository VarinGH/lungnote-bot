-- 003_schedule_slot_words.sql
-- Convert legacy meal-anchor time strings in medications.schedule to slot words.
--
-- Historically '08:00'/'12:00'/'18:00'/'21:00' were SYMBOLIC slot names, fired
-- at the patient's personal meal times (patients.meal_morning etc.) — so the
-- string '08:00' did NOT mean 8:00 AM. That collided with literal times: a user
-- who said "8am" got their reminder at their personal morning meal time instead.
-- Schedules now store the words 'morning'/'midday'/'evening'/'bedtime' for meal
-- slots, and "HH:MM" strings ONLY for literal clock times. ('14:00' and '22:00'
-- were already literal-time entries and are unchanged.)
--
-- ⚠ ONE-TIME migration — unlike 001/002 this is NOT idempotent in effect:
-- after conversion, a literal '08:00' in a schedule is a real clock time
-- ("8am") and re-running would wrongly turn it into 'morning'. index.js applies
-- it at boot guarded by a marker row in applied_migrations; if running this
-- file by hand, apply the same guard (the whole file is one transaction).

BEGIN;

CREATE TABLE IF NOT EXISTS applied_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM applied_migrations WHERE name = '003_schedule_slot_words') THEN
    RAISE NOTICE '003_schedule_slot_words already applied — skipping';
  ELSE
    INSERT INTO applied_migrations (name) VALUES ('003_schedule_slot_words');
    UPDATE medications SET schedule =
      array_replace(array_replace(array_replace(array_replace(schedule,
        '08:00','morning'), '12:00','midday'), '18:00','evening'), '21:00','bedtime')
    WHERE schedule && ARRAY['08:00','12:00','18:00','21:00'];
  END IF;
END $$;

COMMIT;
