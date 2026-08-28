-- 157: CHECK constraints on the free-text quote / offer workflow status
--       columns (audit F111).
--
-- contract.status / contract.uw_status are real enums (contract_status,
-- uw_workflow_status), but their quote twins and both offer tables were
-- plain text with no CHECK, so any typo'd state written by any code path was
-- accepted silently (the QA seed proved it, storing 'PENDING_APPROVAL' /
-- 'OFFERED' / 'BOUND' — states no reader recognises).
--
-- Value sets were read from the actual writers before constraining:
--   * quote.status — services/quoteWorkflow.js + services/approvals.js write
--     DRAFT / AWAITING_APPROVAL / AWAITING_SIGNED_LINE / NTU / DECLINED;
--     routes/quoteLifecycle.js writes SUPERSEDED (amend path); transitions
--     are guarded by lib/statusMachine.js whose canonical set adds APPROVED
--     and SIGNED (quote mark-signed is currently a 410 but the state is
--     legal in the machine and bind, services/quoteBind.js:240, requires
--     it). Live DISTINCT: {DRAFT}.
--   * quote.uw_status — no JS writer (default 'DRAFT'); constrained to the
--     uw_workflow_status enum's own labels so the twin columns stay
--     interchangeable (including the legacy 'WAITING_APPROVAL' spelling that
--     the enum still carries after 103). Live DISTINCT: {DRAFT}.
--   * contract_offer.status — column default 'PENDING'; writers
--     (services/approvals.js, modules/pricing/pricingOfferRepository.js,
--     routes/aiCedant.js) produce PENDING / AWAITING_APPROVAL /
--     AWAITING_SIGNED_LINE / DISPUTE_PENDING / RETURNED / SIGNED / NTU /
--     DECLINED. Live DISTINCT: {AWAITING_APPROVAL, AWAITING_SIGNED_LINE}.
--   * quote_offer.status — services/approvals.js + quoteWorkflow.js produce
--     AWAITING_APPROVAL / AWAITING_SIGNED_LINE / RETURNED / RECALLED /
--     SIGNED / NTU / DECLINED. Live DISTINCT: {} (empty table).
--
-- Legacy value normalisation first: QA databases seeded by the old
-- seed_1000_test_contracts wrote vocabularies no reader recognises. They are
-- mapped to their semantic equivalents (PENDING_APPROVAL -> the state the
-- approval queue reads; OFFERED / APPROVED -> the offered state; quote BOUND
-- -> the state bind requires) rather than widening the constraint with dead
-- values. All UPDATEs are no-ops on this DB (verified by DISTINCT queries).

-- ── normalise legacy values ─────────────────────────────────────────────────
UPDATE public.contract_offer SET status = 'AWAITING_APPROVAL'    WHERE status = 'PENDING_APPROVAL';

UPDATE public.contract_offer SET status = 'AWAITING_SIGNED_LINE' WHERE status IN ('OFFERED', 'APPROVED');

UPDATE public.quote SET status = 'SIGNED' WHERE status = 'BOUND';

UPDATE public.quote SET uw_status = 'SIGNED' WHERE uw_status = 'BOUND';

-- ── quote.status ────────────────────────────────────────────────────────────
ALTER TABLE public.quote
  ADD CONSTRAINT quote_status_check
  CHECK (status IN (
    'DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_SIGNED_LINE',
    'SIGNED', 'NTU', 'DECLINED', 'SUPERSEDED'
  ));

-- ── quote.uw_status ─────────────────────────────────────────────────────────
-- Mirrors the uw_workflow_status enum labels exactly (WAITING_APPROVAL is
-- the pre-103 legacy spelling the enum still carries; kept so a quote row
-- restored from an old backup remains storable, matching the contract twin).
ALTER TABLE public.quote
  ADD CONSTRAINT quote_uw_status_check
  CHECK (uw_status IN (
    'DRAFT', 'WAITING_APPROVAL', 'AWAITING_APPROVAL', 'APPROVED',
    'AWAITING_SIGNED_LINE', 'SIGNED', 'NTU', 'DECLINED',
    'DISPUTE_PENDING', 'RETURNED'
  ));

-- ── contract_offer.status ───────────────────────────────────────────────────
ALTER TABLE public.contract_offer
  ADD CONSTRAINT contract_offer_status_check
  CHECK (status IN (
    'PENDING', 'AWAITING_APPROVAL', 'AWAITING_SIGNED_LINE', 'DISPUTE_PENDING',
    'RETURNED', 'SIGNED', 'NTU', 'DECLINED'
  ));

-- ── quote_offer.status ──────────────────────────────────────────────────────
ALTER TABLE public.quote_offer
  ADD CONSTRAINT quote_offer_status_check
  CHECK (status IN (
    'AWAITING_APPROVAL', 'AWAITING_SIGNED_LINE', 'RETURNED', 'RECALLED',
    'SIGNED', 'NTU', 'DECLINED'
  ));
