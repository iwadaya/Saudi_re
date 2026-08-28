import { pool } from '../../../db/pool.js';
import { numOrNull, withTransaction } from './repositoryUtils.js';
import { buildBatchInsert } from '../../../db/batchInsert.js';
import { assertParentEntityUnchanged, touchParentEntity } from '../../../lib/parentEntityPersistence.js';

export async function getPricingYearly(contractId) {
  const { rows } = await pool.query('SELECT * FROM public.contract_pricing_yearly WHERE contract_id=$1 ORDER BY uw_year', [contractId]);
  return rows;
}

/**
 * Delete-and-reinsert the yearly rows on an existing client/transaction.
 * The single implementation both the standalone save and the composite
 * save path use — one multi-row INSERT instead of a round-trip per year
 * (see db/batchInsert.js).
 */
export async function replacePricingYearlyWithClient(client, contractId, rows = []) {
  await client.query('DELETE FROM public.contract_pricing_yearly WHERE contract_id=$1', [contractId]);
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
}

export async function replacePricingYearly(contractId, rows = [], { ifUnmodifiedSince } = {}) {
  // Delete-and-reinsert of ALL yearly rows is exactly the shape a stale tab
  // silently clobbers, so the standalone save takes the same opt-in
  // If-Unmodified-Since guard as the composite save (409 STALE_WRITE inside
  // the txn) and bumps the parent updated_at for the caller's next token.
  return await withTransaction(async (client) => {
    await assertParentEntityUnchanged(client, {
      parentTable: 'contract',
      idColumn: 'contract_id',
      id: contractId,
      ifUnmodifiedSince,
    });
    await replacePricingYearlyWithClient(client, contractId, rows);
    return touchParentEntity(client, {
      parentTable: 'contract',
      idColumn: 'contract_id',
      id: contractId,
    });
  });
}
