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
  food_relation  TEXT NOT NULL DEFAULT 'after_meal',
    -- 'before_meal' | 'after_meal' | 'with_food' | 'any'
  route          TEXT NOT NULL DEFAULT 'po',
    -- 'po' | 'eye_drop' | 'ear_drop' | 'inhaler' | 'nasal' | 'topical' | 'sublingual' | 'injection'
  common_doses   TEXT[] DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_medref_trgm ON medications_reference
  USING gin (name_canonical gin_trgm_ops);

ALTER TABLE medications ADD COLUMN IF NOT EXISTS food_relation TEXT DEFAULT 'after_meal';
ALTER TABLE medications ADD COLUMN IF NOT EXISTS route TEXT DEFAULT 'po';
