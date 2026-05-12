-- Seed 001: UW Roles (requires migration 001 to have created uw_role table)
-- Safe to skip if you haven't run migration 001 yet.

BEGIN;

INSERT INTO public.uw_role (role_name, authority_limit_usd, display_order)
VALUES
  ('UNDERWRITER',        10000000, 10),
  ('UW_MANAGER',         12000000, 20),
  ('CHIEF_UNDERWRITER',      NULL, 30)
ON CONFLICT (role_name) DO UPDATE SET
  authority_limit_usd = EXCLUDED.authority_limit_usd,
  display_order = EXCLUDED.display_order;

COMMIT;
