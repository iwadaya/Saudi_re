import { pool } from '../../../db/pool.js';
import { numOrNull, withTransaction } from './repositoryUtils.js';

export async function getPricingYearly(contractId) {
  const { rows } = await pool.query('SELECT * FROM public.contract_pricing_yearly WHERE contract_id=$1 ORDER BY uw_year', [contractId]);
  return rows;
}

export async function replacePricingYearly(contractId, rows = []) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM public.contract_pricing_yearly WHERE contract_id=$1', [contractId]);
    for (const row of rows) {
      await client.query(
        `INSERT INTO public.contract_pricing_yearly
          (contract_id,uw_year,ultimate_premium,ultimate_loss,loss_ratio,commission_amt,brokerage_amt,technical_result,record_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          contractId,
          row.uw_year,
          numOrNull(row.ultimate_premium),
          numOrNull(row.ultimate_loss),
          numOrNull(row.loss_ratio),
          numOrNull(row.commission_amt),
          numOrNull(row.brokerage_amt),
          numOrNull(row.technical_result),
          row.record_type || 'PROJECTED',
        ]
      );
    }
  });
}
