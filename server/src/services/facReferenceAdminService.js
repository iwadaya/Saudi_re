// server/src/services/facReferenceAdminService.js
//
// How rates get loaded, and who is on the hook for them.
//
// Every facultative rate table ships empty by design: a rate nobody can
// attribute is a rate nobody can defend (design doc §8). That discipline is
// only honest if there is a real way to put real numbers in, with a name
// against them. This is it.
//
//   DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──publish──▶ live
//     ▲                      │
//     └───────reject─────────┘
//
// Two properties do the work.
//
// **Nothing edits a live rate table in place.** Changes are staged against a
// draft version and applied on publish, in one transaction. A half-applied
// rate revision would price some risks on the new numbers and some on the old,
// and nothing downstream could tell which.
//
// **Four eyes.** The approver must not be the submitter. Enforced here and
// again by a CHECK constraint, because a control that lives only in
// application code lasts exactly as long as the next refactor.
//
// ── On building SQL from a table name ────────────────────────────────────
//
// This module writes to a table chosen by the caller, which is the shape of
// every SQL-injection story ever told. The mitigation is that `target_table`
// and every column name are matched against the ALLOW-LIST below before any
// SQL is constructed, and anything unrecognised is rejected rather than
// escaped. Values are always parameterised. The allow-list is the security
// boundary: adding a table to it is a deliberate act, and it is duplicated in
// the migration's CHECK constraint so the database refuses what the service
// would have refused.

import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * The reference tables a rate revision may touch, and the columns it may set
 * on each. Anything not named here is rejected — never escaped, never
 * interpolated.
 *
 * `key` is the natural key used to locate a row for UPDATE and DELETE.
 */
export const STAGEABLE = {
  fac_exposure_curve: {
    key: ['curve_code'],
    columns: ['curve_code', 'curve_name', 'curve_set', 'source', 'kind', 'params',
      'effective_from', 'effective_to', 'active', 'notes'],
  },
  fac_curve_band: {
    key: ['family_code', 'min_exposure'],
    columns: ['family_code', 'min_exposure', 'max_exposure', 'curve_id'],
  },
  fac_ilf_curve: {
    key: ['curve_code'],
    columns: ['curve_code', 'curve_name', 'family_code', 'territory', 'source', 'kind',
      'basic_limit', 'params', 'effective_from', 'effective_to', 'active', 'notes'],
  },
  fac_ilf_point: {
    key: ['curve_id', 'limit_amount'],
    columns: ['curve_id', 'limit_amount', 'ilf'],
  },
  fac_liability_base_rate: {
    key: ['fac_cob_id', 'territory', 'basis_unit'],
    columns: ['fac_cob_id', 'territory', 'basis_unit', 'basis_divisor', 'basic_limit',
      'loss_cost_per_unit', 'hazard_band', 'source', 'effective_from', 'effective_to', 'active'],
  },
  fac_transit_base_rate: {
    key: ['commodity', 'conveyance', 'route_region'],
    columns: ['commodity', 'conveyance', 'route_region', 'rate_pm', 'packing_factor',
      'source', 'effective_from', 'effective_to', 'active'],
  },
  fac_hull_base_rate: {
    key: ['vessel_type', 'tonnage_min'],
    columns: ['vessel_type', 'tonnage_min', 'tonnage_max', 'rate_pm', 'source',
      'effective_from', 'effective_to', 'active'],
  },
  fac_hull_factor: {
    key: ['factor_kind', 'factor_key'],
    columns: ['factor_kind', 'factor_key', 'factor', 'source', 'active'],
  },
  fac_war_rate: {
    key: ['region', 'basis', 'effective_from'],
    columns: ['region', 'basis', 'rate_pm', 'breach_ap_pm', 'source',
      'effective_from', 'effective_to', 'active', 'notes'],
  },
  fac_project_base_rate: {
    key: ['project_type', 'territory', 'contract_value_min'],
    columns: ['project_type', 'territory', 'contract_value_min', 'contract_value_max',
      'rate_pm', 'period_factor_per_month', 'period_baseline_months', 'source',
      'effective_from', 'effective_to', 'active'],
  },
  fac_project_factor: {
    key: ['factor_kind', 'factor_key'],
    columns: ['factor_kind', 'factor_key', 'loading', 'source', 'active'],
  },
  fac_project_load_rate: {
    key: ['load_kind', 'load_key'],
    columns: ['load_kind', 'load_key', 'rate_pm', 'per_unit', 'source', 'active'],
  },
  fac_plant_base_rate: {
    key: ['machine_type', 'territory'],
    columns: ['machine_type', 'territory', 'rate_pm', 'source',
      'effective_from', 'effective_to', 'active'],
  },
  fac_plant_factor: {
    key: ['factor_kind', 'factor_key'],
    columns: ['factor_kind', 'factor_key', 'factor', 'source', 'active'],
  },
  fac_energy_base_rate: {
    key: ['asset_type', 'process_hazard_band', 'territory'],
    columns: ['asset_type', 'process_hazard_band', 'territory', 'rate_pm',
      'windstorm_season_load_pm', 'source', 'effective_from', 'effective_to', 'active'],
  },
  fac_energy_sublimit_rate: {
    key: ['sublimit_kind', 'sublimit_key'],
    columns: ['sublimit_kind', 'sublimit_key', 'rate_pm', 'source', 'active'],
  },
  fac_cyber_base_rate: {
    key: ['industry_code', 'revenue_min', 'territory'],
    columns: ['industry_code', 'revenue_min', 'revenue_max', 'territory', 'basic_limit',
      'rate_per_million', 'source', 'effective_from', 'effective_to', 'active'],
  },
  fac_cyber_control_factor: {
    key: ['control_key', 'posture'],
    columns: ['control_key', 'posture', 'factor', 'source', 'active'],
  },
  fac_motor_base_rate: {
    key: ['vehicle_category', 'territory', 'effective_from'],
    columns: ['vehicle_category', 'territory', 'od_cost_per_vehicle_year',
      'tpl_cost_per_vehicle_year', 'tpl_basic_limit', 'source',
      'effective_from', 'effective_to', 'active'],
  },
  fac_pa_base_rate: {
    key: ['occupational_class', 'cover_basis', 'territory'],
    columns: ['occupational_class', 'cover_basis', 'territory', 'rate_per_unit',
      'source', 'effective_from', 'effective_to', 'active'],
  },
  fac_zone_budget: {
    key: ['cresta_zone', 'peril', 'uw_year'],
    columns: ['cresta_zone', 'country_id', 'peril', 'uw_year', 'budget_si', 'budget_pml',
      'source', 'active'],
  },
};

