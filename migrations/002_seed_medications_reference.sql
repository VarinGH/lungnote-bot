-- 002_seed_medications_reference.sql
-- Seed for common Thai HTN / DM / lipid meds plus a few non-oral examples
-- (eye drops, inhaler) to exercise route handling.
-- ON CONFLICT DO NOTHING keeps any clinician-edited rows intact across re-runs.
--
-- ⚠️ Varin (MD): confirm each food_relation and route clinically before relying
--    on it in production. Extend toward ~30 meds as needed.

INSERT INTO medications_reference (name_canonical, name_aliases, food_relation, route, common_doses) VALUES
  ('Amlodipine',          ARRAY['norvasc','แอมโลดิปีน'],            'any',         'po',       ARRAY['2.5mg','5mg','10mg']),
  ('Enalapril',           ARRAY['renitec','อีนาลาพริล'],            'any',         'po',       ARRAY['5mg','10mg','20mg']),
  ('Losartan',            ARRAY['cozaar','โลซาร์แทน'],              'any',         'po',       ARRAY['50mg','100mg']),
  ('Atenolol',            ARRAY['tenormin','อะทีโนลอล'],            'any',         'po',       ARRAY['25mg','50mg','100mg']),
  ('Hydrochlorothiazide', ARRAY['hctz','ไฮโดรคลอโรไทอาไซด์'],       'any',         'po',       ARRAY['25mg','50mg']),
  ('Furosemide',          ARRAY['lasix','ฟูโรซีไมด์'],              'any',         'po',       ARRAY['20mg','40mg']),
  ('Metformin',           ARRAY['glucophage','เมทฟอร์มิน'],         'with_food',   'po',       ARRAY['500mg','850mg','1000mg']),
  ('Glipizide',           ARRAY['minidiab','กลิพิไซด์'],            'before_meal', 'po',       ARRAY['5mg','10mg']),
  ('Glibenclamide',       ARRAY['glyburide','daonil','ไกลเบนคลาไมด์'],'before_meal','po',      ARRAY['5mg']),
  ('Sitagliptin',         ARRAY['januvia','ซิทากลิปติน'],           'any',         'po',       ARRAY['50mg','100mg']),
  ('Atorvastatin',        ARRAY['lipitor','อะทอร์วาสแตติน'],        'any',         'po',       ARRAY['10mg','20mg','40mg']),
  ('Simvastatin',         ARRAY['zocor','ซิมวาสแตติน'],             'any',         'po',       ARRAY['10mg','20mg','40mg']),
  ('Aspirin',             ARRAY['asa','aspent','แอสไพริน'],         'after_meal',  'po',       ARRAY['81mg','100mg']),
  ('Omeprazole',          ARRAY['losec','โอเมพราโซล'],              'before_meal', 'po',       ARRAY['20mg','40mg']),
  ('Prednisolone',        ARRAY['เพรดนิโซโลน'],                     'after_meal',  'po',       ARRAY['5mg']),
  ('Warfarin',            ARRAY['orfarin','วาร์ฟาริน'],             'any',         'po',       ARRAY['2mg','3mg','5mg']),
  -- non-oral examples (route demonstration)
  ('Timolol eye drops',     ARRAY['timoptol','ทิโมลอล'],           'any',         'eye_drop', ARRAY['0.25%','0.5%']),
  ('Latanoprost eye drops', ARRAY['xalatan','ลาทานோพรอสต์'],       'any',         'eye_drop', ARRAY['0.005%']),
  ('Artificial tears',      ARRAY['น้ำตาเทียม','systane'],          'any',         'eye_drop', ARRAY[]::TEXT[]),
  ('Salbutamol inhaler',    ARRAY['ventolin','ซัลบูทามอล','ยาพ่น'], 'any',         'inhaler',  ARRAY[]::TEXT[])
ON CONFLICT (name_canonical) DO NOTHING;
