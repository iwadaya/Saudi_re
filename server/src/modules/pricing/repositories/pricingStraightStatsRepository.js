import { pool } from '../../../db/pool.js';
import { numOrNull, withTransaction } from './repositoryUtils.js';
import { buildBatchInsert } from '../../../db/batchInsert.js';

export async function saveStraightStats(payload) {
  const { contractId, tailType, stats = [] } = payload;
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO public.contract_straight_experience (contract_id,tail_type)
       VALUES ($1,$2)
       ON CONFLICT (contract_id) DO UPDATE SET tail_type=EXCLUDED.tail_type,updated_at=now()`,
      [contractId, tailType]
    );
    await client.query('DELETE FROM public.contract_straight_uw_stats WHERE contract_id=$1', [contractId]);
    // One multi-row INSERT instead of a round-trip per stat row (see db/batchInsert.js).
    const insert = buildBatchInsert({
      table: 'public.contract_straight_uw_stats',
      columns: ['contract_id', 'underwriting_year', 'premium', 'paid_claims', 'os_claims'],
      rows: stats.map((stat) => [
        stat.underwriting_year ?? stat.uw_year,
        numOrNull(stat.premium),
        numOrNull(stat.paid_claims),
        numOrNull(stat.os_claims),
      ]),
      leadingId: contractId,
    });
    if (insert) await client.query(insert.sql, insert.params);
  });
}

export async function loadStraightStats(contractId) {
  const { rows: experienceRows } = await pool.query('SELECT * FROM public.contract_straight_experience WHERE contract_id=$1', [contractId]);
  const { rows: stats } = await pool.query('SELECT * FROM public.contract_straight_uw_stats WHERE contract_id=$1 ORDER BY underwriting_year', [contractId]);
  return {
    ...(experienceRows[0] || { tail_type: 'SHORT_TAIL' }),
    stats,
  };
}