/** Columns holding JSON, which need a ::jsonb cast rather than a text bind. */
const JSON_COLUMNS = new Set(['params']);

/** @param {string} table @returns {{key: string[], columns: string[]}} */
function spec(table) {
  const found = Object.prototype.hasOwnProperty.call(STAGEABLE, table)
    ? STAGEABLE[table] : null;
  if (!found) {
    throw Object.assign(
      new Error(`"${table}" is not a stageable reference table. Adding one is a deliberate `
        + 'change to the allow-list in facReferenceAdminService.js and to the CHECK '
        + 'constraint in migration 139.'),
      { status: 400, code: 'TABLE_NOT_STAGEABLE' },
    );
  }
  return found;
}

/**
 * Reject any column the target does not declare, before a name reaches SQL.
 *
 * @param {string} table
 * @param {object} payload
 * @returns {string[]} the column names, in the allow-list's own order
 */
function checkedColumns(table, payload) {
  const { columns } = spec(table);
  const given = Object.keys(payload || {});
  const unknown = given.filter((c) => !columns.includes(c));
  if (unknown.length > 0) {
    throw Object.assign(
      new Error(`${table} has no column(s) ${unknown.join(', ')}. Allowed: ${columns.join(', ')}.`),
      { status: 400, code: 'COLUMN_NOT_ALLOWED' },
    );
  }
  return columns.filter((c) => given.includes(c));
}

const err = (message, status, code) => Object.assign(new Error(message), { status, code });

/**
 * Open a new draft revision.
 *
 * @param {object} args {versionLabel, effectiveFrom, notes, ownerNote, actorId, actorLabel}
 * @returns {Promise<object>}
 */
