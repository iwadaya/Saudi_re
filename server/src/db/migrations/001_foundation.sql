-- Migration 001: Foundation — audit log, user/role tables, approval workflow, indexes
-- SAFE TO SKIP if loading from outputfile.sql (which already has the base schema).
-- These tables are ADDITIVE — they create things NOT present in the base schema dump.

BEGIN;

-- 1. AUDIT LOG (supplements contract_audit_event which already exists)
CREATE TABLE IF NOT EXISTS public.audit_log (
  event_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  event_type   text NOT NULL,
  actor        text NOT NULL DEFAULT 'SYSTEM',
  payload      jsonb,
  comment      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON public.audit_log (entity_type, entity_id, created_at DESC);

-- 2. USER & ROLE MANAGEMENT
CREATE TABLE IF NOT EXISTS public.uw_role (
  role_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_name           text NOT NULL UNIQUE,
  authority_limit_usd numeric(18,2),
  display_order       integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.uw_role_class_restriction (
  role_id              uuid NOT NULL REFERENCES public.uw_role(role_id) ON DELETE CASCADE,
  class_of_business_id uuid NOT NULL REFERENCES public.class_of_business(class_of_business_id),
  PRIMARY KEY (role_id, class_of_business_id)
);

CREATE TABLE IF NOT EXISTS public.uw_user (
  user_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role_id      uuid NOT NULL REFERENCES public.uw_role(role_id),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 3. APPROVAL WORKFLOW
CREATE TABLE IF NOT EXISTS public.approval_request (
  request_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  submitted_by uuid NOT NULL REFERENCES public.uw_user(user_id),
  limit_usd    numeric(18,2),
  status       text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','DECLINED','RETURNED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE TABLE IF NOT EXISTS public.approval_decision (
  decision_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES public.approval_request(request_id) ON DELETE CASCADE,
  decided_by      uuid NOT NULL REFERENCES public.uw_user(user_id),
  decided_by_role uuid REFERENCES public.uw_role(role_id),
  decision        text NOT NULL CHECK (decision IN ('APPROVED','DECLINED','RETURNED')),
  comment         text,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_decision_unique UNIQUE (request_id, decided_by)
);

COMMIT;
