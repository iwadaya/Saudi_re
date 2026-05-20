-- 107: Allow tail_type='CUSTOM' on contract_straight_experience.
--
-- The Straight Stats screen no longer ships with the SHORT_TAIL /
-- LONG_TAIL toggle. The underwriter now picks LDFs via the LDF Analysis
-- modal (per-class blend, persisted in contract_ldf_blend*), and the
-- screen just records tail_type='CUSTOM' to signal "look up the saved
-- blend rather than a hard-coded curve".
--
-- ref_benchmark_ldf.tail_type is intentionally NOT widened — that table
-- is reference data keyed on the legacy SHORT_TAIL / LONG_TAIL labels
-- and is on its way out; nothing writes 'CUSTOM' to it.

ALTER TABLE public.contract_straight_experience
  DROP CONSTRAINT IF EXISTS contract_straight_experience_tail_type_check;

ALTER TABLE public.contract_straight_experience
  ADD CONSTRAINT contract_straight_experience_tail_type_check
  CHECK (tail_type IN ('SHORT_TAIL', 'LONG_TAIL', 'CUSTOM'));
