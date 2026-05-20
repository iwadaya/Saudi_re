-- 106: Persisted LDF blend per (contract, triangle_type).
--
-- After the underwriter sets weights in the blend modal we persist the
-- chosen weights plus the resulting blended curve so the pricing engine
-- reads a deterministic curve later. Re-saving replaces the prior blend
-- (DELETE+INSERT on the child rows, UPDATE the header) — see
-- services/ldf/blending.js → saveContractLdfBlend.
--
-- One blend per (contract_id, triangle_type). Deleting the contract
-- cascades to the blend; deleting the blend cascades to its weight and
-- curve rows.

CREATE TABLE IF NOT EXISTS public.contract_ldf_blend (
    blend_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id uuid NOT NULL,
    triangle_type public.triangle_type NOT NULL,
    overridden boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_ldf_blend_contract_fk
      FOREIGN KEY (contract_id) REFERENCES public.contract(contract_id) ON DELETE CASCADE,
    CONSTRAINT contract_ldf_blend_unique UNIQUE (contract_id, triangle_type)
);

CREATE INDEX IF NOT EXISTS contract_ldf_blend_contract_idx
    ON public.contract_ldf_blend (contract_id);

CREATE TABLE IF NOT EXISTS public.contract_ldf_blend_weight (
    blend_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL,
    weight numeric NOT NULL,
    benchmark_scope text,
    n_contracts integer,
    PRIMARY KEY (blend_id, class_of_business_id),
    CONSTRAINT contract_ldf_blend_weight_blend_fk
      FOREIGN KEY (blend_id) REFERENCES public.contract_ldf_blend(blend_id) ON DELETE CASCADE,
    CONSTRAINT contract_ldf_blend_weight_cob_fk
      FOREIGN KEY (class_of_business_id) REFERENCES public.class_of_business(class_of_business_id) ON DELETE RESTRICT,
    CONSTRAINT contract_ldf_blend_weight_scope_check
      CHECK (benchmark_scope IS NULL OR benchmark_scope IN ('COUNTRY','REGION','GLOBAL','NONE'))
);

CREATE TABLE IF NOT EXISTS public.contract_ldf_blend_curve (
    blend_id uuid NOT NULL,
    dev_month integer NOT NULL,
    weighted_ldf numeric NOT NULL,
    weighted_cdf numeric,
    PRIMARY KEY (blend_id, dev_month),
    CONSTRAINT contract_ldf_blend_curve_blend_fk
      FOREIGN KEY (blend_id) REFERENCES public.contract_ldf_blend(blend_id) ON DELETE CASCADE
);