export async function createDraftVersion({
  versionLabel, effectiveFrom, notes, ownerNote, actorId, actorLabel,
}) {
  if (!versionLabel) throw err('A rate revision needs a version label.', 400, 'VALIDATION_FAILED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO public.fac_rate_table_version
         (version_label, effective_from, notes, owner_note, status, created_by)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, 'DRAFT', $5)
       RETURNING *`,
      [versionLabel, effectiveFrom || null, notes || null, ownerNote || null, actorId || null],
    );
    await writeEvent(client, rows[0].version_id, 'CREATED', actorId, actorLabel, {
      version_label: versionLabel,
    });
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Stage rows against a draft.
 *
 * @param {object} args {versionId, rows, actorId, actorLabel}
 * @returns {Promise<{staged: number}>}
 */
export async function stageRows({ versionId, rows, actorId, actorLabel }) {
  const version = await loadVersion(versionId);
  if (version.status !== 'DRAFT') {
    throw err(`This revision is ${version.status}; only a DRAFT can take new rows.`,
      409, 'INVALID_STATE');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows || []) {
      const table = String(row.target_table || '');
      const operation = String(row.operation || 'INSERT').toUpperCase();
      if (!['INSERT', 'UPDATE', 'DELETE'].includes(operation)) {
        throw err(`Unknown operation "${operation}".`, 400, 'VALIDATION_FAILED');
      }
      // Validate the names now, at staging time, so a bad column is caught by
      // the person who typed it rather than by the publish transaction.
      if (operation !== 'DELETE') checkedColumns(table, row.payload || {});
      if (operation !== 'INSERT') {
        const { key } = spec(table);
        const given = Object.keys(row.row_key || {});
        const missing = key.filter((k) => !given.includes(k));
        if (missing.length > 0) {
          throw err(`${operation} on ${table} needs ${missing.join(', ')} to find the row.`,
            400, 'VALIDATION_FAILED');
        }
        checkedColumns(table, row.row_key || {});
      }
      await client.query(
        `INSERT INTO public.fac_rate_stage
           (version_id, target_table, operation, row_key, payload, note, created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
        [
          versionId, table, operation,
          row.row_key ? JSON.stringify(row.row_key) : null,
          JSON.stringify(row.payload || {}),
          row.note || null, actorId || null,
        ],
      );
    }
    await writeEvent(client, versionId, 'STAGED', actorId, actorLabel, {
      row_count: (rows || []).length,
    });
    await client.query('COMMIT');
    return { staged: (rows || []).length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Submit a draft for approval.
 *
 * @param {object} args {versionId, actorId, actorLabel}
 * @returns {Promise<object>}
 */
export async function submitForApproval({ versionId, actorId, actorLabel }) {
  const version = await loadVersion(versionId);
  if (version.status !== 'DRAFT') {
    throw err(`This revision is ${version.status}; only a DRAFT can be submitted.`,
      409, 'INVALID_STATE');
  }
  if (!actorId) throw err('Submitting for approval needs an identified user.', 401, 'UNAUTHORIZED');

  const { rows: staged } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM public.fac_rate_stage WHERE version_id = $1', [versionId],
  );
  if (staged[0].n === 0) {
    throw err('This revision stages no rows. An empty revision has nothing to approve.',
      409, 'NOTHING_STAGED');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE public.fac_rate_table_version
          SET status = 'PENDING_APPROVAL', submitted_by = $2, submitted_at = now(),
              rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
        WHERE version_id = $1 RETURNING *`,
      [versionId, actorId],
    );
    await writeEvent(client, versionId, 'SUBMITTED', actorId, actorLabel, {
      staged_rows: staged[0].n,
    });
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Approve a pending revision. The approver must not be the submitter.
 *
 * @param {object} args {versionId, actorId, actorLabel}
 * @returns {Promise<object>}
 */
export async function approveVersion({ versionId, actorId, actorLabel }) {
  const version = await loadVersion(versionId);
  if (version.status !== 'PENDING_APPROVAL') {
    throw err(`This revision is ${version.status}; only a PENDING_APPROVAL one can be approved.`,
      409, 'INVALID_STATE');
  }
  if (!actorId) throw err('Approving needs an identified user.', 401, 'UNAUTHORIZED');
  if (version.submitted_by && String(version.submitted_by) === String(actorId)) {
    // The whole control, in one line.
    throw err('You submitted this revision, so you cannot approve it. Rate changes take a '
      + 'second pair of eyes.', 403, 'FOUR_EYES_REQUIRED');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE public.fac_rate_table_version
          SET status = 'APPROVED', approved_by = $2, approved_at = now()
        WHERE version_id = $1 RETURNING *`,
      [versionId, actorId],
    );
    await writeEvent(client, versionId, 'APPROVED', actorId, actorLabel, {});
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Send a revision back to draft with a reason.
 *
 * @param {object} args {versionId, reason, actorId, actorLabel}
 * @returns {Promise<object>}
 */
export async function rejectVersion({ versionId, reason, actorId, actorLabel }) {
  const version = await loadVersion(versionId);
  if (version.status !== 'PENDING_APPROVAL') {
    throw err(`This revision is ${version.status}; only a PENDING_APPROVAL one can be rejected.`,
      409, 'INVALID_STATE');
  }
  if (String(reason || '').trim().length < 5) {
    throw err('A rejection needs a reason of at least 5 characters.', 422, 'VALIDATION_FAILED');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE public.fac_rate_table_version
          SET status = 'DRAFT', rejected_by = $2, rejected_at = now(), rejection_reason = $3,
              submitted_by = NULL, submitted_at = NULL
        WHERE version_id = $1 RETURNING *`,
      [versionId, actorId || null, String(reason).trim()],
    );
    await writeEvent(client, versionId, 'REJECTED', actorId, actorLabel, { reason });
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Apply an approved revision's staged rows to the live tables.
 *
 * One transaction for the whole revision. A half-applied rate change would
 * price some risks on the new numbers and some on the old, with nothing
 * downstream able to tell which — so it either all lands or none of it does.
 *
 * @param {object} args {versionId, actorId, actorLabel}
 * @returns {Promise<{applied: number, byTable: object}>}
 */
export async function publishVersion({ versionId, actorId, actorLabel }) {
  const version = await loadVersion(versionId);
  if (version.status !== 'APPROVED') {
    throw err(`This revision is ${version.status}; only an APPROVED one can be published.`,
      409, 'INVALID_STATE');
  }
  if (version.published_at) {
    throw err('This revision has already been published.', 409, 'ALREADY_PUBLISHED');
  }

  const { rows: staged } = await pool.query(
    `SELECT stage_id, target_table, operation, row_key, payload
       FROM public.fac_rate_stage WHERE version_id = $1 ORDER BY created_at`,
    [versionId],
  );

  const client = await pool.connect();
  const byTable = {};
  try {
    await client.query('BEGIN');
    for (const row of staged) {
      await applyStagedRow(client, row);
      byTable[row.target_table] = (byTable[row.target_table] || 0) + 1;
      await client.query(
        'UPDATE public.fac_rate_stage SET applied_at = now() WHERE stage_id = $1',
        [row.stage_id],
      );
    }
    // Only one revision is in force at a time — the schema says so with a
    // partial unique index. Publishing closes the previous one off at the day
    // before this one starts, so a historic quote still resolves to the rates
    // that priced it (finding F12) instead of to a gap.
    const { rows: superseded } = await client.query(
      `UPDATE public.fac_rate_table_version
          SET effective_to = ($2::date - INTERVAL '1 day')::date,
              status = 'SUPERSEDED'
        WHERE version_id <> $1
          AND effective_to IS NULL
          AND published_at IS NOT NULL
        RETURNING version_id, version_label`,
      [versionId, version.effective_from],
    );
    await client.query(
      `UPDATE public.fac_rate_table_version SET published_at = now() WHERE version_id = $1`,
      [versionId],
    );
    await writeEvent(client, versionId, 'PUBLISHED', actorId, actorLabel, {
      applied: staged.length,
      by_table: byTable,
      superseded: superseded.map((r) => r.version_label),
    });
    await client.query('COMMIT');
    logger.info('fac rate revision published', {
      versionId, applied: staged.length, byTable,
    });
    return {
      applied: staged.length,
      byTable,
      superseded: superseded.map((r) => r.version_label),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Apply one staged row. Every identifier here has already been matched against
 * the allow-list; every value is parameterised.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} row
 */
async function applyStagedRow(client, row) {
  const table = row.target_table;
  const { key } = spec(table);
  const payload = row.payload || {};
  const rowKey = row.row_key || {};

  const bind = (column, value, params) => {
    params.push(value);
    return JSON_COLUMNS.has(column) ? `$${params.length}::jsonb` : `$${params.length}`;
  };
  const valueFor = (column, source) => {
    const v = source[column];
    return JSON_COLUMNS.has(column) && v !== null && typeof v === 'object'
      ? JSON.stringify(v) : v;
  };

  if (row.operation === 'INSERT') {
    const columns = checkedColumns(table, payload);
    const params = [];
    const placeholders = columns.map((c) => bind(c, valueFor(c, payload), params));
    await client.query(
      `INSERT INTO public.${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      params,
    );
    return;
  }

  const params = [];
  const where = key.map((c) => `${c} IS NOT DISTINCT FROM ${bind(c, valueFor(c, rowKey), params)}`);

  if (row.operation === 'DELETE') {
    await client.query(`DELETE FROM public.${table} WHERE ${where.join(' AND ')}`, params);
    return;
  }

  const columns = checkedColumns(table, payload);
  if (columns.length === 0) {
    throw err(`An UPDATE on ${table} sets no columns.`, 400, 'VALIDATION_FAILED');
  }
  const sets = columns.map((c) => `${c} = ${bind(c, valueFor(c, payload), params)}`);
  const { rowCount } = await client.query(
    `UPDATE public.${table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`,
    params,
  );
  if (rowCount === 0) {
    // Publishing an update that matched nothing would look like success and
    // change nothing, which is the quietest possible way to ship a rate that
    // is not there.
    throw err(`An UPDATE staged against ${table} matched no row. The revision was not applied.`,
      409, 'STAGED_ROW_NOT_FOUND');
  }
}

/** @param {string} versionId @returns {Promise<object>} */
export async function loadVersion(versionId) {
  const { rows } = await pool.query(
    'SELECT * FROM public.fac_rate_table_version WHERE version_id = $1', [versionId],
  );
  if (!rows[0]) throw err('Rate revision not found', 404, 'NOT_FOUND');
  return rows[0];
}

/**
 * A revision with its staged rows and its history.
 *
 * @param {string} versionId
 * @returns {Promise<object>}
 */
export async function versionDetail(versionId) {
  const version = await loadVersion(versionId);
  const [staged, events] = await Promise.all([
    pool.query(
      `SELECT s.stage_id, s.target_table, s.operation, s.row_key, s.payload, s.note,
              s.applied_at, u.display_name AS created_by_name
         FROM public.fac_rate_stage s
         LEFT JOIN public.uw_user u ON u.user_id = s.created_by
        WHERE s.version_id = $1 ORDER BY s.target_table, s.created_at`,
      [versionId],
    ),
    pool.query(
      `SELECT e.event_type, e.actor_label, e.payload, e.created_at, u.display_name AS actor_name
         FROM public.fac_rate_version_event e
         LEFT JOIN public.uw_user u ON u.user_id = e.actor_id
        WHERE e.version_id = $1 ORDER BY e.created_at`,
      [versionId],
    ),
  ]);
  return { version, staged: staged.rows, events: events.rows };
}

/** @returns {Promise<Array<object>>} */
export async function listVersions() {
  const { rows } = await pool.query(
    `SELECT v.*, su.display_name AS submitted_by_name, au.display_name AS approved_by_name,
            (SELECT COUNT(*)::int FROM public.fac_rate_stage s WHERE s.version_id = v.version_id)
              AS staged_rows
       FROM public.fac_rate_table_version v
       LEFT JOIN public.uw_user su ON su.user_id = v.submitted_by
       LEFT JOIN public.uw_user au ON au.user_id = v.approved_by
      ORDER BY v.effective_from DESC, v.created_at DESC`,
  );
  return rows;
}

/** The tables a revision may touch, for the admin screen to render. */
export function stageableTables() {
  return Object.entries(STAGEABLE).map(([table, s]) => ({
    table, key: s.key, columns: s.columns,
  }));
}

async function writeEvent(client, versionId, eventType, actorId, actorLabel, payload) {
  await client.query(
    `INSERT INTO public.fac_rate_version_event
       (version_id, event_type, actor_id, actor_label, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [versionId, eventType, actorId || null, actorLabel || null, JSON.stringify(payload || {})],
  );
}
