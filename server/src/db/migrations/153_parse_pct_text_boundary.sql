-- 153: Fix parse_pct_text's percent-vs-fraction boundary (audit F84).
--
-- 109's heuristic was `CASE WHEN n > 1.5 THEN n/100 ELSE n END`, which left
-- bare values in (1, 1.5] unchanged: '1.2' (an entry meaning 1.2%) came back
-- as 1.2 = 120%, violating the function's own documented contract of "a
-- numeric fraction in [0,1]" — a fraction can never exceed 1, so ANY bare
-- value > 1 must have been typed as a percent. Consumers (routes/home.js
-- portfolio export: attritional/large/cat loads, commission, brokerage, tax
-- from pricing_components.uw_value/actuarial_value) silently inflated small
-- whole-percent entries such as taxes ~1.25% by 100x.
--
-- New boundary:
--   * explicit '%' suffix        -> n / 100 (unchanged)
--   * bare n > 1                 -> n / 100 (typed as percent; was n > 1.5)
--   * bare n in [0, 1]           -> n       (already a fraction; '0.9' still
--                                            reads as 90% — ambiguous but
--                                            unchanged from 109's behaviour)
--   * result outside [0,1]       -> NULL    (out-of-contract values — a bare
--                                            or explicit percent above 100%,
--                                            or a negative — are flagged by
--                                            NULL rather than exported as a
--                                            fabricated ratio)
--
-- Blast radius: no views, generated columns, indexes or other DB objects
-- depend on parse_pct_text (pg_depend shows zero dependents); the only
-- callers are the two query-time usages in routes/home.js, so replacing the
-- function corrects every future export with no stored data to repair.

CREATE OR REPLACE FUNCTION public.parse_pct_text(v text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  cleaned text;
  n numeric;
BEGIN
  IF v IS NULL OR trim(v) = '' THEN RETURN NULL; END IF;
  cleaned := regexp_replace(v, '[^0-9.\-]', '', 'g');
  IF cleaned = '' OR cleaned = '-' OR cleaned = '.' THEN RETURN NULL; END IF;
  BEGIN
    n := cleaned::numeric;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  -- Explicit "%" suffix → always divide by 100
  IF strpos(v, '%') > 0 THEN
    n := n / 100;
  ELSIF n > 1 THEN
    -- No "%": a fraction cannot exceed 1, so any bare value > 1 was typed
    -- as a percent ("5.5" meaning 5.5%, "1.2" meaning 1.2%).
    n := n / 100;
  END IF;
  -- Contract: a fraction in [0,1]. Anything still outside after
  -- normalisation is unusable — return NULL instead of a wrong number.
  IF n < 0 OR n > 1 THEN RETURN NULL; END IF;
  RETURN n;
END $$;

COMMENT ON FUNCTION public.parse_pct_text(text) IS
  'Parse a free-text percent value (e.g. "5.5%", "5.5", "1.2", "0.055") into a numeric fraction in [0,1]. Bare values > 1 are read as percent points; results outside [0,1] return NULL. Used by the portfolio export to read pricing_components.uw_value.';
