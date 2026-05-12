import { pool } from '../../../db/pool.js';
import { numOrNull } from '../../../helpers.js';

export { numOrNull };

export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getPricingSchemaFlags() {
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
