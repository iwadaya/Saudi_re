-- 142: is_active soft-delete flag on the facultative class-of-business table —
-- the fac counterpart of 141. /fac/lookups/classes hides is_active=false rows;
-- integration-test fixtures create theirs inactive (audit F8).
ALTER TABLE public.fac_class_of_business ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;

-- Backfill: hide rows already leaked by past test runs. Fixture names embed a
-- 13-digit Date.now() epoch, so these patterns cannot match real data.
UPDATE public.fac_class_of_business SET is_active=false
 WHERE class_name ~ '^FD (Property|Engineering|Marine) \d{13}'
    OR class_name ~ '^ACC (IAR|PAR|Cyber) \d{13}';
