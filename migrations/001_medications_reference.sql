-- 001_medications_reference.sql
-- Medications reference table + per-med food_relation / route.
-- Lets the bot auto-look up how each drug is taken (oral, eye drop, ...) and its
-- meal relation at save time, so onboarding never asks "before/after meal" and
-- reminders use the correct verb. Idempotent — also applied at boot in index.js.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS medications_reference (
  id             SERIAL PRIMARY KEY,
  name_canonical TEXT NOT NULL UNIQUE,
  name_aliases   TEXT[] DEFAULT '{}',
  food_relation  TEXT,   -- before_meal | after_meal | with_food | any | NULL(unknown)
  route          TEXT,   -- po | eye_drop | ear_drop | inhaler | nasal | topical | sublingual | injection | NULL(unknown)
  common_doses   TEXT[] DEFAULT '{}',
  source         TEXT DEFAULT 'curated',   -- 'curated' (clinician seed) | 'llm' (auto-cached, review)
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_medref_trgm ON medications_reference
  USING gin (name_canonical gin_trgm_ops);

-- For an existing table created by an earlier version of this migration where
-- food_relation/route were NOT NULL: relax them so LLM rows can store blanks.
ALTER TABLE medications_reference ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'curated';
ALTER TABLE medications_reference ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE medications_reference ALTER COLUMN food_relation DROP NOT NULL;
ALTER TABLE medications_reference ALTER COLUMN route DROP NOT NULL;

ALTER TABLE medications ADD COLUMN IF NOT EXISTS food_relation TEXT DEFAULT 'after_meal';
ALTER TABLE medications ADD COLUMN IF NOT EXISTS route TEXT DEFAULT 'po';

-- Review auto-cached LLM verdicts:  SELECT * FROM medications_reference WHERE source='llm';
