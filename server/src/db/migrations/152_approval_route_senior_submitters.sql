-- Migration 152: approval-route legs for TM / TD / RM submitters (+ legacy TUW)
-- Fully idempotent — safe to run multiple times on any DB state.
--
-- Audit F80: the migration-118 approval_route seed covered only the six-title
-- model (AN/UW/UM/CU/CA/CE), so a within-mandate submission by a Treaty
-- Manager (TM), Treaty Director (TD) or Retro Manager (RM) — titles seeded by
-- migrations 034/143 — produced an EMPTY approver-options set that nobody
-- could ever approve, return or sign.
--
-- Policy (defaults chosen here, mirrored by DEFAULT_APPROVAL_ROUTE in
-- services/approvals.js): each submitter routes to the titles STRICTLY SENIOR
-- to it in the public.uw_role hierarchy (lower hierarchy_level = more senior):
--   TM  (level 4) → TD, CU, CE   (levels 3 / 2 / 1)
--   TD  (level 3) → CU, CE       (levels 2 / 1)
--   RM  (level 3) → CU, CE       (levels 2 / 1)
--   TUW           → CU           (legacy pre-migration-049 alias of the junior
--                                 Underwriter persona — routed exactly like UW)
-- UM (also level 3) keeps its original 118 seed of {CU} untouched. CA is not
-- added to these legs: the Chief Actuary participates as an approver only where
-- the 118 seed already names it (the CU originator leg).

INSERT INTO public.approval_route (originator_role_code, leg, approver_role_codes, min_approvals, note)
VALUES
  ('TM',  1, ARRAY['TD','CU','CE']::text[], 1, 'Treaty Manager routes to strictly-senior underwriting titles'),
  ('TD',  1, ARRAY['CU','CE']::text[],      1, 'Treaty Director routes to Chief Underwriter / Chief Executive'),
  ('RM',  1, ARRAY['CU','CE']::text[],      1, 'Retro Manager routes to Chief Underwriter / Chief Executive'),
  ('TUW', 1, ARRAY['CU']::text[],           1, 'Legacy Treaty Underwriter alias — same route as UW')
ON CONFLICT (originator_role_code, leg) DO UPDATE SET
  approver_role_codes = EXCLUDED.approver_role_codes,
  min_approvals       = EXCLUDED.min_approvals,
  note                = EXCLUDED.note,
  updated_at          = now();
