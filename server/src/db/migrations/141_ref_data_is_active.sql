-- 141: is_active soft-delete flag on shared reference tables.
--
-- lookups.js list endpoints now hide is_active=false rows; integration-test
-- fixtures create their reference rows inactive so a suite run against a
-- shared database never pollutes production-visible dropdowns (audit F8).
-- Rows stay valid FK targets — nothing in the app joins these tables on
-- is_active, only the list endpoints filter.
ALTER TABLE public.country           ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.currency          ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.brokers           ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.companies         ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.class_of_business ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.treaty_type       ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true; -- normally present via 027

-- One-time backfill: hide rows already leaked by past test runs. Fixture names
-- always embed a 13-digit Date.now() epoch, so these patterns cannot match
-- real reference data.
UPDATE public.country SET is_active=false
 WHERE country_name ~ '^(IT|ACC|Renew|Ren|Q|T|QP|PX|Persist) Country \d{13}'
    OR country_name ~ '^(DO|FD) (EU|ME) \d{13}';
UPDATE public.currency SET is_active=false
 WHERE currency_name ~ '^(IT|Renew|Ren|Q|T|QP|Persist) Currency \d{13}'
    OR currency_name ~ '^(PX|DO|FD) Ccy \d{13}';
UPDATE public.brokers SET is_active=false
 WHERE broker_name ~ '^(IT|ACC|Renew|Ren|Q|T|QP|PX|DO|Persist) Broker \d{13}';
UPDATE public.companies SET is_active=false
 WHERE company_name ~ '^(IT|ACC|Renew|Ren|Q|T|QP|PX|DO|FD|Persist) Cedant \d{13}';
UPDATE public.treaty_type SET is_active=false
 WHERE treaty_type ~ '^(IT|Renew|Ren|Q|T|QP) TType \d{13}'
    OR treaty_type ~ '^ACC QS \d{13}'
    OR treaty_type ~ '^PX (Prop|NP) \d{13}'
    OR treaty_type ~ '^DO (QS|XL) \d{13}'
    OR treaty_type ~ '^Persist Treaty Type \d{13}';
UPDATE public.class_of_business SET is_active=false
 WHERE class_of_business ~ '^ACC Property \d{13}'
    OR class_of_business ~ '^QP Motor \d{13}'
    OR class_of_business ~ '^PX COB (Normal|Restricted) \d{13}'
    OR class_of_business ~ '^DO (Property|Engineering|Marine) \d{13}'
    OR class_of_business ~ '^Persist (Property|Marine) \d{13}'
    OR class_of_business ~ '^(Bind|QDV) COB \d{13}';
-- example.test is a reserved test TLD — these are integration-test users.
UPDATE public.uw_user SET is_active=false WHERE email LIKE '%@example.test';
