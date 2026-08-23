// server/src/services/quoteBind.js
//
// Quote → contract binding (P0-6). Produces, in ONE transaction:
//   • an immutable as-quoted SNAPSHOT — the quote and its quote_id-owned rows
//     (documents, large/cat losses, loss-selection, wording, offer) are left
//     untouched and remain the permanent record of what was signed; and
//   • a live SIGNED contract that owns its OWN copies of every relevant
//     sub-table, so the dashboard/portfolio prices and tracks exposure from the
//     contract going forward.
// The two are deliberately decoupled: later endorsements hit the contract copy
// only; the quote snapshot is frozen and never live-linked.
//
// Semantics (see the approved plan):
//   - COPY, never move. Every copied row is contract-owned (contract_id set,
//     quote_id NULL) so migration-072 single-owner CHECKs hold and the quote
//     keeps its own rows.
//   - One transaction; ANY failure rolls back fully → zero orphan contract rows.
//   - Double-bind rejected (quote.bound_contract_id guard under FOR UPDATE).
//   - Link recorded (contract.source_quote_id, quote.bound_contract_id/bound_at)
//     + audit events, in-transaction.
//
// The copy is metadata-driven: for each source→dest pair we copy the INTERSECTION
// of columns (excluding owner keys, surrogate-PK/auto-default columns, and
// timestamps, which take their defaults). A pre-flight schema check confirmed no
// dest NOT NULL column lacking a default is missing from its source, so the
// intersection copy never violates NOT NULL. The only non-flat tables are the
// profile→band and loss_report→losses parent/child pairs, handled explicitly
// with surrogate-id remapping.

import { logAudit } from './audit.js';
import { pushContractToFinance } from './financePush.js';

/** Flat symmetric sub-tables: quote_X (by quote_id) → contract_X (by contract_id). */
const FLAT_SYMMETRIC = [
  'prop_details', 'np_details', 'np_terms', 'np_layers', 'class_of_business',
  'commissions', 'commission_slides', 'loss_participation', 'epi_split',
  'underwriting_limit', 'cresta_data', 'triangle_cells', 'dev_factor',
  'pricing_outputs', 'pricing_yearly', 'np_pricing_inputs', 'np_pricing_layer_inputs',
  'np_pricing_outputs', 'np_stop_loss_pricing', 'np_egnpi_year', 'np_excess_ldf',
  'np_large_loss_ldf', 'np_large_loss_ultimate', 'np_cat_loss_ldf',
  'np_cat_loss_ultimate', 'np_historical_performance', 'np_expiring_layers',
  'np_expiring_terms', 'offer',
].map((s) => ({ src: `quote_${s}`, dest: `contract_${s}` }));

/**
 * Flat SHARED sub-tables: these already live in contract_* keyed by quote_id
 * (the quote's snapshot rows). Bind INSERTS new contract_id-owned copies; the
 * quote_id rows stay as the frozen snapshot.
 */
const FLAT_SHARED = [
  'contract_document', 'contract_loss_selection_snapshot',
  'contract_wording_checklist', 'contract_wording_checklist_run',
];

/** profile → band parent/child (surrogate profile_id remapped). */
const PROFILE_PARENTCHILD = [
  { parentSrc: 'quote_risk_profile', parentDest: 'contract_risk_profile', childSrc: 'quote_risk_profile_band', childDest: 'contract_risk_profile_band', key: 'profile_id' },
  { parentSrc: 'quote_claims_profile', parentDest: 'contract_claims_profile', childSrc: 'quote_claims_profile_band', childDest: 'contract_claims_profile_band', key: 'profile_id' },
];

/** Shared loss report → losses parent/child (surrogate report_id remapped), by quote_id. */
const LOSS_PARENTCHILD = [
  { parent: 'contract_large_loss_report', child: 'contract_large_losses', key: 'report_id' },
  { parent: 'contract_cat_loss_report', child: 'contract_cat_losses', key: 'report_id' },
];

const quoteIdent = (c) => `"${c}"`;
/** Column list for an INSERT target: bare quoted names. */
const nameList = (cols) => cols.map((c) => quoteIdent(c.name)).join(',');
/**
 * Column list for the SELECT source: cast to the destination type when src and
 * dest types differ (e.g. a quote `text` column into a contract enum column),
 * which Postgres otherwise rejects at plan time — even for zero rows.
 */
const selList = (cols) => cols.map((c) => (c.cast ? `${quoteIdent(c.name)}::${c.cast}` : quoteIdent(c.name))).join(',');

/**
 * Columns to copy from `src` into `dest`: present in both tables, excluding
 * owner keys, auto-generated surrogate columns (gen_random_uuid/nextval
 * defaults on dest), timestamps, and any caller-named columns. Each entry is
 * `{ name, cast }` where `cast` is the dest type to coerce to when the two
 * sides' types differ (null when identical or for array types).
 */
