-- 109: parse_pct_text helper for pulling pricing_components.uw_value into
-- the portfolio export. pricing_components stores the underwriter-chosen
-- loadings as free text ("5.5%", "0.055", "5.5") so the export needs
-- consistent numeric parsing. Pure SQL function so it's IMMUTABLE.

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
    RETURN n / 100;
  END IF;
  -- No "%" — heuristic: > 1.5 means it was typed as a percent ("5.5"
  -- meaning 5.5%), otherwise it was already a fraction ("0.055").
  RETURN CASE WHEN n > 1.5 THEN n / 100 ELSE n END;
END $$;

COMMENT ON FUNCTION public.parse_pct_text(text) IS
  'Parse a free-text percent value (e.g. "5.5%", "5.5", "0.055") into a numeric fraction in [0,1]. Used by the portfolio export to read pricing_components.uw_value.';
