-- 139_fac_reference_governance.sql
-- Facultative Phase 5: how rates get loaded without anybody inventing them.
--
-- Every rate table in this module ships EMPTY, on purpose (design doc §8). That
-- discipline has a cost the design named and did not pay: somebody has to be
-- able to put real numbers in, and until now the only route was a hand-written
-- INSERT by whoever had production credentials. That is the worst of both
-- worlds — the tables are empty because a rate needs an owner, and then the
-- loading path has no record of who owned it.
--
-- This is that path. A rate revision is a VERSION with a lifecycle:
--
--   DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──publish──▶ live
--     ▲                      │
--     └───────reject─────────┘
--
-- Rows are STAGED against a draft and applied to the live tables only on
-- publish, in one transaction. Nothing edits a live rate table in place.
--
-- The control is four eyes: the approver must not be the submitter. It is
-- enforced in the service and again by a CHECK here, because a control that
-- lives only in application code is a control that survives exactly as long as
-- the next refactor.

-- ── The version lifecycle ────────────────────────────────────────────────

ALTER TABLE public.fac_rate_table_version
  ADD COLUMN IF NOT EXISTS status        text NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN IF NOT EXISTS created_by    uuid REFERENCES public.uw_user(user_id),
  ADD COLUMN IF NOT EXISTS submitted_by  uuid REFERENCES public.uw_user(user_id),
  ADD COLUMN IF NOT EXISTS submitted_at  timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by   uuid REFERENCES public.uw_user(user_id),
  ADD COLUMN IF NOT EXISTS approved_at   timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by   uuid REFERENCES public.uw_user(user_id),
  ADD COLUMN IF NOT EXISTS rejected_at   timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS published_at  timestamptz,
  -- Who owns these numbers. The design's open question (§7.2) does not have a
  -- single answer for every table, so it is recorded per revision instead of
  -- assumed once.
  ADD COLUMN IF NOT EXISTS owner_note    text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fac_rate_version_status') THEN
    ALTER TABLE public.fac_rate_table_version
      ADD CONSTRAINT fac_rate_version_status
      CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUPERSEDED'));
  END IF;

  -- Four eyes, in the schema. An approval by the submitter is not an approval.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fac_rate_version_four_eyes') THEN
    ALTER TABLE public.fac_rate_table_version
      ADD CONSTRAINT fac_rate_version_four_eyes
      CHECK (approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by);
  END IF;
END $$;

-- The seeded FAC-REF-2026.1 predates the lifecycle and is in force, so it is
-- APPROVED by default (above). It carries no approver, which is true and
-- visible rather than backfilled with a name nobody chose.
COMMENT ON COLUMN public.fac_rate_table_version.approved_by IS
  'NULL on versions that predate the approval lifecycle — absent, not assumed.';

-- The pre-lifecycle schema enforced "only one open-ended version" with a
-- partial unique index on (effective_to IS NULL). That was right when the only
-- versions were live ones. It is wrong now: a DRAFT and a PENDING_APPROVAL
-- revision also have no end date, and every one of them would collide with the
-- version currently in force.
--
-- The invariant that actually matters is narrower — only one version is IN
-- FORCE — so the index moves to published, open-ended rows. Publishing a new
-- revision supersedes the previous one (see publishVersion), which is what
-- keeps it satisfied.
DROP INDEX IF EXISTS public.uq_fac_rate_table_version_current;

-- Versions that predate this migration are in force and have no published_at,
-- because the column did not exist when they were created. Backfill from
-- created_at rather than leaving them outside the new index.
UPDATE public.fac_rate_table_version
   SET published_at = COALESCE(published_at, created_at, now())
 WHERE effective_to IS NULL AND status = 'APPROVED' AND published_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fac_rate_table_version_in_force
  ON public.fac_rate_table_version ((effective_to IS NULL))
  WHERE effective_to IS NULL AND published_at IS NOT NULL;

-- ── Staged rows ──────────────────────────────────────────────────────────

-- One row per pending change to a live reference table. `target_table` is
-- checked against an allow-list in the service before any SQL is built from
-- it; the CHECK here is the second lock on the same door.
CREATE TABLE IF NOT EXISTS public.fac_rate_stage (
  stage_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id   uuid NOT NULL
                 REFERENCES public.fac_rate_table_version(version_id) ON DELETE CASCADE,
  target_table text NOT NULL,
  operation    text NOT NULL DEFAULT 'INSERT',
  -- For UPDATE and DELETE: how to find the row. For INSERT: null.
  row_key      jsonb,
  -- The column values, already validated against the target's own columns.
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  note         text,
  created_by   uuid REFERENCES public.uw_user(user_id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  applied_at   timestamptz,

  CONSTRAINT fac_rate_stage_operation CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  CONSTRAINT fac_rate_stage_target CHECK (target_table IN (
    'fac_exposure_curve', 'fac_exposure_curve_point', 'fac_curve_band',
    'fac_ilf_curve', 'fac_ilf_point',
    'fac_liability_base_rate', 'fac_transit_base_rate',
    'fac_hull_base_rate', 'fac_hull_factor', 'fac_war_rate',
    'fac_project_base_rate', 'fac_project_factor', 'fac_project_load_rate',
    'fac_plant_base_rate', 'fac_plant_factor',
    'fac_energy_base_rate', 'fac_energy_sublimit_rate',
    'fac_cyber_base_rate', 'fac_cyber_control_factor',
    'fac_motor_base_rate', 'fac_pa_base_rate',
    'fac_zone_budget'
  ))
);

CREATE INDEX IF NOT EXISTS idx_fac_rate_stage_version
  ON public.fac_rate_stage (version_id, target_table);

-- ── The audit trail ──────────────────────────────────────────────────────

-- Who did what to a rate revision, in order. Separate from the version row
-- because the row holds the current state and this holds how it got there —
-- including the rejections, which the row would otherwise overwrite.
CREATE TABLE IF NOT EXISTS public.fac_rate_version_event (
  event_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL
               REFERENCES public.fac_rate_table_version(version_id) ON DELETE CASCADE,
  event_type text NOT NULL,   -- CREATED | STAGED | SUBMITTED | APPROVED | REJECTED | PUBLISHED
  actor_id   uuid REFERENCES public.uw_user(user_id),
  actor_label text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fac_rate_version_event_version
  ON public.fac_rate_version_event (version_id, created_at);