// The column intersection is schema-static after boot migrations, and a bind
// performs ~40 of these catalog self-joins while holding the quote lock —
// memoize per (src, dest, exclude) for the process lifetime (same rationale
// as the probes in modules/pricing/repositories/repositoryUtils.js). Failures
// are not cached so a transient error retries on the next bind.
const _copyableColumnsCache = new Map();

function copyableColumns(client, src, dest, exclude = []) {
  const key = `${src}|${dest}|${[...exclude].sort().join(',')}`;
  if (!_copyableColumnsCache.has(key)) {
    const promise = fetchCopyableColumns(client, src, dest, exclude).catch((err) => {
      _copyableColumnsCache.delete(key);
      throw err;
    });
    _copyableColumnsCache.set(key, promise);
  }
  return _copyableColumnsCache.get(key);
}

async function fetchCopyableColumns(client, src, dest, exclude) {
  const { rows } = await client.query(
    `SELECT s.column_name, s.udt_name AS src_udt, d.udt_name AS dest_udt
       FROM information_schema.columns s
       JOIN information_schema.columns d
         ON d.table_schema = 'public' AND d.table_name = $2 AND d.column_name = s.column_name
      WHERE s.table_schema = 'public' AND s.table_name = $1
        AND COALESCE(d.column_default, '') NOT LIKE 'gen_random_uuid%'
        AND COALESCE(d.column_default, '') NOT LIKE 'nextval%'
      ORDER BY s.ordinal_position`,
    [src, dest],
  );
  const skip = new Set(['contract_id', 'quote_id', 'created_at', 'updated_at', ...exclude]);
  return rows
    .filter((r) => !skip.has(r.column_name))
    .map((r) => ({
      name: r.column_name,
      // Coerce only when types differ; skip array types ('_'-prefixed udt) which
      // aren't castable via ::udt and never differ across the symmetric pairs.
      cast: r.src_udt !== r.dest_udt && !String(r.dest_udt).startsWith('_') ? r.dest_udt : null,
    }));
}

/** Copy a flat table's quote_id rows into contract_id-owned rows. */
async function copyFlat(client, src, dest, quoteId, contractId) {
  const cols = await copyableColumns(client, src, dest);
  const insertList = cols.length ? `,${nameList(cols)}` : '';
  const selectList = cols.length ? `,${selList(cols)}` : '';
  const { rowCount } = await client.query(
    `INSERT INTO public.${dest} (contract_id${insertList})
     SELECT $1${selectList} FROM public.${src} WHERE quote_id = $2`,
    [contractId, quoteId],
  );
  return rowCount;
}

/** Copy profile rows + their bands, remapping the surrogate profile_id. */
async function copyProfile(client, cfg, quoteId, contractId) {
  const parentCols = await copyableColumns(client, cfg.parentSrc, cfg.parentDest, [cfg.key]);
  const childCols = await copyableColumns(client, cfg.childSrc, cfg.childDest, [cfg.key]);
  const sel = parentCols.length ? `,${nameList(parentCols)}` : '';
  const { rows: parents } = await client.query(
    `SELECT "${cfg.key}"${sel} FROM public.${cfg.parentSrc} WHERE quote_id = $1`,
    [quoteId],
  );
  for (const p of parents) {
    const ph = parentCols.map((c, i) => (c.cast ? `$${i + 2}::${c.cast}` : `$${i + 2}`)).join(',');
    const ins = await client.query(
      `INSERT INTO public.${cfg.parentDest} (contract_id${parentCols.length ? `,${nameList(parentCols)}` : ''})
       VALUES ($1${parentCols.length ? `,${ph}` : ''}) RETURNING "${cfg.key}"`,
      [contractId, ...parentCols.map((c) => p[c.name])],
    );
    const newId = ins.rows[0][cfg.key];
    const childInsert = childCols.length ? `,${nameList(childCols)}` : '';
    const childSelect = childCols.length ? `,${selList(childCols)}` : '';
    await client.query(
      `INSERT INTO public.${cfg.childDest} ("${cfg.key}"${childInsert})
       SELECT $1${childSelect} FROM public.${cfg.childSrc} WHERE "${cfg.key}" = $2`,
      [newId, p[cfg.key]],
    );
  }
}

