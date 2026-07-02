import { pool } from '../../../db/pool.js';
import { numOrNull, withTransaction } from './repositoryUtils.js';
import { buildBatchInsert } from '../../../db/batchInsert.js';

export async function getPricingYearly(contractId) {
  const { rows } = await pool.query('SELECT * FROM public.contract_pricing_yearly WHERE contract_id=$1 ORDER BY uw_year', [contractId]);
  return rows;
}

export async function replacePricingYearly(contractId, rows = []) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM public.contract_pricing_yearly WHERE contract_id=$1', [contractId]);
    // One multi-row INSERT instead of a round-trip per year — mirrors the
    // composite save path in pricingOutputsRepository (see db/batchInsert.js).
    const insert = buildBatchInsert({
      table: 'public.contract_pricing_yearly',
      columns: ['contract_id', 'uw_year', 'ultimate_premium', 'ultimate_loss', 'loss_ratio', 'commission_amt', 'brokerage_amt', 'technical_result', 'record_type'],
      rows: rows.map((row) => [
        row.uw_year,
        numOrNull(row.ultimate_premium),
        numOrNull(row.ultimate_loss),
        numOrNull(row.loss_ratio),
        numOrNull(row.commission_amt),
        numOrNull(row.brokerage_amt),
        numOrNull(row.technical_result),
        row.record_type || 'PROJECTED',
      ]),
      leadingId: contractId,
    });
    if (insert) await client.query(insert.sql, insert.params);
  });
}
