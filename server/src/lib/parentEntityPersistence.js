import { assertEntityUnchanged } from '../db/optimisticLock.js';

export async function assertParentEntityUnchanged(db, { parentTable, idColumn, id, ifUnmodifiedSince }) {
  await assertEntityUnchanged(db, {
    table: `public.${parentTable}`,
    idColumn,
    id,
    ifUnmodifiedSince,
  });
}

export async function touchParentEntity(db, { parentTable, idColumn, id }) {
  const { rows } = await db.query(
    `UPDATE public.${parentTable}
        SET updated_at = now()
      WHERE ${idColumn} = $1
      RETURNING updated_at`,
    [id],
  );
  return rows[0]?.updated_at || null;
}