/** Copy shared loss-report rows (by quote_id) + their losses, remapping report_id. */
async function copyLossReport(client, cfg, quoteId, contractId) {
  const parentCols = await copyableColumns(client, cfg.parent, cfg.parent, [cfg.key]);
  const childCols = await copyableColumns(client, cfg.child, cfg.child, [cfg.key]);
  const sel = parentCols.length ? `,${nameList(parentCols)}` : '';
  const { rows: parents } = await client.query(
    `SELECT "${cfg.key}"${sel} FROM public.${cfg.parent} WHERE quote_id = $1`,
    [quoteId],
  );
  for (const p of parents) {
    const ph = parentCols.map((c, i) => (c.cast ? `$${i + 2}::${c.cast}` : `$${i + 2}`)).join(',');
    const ins = await client.query(
      `INSERT INTO public.${cfg.parent} (contract_id${parentCols.length ? `,${nameList(parentCols)}` : ''})
       VALUES ($1${parentCols.length ? `,${ph}` : ''}) RETURNING "${cfg.key}"`,
      [contractId, ...parentCols.map((c) => p[c.name])],
    );
    const newId = ins.rows[0][cfg.key];
    const childInsert = childCols.length ? `,${nameList(childCols)}` : '';
    const childSelect = childCols.length ? `,${selList(childCols)}` : '';
    await client.query(
      `INSERT INTO public.${cfg.child} ("${cfg.key}"${childInsert})
       SELECT $1${childSelect} FROM public.${cfg.child} WHERE "${cfg.key}" = $2`,
      [newId, p[cfg.key]],
    );
  }
}

/** Insert the contract header from the quote. Returns the new contract_id. */
async function insertContractHeader(client, q) {
  const { rows } = await client.query(
    `INSERT INTO public.contract
       (cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year,
        experience_source, renewal_date, inception_date, primary_class_of_business_id,
        contract_description, signed_line_pct, signed_at, created_by_user_id,
        assigned_to_user_id, alt_contract_id, import_metadata,
        status, uw_status, source_quote_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, now()),$14,$15,$16,$17,
             'SIGNED','SIGNED',$18)
     RETURNING contract_id`,
    [
      q.cedant_id, q.broker_id, q.country_id, q.currency_id, q.treaty_type_id, q.uw_year,
      q.experience_source, q.renewal_date, q.inception_date, q.primary_class_of_business_id,
      q.contract_description, q.signed_line_pct, q.signed_at, q.created_by_user_id,
      q.assigned_to_user_id, q.alt_contract_id, q.import_metadata, q.quote_id,
    ],
  );
  return rows[0].contract_id;
}

class BindError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

/**
 * Bind a SIGNED quote into a new SIGNED contract (atomic snapshot copy).
 *
 * @param {object} pool  pg pool.
 * @param {object} args  { quoteId, actor }
 * @returns {Promise<{ contract_id: string, source_quote_id: string }>}
 */
export async function bindQuoteToContract(pool, { quoteId, actor }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the quote so two concurrent binds serialize and the second sees the link.
    const { rows: qRows } = await client.query(
      'SELECT * FROM public.quote WHERE quote_id = $1 FOR UPDATE', [quoteId],
    );
    const q = qRows[0];
    if (!q) throw new BindError('Quote not found', 404, 'NOT_FOUND');
    if (q.bound_contract_id) {
      throw new BindError('This quote is already bound to a contract.', 409, 'ALREADY_BOUND');
    }
    if (String(q.status).toUpperCase() !== 'SIGNED') {
      throw new BindError('Only a SIGNED quote can be bound to a contract.', 422, 'QUOTE_NOT_SIGNED');
    }

    const contractId = await insertContractHeader(client, q);

    // Copy every sub-table (full fidelity) into contract-owned rows.
    for (const { src, dest } of FLAT_SYMMETRIC) await copyFlat(client, src, dest, quoteId, contractId);
    for (const dest of FLAT_SHARED) await copyFlat(client, dest, dest, quoteId, contractId);
    for (const cfg of PROFILE_PARENTCHILD) await copyProfile(client, cfg, quoteId, contractId);
    for (const cfg of LOSS_PARENTCHILD) await copyLossReport(client, cfg, quoteId, contractId);

    // Record the bind link on the (otherwise frozen) quote snapshot.
    await client.query(
      'UPDATE public.quote SET bound_contract_id = $1, bound_at = now(), updated_at = now() WHERE quote_id = $2',
      [contractId, quoteId],
    );

    // Audit both sides, in the SAME transaction (critical → rolls back on failure).
    await logAudit(client, {
      entityType: 'CONTRACT', entityId: contractId, eventType: 'BOUND_FROM_QUOTE',
      actor, payload: { sourceQuoteId: quoteId },
    }, { critical: true });
    await logAudit(client, {
      entityType: 'QUOTE', entityId: quoteId, eventType: 'QUOTE_BOUND',
      actor, payload: { contractId },
    }, { critical: true });

    // Finance handover — the bound contract is born SIGNED, so it enters the
    // finance ledger in the same transaction (see services/financePush.js).
    await pushContractToFinance(client, { contractId, source: 'BIND', actor });

    await client.query('COMMIT');
    return { contract_id: contractId, source_quote_id: quoteId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
