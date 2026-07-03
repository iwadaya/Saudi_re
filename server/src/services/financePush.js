// server/src/services/financePush.js
//
// Push a SIGNED contract into the Finance module ledger (finance_treaty_entry).
//
// Called from the two places a contract becomes SIGNED:
//   • approvals.markContractSigned  (AWAITING_SIGNED_LINE → SIGNED)  source 'SIGN'
//   • quoteBind.bindQuoteToContract (quote → new SIGNED contract)    source 'BIND'
//
// Design decisions (deliberate):
//   • Runs on the SAME transaction client as the status change, so
//     "signed ⟹ present in finance" holds atomically — a finance write
//     failure rolls back the sign rather than leaving a signed treaty
//     invisible to Finance.
//   • Idempotent UPSERT on contract_id: a re-sign after amendment refreshes
//     the EPI / line snapshot but never duplicates the entry. A refresh
//     resets status to PENDING_SETUP only if the entry was never
//     acknowledged; an ACTIVE entry keeps its Finance status.
//   • EPI snapshot from contract_pricing_outputs.epi (the priced EPI at 100%);
//     our-share = EPI × signed_line_pct/100. Both nullable — Finance sees
//     the entry either way and can chase missing figures.
//   • Audit row (entity_type FINANCE_ENTRY) written critically on the same
//     client — no push without a trail.

import { logAudit } from './audit.js';

/**
 * @param {import('pg').PoolClient} client  Open transaction client (required).
 * @param {object} args
 * @param {string} args.contractId
 * @param {'SIGN'|'BIND'|'BACKFILL'} args.source
 * @param {{ id?: string|null, name?: string|null, role?: string|null }} [args.actor]
 * @returns {Promise<{ entry_id: string, contract_id: string, status: string }>}
 */
export async function pushContractToFinance(client, { contractId, source, actor }) {
  const { rows } = await client.query(
    `SELECT c.contract_id, c.signed_line_pct, po.epi, cur.currency_code
       FROM public.contract c
       LEFT JOIN public.contract_pricing_outputs po ON po.contract_id = c.contract_id
       LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
      WHERE c.contract_id = $1`,
    [contractId],
  );
  if (!rows.length) {
    const err = new Error('Contract not found for finance push');
    err.status = 404; err.code = 'CONTRACT_NOT_FOUND';
    throw err;
  }
  const c = rows[0];
  const epi100 = c.epi != null ? Number(c.epi) : null;
  const linePct = c.signed_line_pct != null ? Number(c.signed_line_pct) : null;
  const epiShare = (epi100 != null && linePct != null)
    ? Math.round(epi100 * linePct) / 100
    : null;

  const { rows: entryRows } = await client.query(
    `INSERT INTO public.finance_treaty_entry
       (contract_id, source, signed_line_pct, epi_100, epi_our_share, currency_code)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (contract_id) DO UPDATE SET
       source          = EXCLUDED.source,
       signed_line_pct = EXCLUDED.signed_line_pct,
       epi_100         = EXCLUDED.epi_100,
       epi_our_share   = EXCLUDED.epi_our_share,
       currency_code   = EXCLUDED.currency_code,
       pushed_at       = now(),
       -- Never regress an entry Finance has already acknowledged.
       status          = CASE WHEN public.finance_treaty_entry.acknowledged_at IS NULL
                              THEN 'PENDING_SETUP'
                              ELSE public.finance_treaty_entry.status END,
       updated_at      = now()
     RETURNING entry_id, contract_id, status`,
    [contractId, source, linePct, epi100, epiShare, c.currency_code || null],
  );
  const entry = entryRows[0];

  await logAudit(client, {
    entityType: 'FINANCE_ENTRY',
    entityId: entry.entry_id,
    eventType: 'PUSHED_TO_FINANCE',
    actor: actor || null,
    payload: { contract_id: contractId, source, epi_100: epi100, signed_line_pct: linePct },
  }, { critical: true });

  return entry;
}
