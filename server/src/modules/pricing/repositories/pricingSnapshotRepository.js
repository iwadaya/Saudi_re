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

export async function deleteComponentSnapshot(snapshotId) {
  await pool.query('DELETE FROM public.pricing_component_snapshots WHERE id=$1', [snapshotId]);
}
