-- 049_rename_treaty_underwriter.sql
-- Rename 'Treaty Underwriter' → 'Underwriter' in uw_user and uw_role tables

UPDATE public.uw_user
SET display_name = 'Underwriter'
WHERE display_name = 'Treaty Underwriter';

UPDATE public.uw_role
SET role_name = 'Underwriter'
WHERE role_code = 'TUW'
  AND role_name = 'Treaty Underwriter';
