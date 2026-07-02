import { pool } from '../../../db/pool.js';
import { numOrNull } from '../../../helpers.js';

export { numOrNull };
// Single source of truth for the BEGIN/COMMIT/ROLLBACK wrapper — this used to
// be a byte-for-byte duplicate of db/withTransaction.js. Re-export so both call
// sites stay in lockstep.
export { withTransaction } from '../../../db/withTransaction.js';

async function loadPricingSchemaFlags() {
  const { rows: outputColumns } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_pricing_outputs'`
  );
  const outputSet = new Set(outputColumns.map((row) => row.column_name));

  const { rows: componentColumns } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='pricing_components'`
  );
  const componentSet = new Set(componentColumns.map((row) => row.column_name));

  return {
    hasOfferCols: outputSet.has('uw_comment'),
    hasExposure: componentSet.has('exposure_value'),
    componentColumns: componentSet,
  };
}

// The DB schema is fixed once migrations have run at startup, so the optional-
// column probes never change within a process. Memoize the lookup (the in-flight
// promise, to dedupe concurrent first-callers) so it isn't two information_schema
// queries on every pricing save's critical path. Mirrors getCobCols caching.
let _pricingSchemaFlagsPromise = null;

export function getPricingSchemaFlags() {
  if (!_pricingSchemaFlagsPromise) {
    _pricingSchemaFlagsPromise = loadPricingSchemaFlags().catch((error) => {
      _pricingSchemaFlagsPromise = null; // don't cache a failure — let the next save retry
      throw error;
    });
  }
  return _pricingSchemaFlagsPromise;
}

export async function upsertPricingOutputsWithClient(client, contractId, output) {
  await client.query(
    `INSERT INTO public.contract_pricing_outputs
      (contract_id,epi,attritional_ratio,large_loss_load,cat_loss_load,commission_ratio,brokerage_ratio,tax_ratio,technical_result,max_commission,target_margin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (contract_id) DO UPDATE SET
      epi=EXCLUDED.epi,
      attritional_ratio=EXCLUDED.attritional_ratio,
      large_loss_load=EXCLUDED.large_loss_load,
      cat_loss_load=EXCLUDED.cat_loss_load,
      commission_ratio=EXCLUDED.commission_ratio,
      brokerage_ratio=EXCLUDED.brokerage_ratio,
      tax_ratio=EXCLUDED.tax_ratio,
      technical_result=EXCLUDED.technical_result,
      max_commission=EXCLUDED.max_commission,
      target_margin=EXCLUDED.target_margin,
      updated_at=now()`,
    [
      contractId,
      numOrNull(output.epi),
      numOrNull(output.attritional_ratio),
      numOrNull(output.large_loss_load),
      numOrNull(output.cat_loss_load),
      numOrNull(output.commission_ratio),
      numOrNull(output.brokerage_ratio),
      numOrNull(output.tax_ratio),
      numOrNull(output.technical_result),
      numOrNull(output.max_commission),
      numOrNull(output.target_margin),
    ]
  );
}
