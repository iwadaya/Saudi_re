import { pool } from '../../../db/pool.js';

export async function createComponentSnapshot(contractId, label, components, createdBy) {
  const { rows } = await pool.query(
    `INSERT INTO public.pricing_component_snapshots (contract_id, snapshot_label, components, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [contractId, label || null, JSON.stringify(components), createdBy || null]
  );
  return rows[0];
}

export async function listComponentSnapshots(contractId) {
  const { rows } = await pool.query(
    'SELECT * FROM public.pricing_component_snapshots WHERE contract_id=$1 ORDER BY snapshot_date DESC',
    [contractId]
  );
  return rows;
}

/** Resolve a snapshot's owning contract so the controller can edit-lock it. */
export async function getComponentSnapshotById(snapshotId) {
  const { rows } = await pool.query(
    'SELECT id, contract_id FROM public.pricing_component_snapshots WHERE id=$1',
    [snapshotId]
  );
  return rows[0] || null;
}

/**
 * Delete ONE snapshot, always scoped to its owning contract. The id column is a
 * plain integer sequence, so an unscoped `WHERE id=$1` would let any caller who
 * can reach this function erase another contract's pricing-iteration history by
 * enumerating small integers — the contract predicate makes the row identity
 * (contract, snapshot), not a global guessable integer.
 */
export async function deleteComponentSnapshot(snapshotId, contractId) {
  const { rowCount } = await pool.query(
    'DELETE FROM public.pricing_component_snapshots WHERE id=$1 AND contract_id=$2',
    [snapshotId, contractId]
  );
  return rowCount;
}
