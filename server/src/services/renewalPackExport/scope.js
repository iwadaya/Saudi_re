// server/src/services/renewalPackExport/scope.js
// Per-user scoping for the portfolio renewal-pack export. The full workbook is a
// privileged bulk extract, so a scoped underwriter must only export the rows
// their MANDATE permits — by treaty-type scope (PROP_ONLY / NP_ONLY / BOTH) and
// by COB restrictions (restricted_cob_ids). This is applied to the EXPORT ONLY;
// the general contract-read routes stay open (see services/permissions.js — the
// P1-authz item owns any tightening of read visibility).

// NP categories are identified the same way the builder splits PROP vs NP.
const NP_CATEGORY = `(COALESCE(tt.category,'') ILIKE '%NP%' OR COALESCE(tt.category,'') ILIKE '%NON%')`;

/**
 * Resolve the contract scope for a user's portfolio export from their DB mandate
 * (authoritative — never the demo header, which always reports an unrestricted
 * mandate). Returns:
 *   { contractIds, treatyTypeScope, restrictedCobIds }
 * where `contractIds` is null for an UNRESTRICTED mandate (export everything) or
 * an array (possibly empty) of the contract ids the mandate permits.
 *
 * @param {object} pool    pg pool.
 * @param {string|null} userId  verified requester id (req.user.userId).
 */
export async function resolveExportScope(pool, userId) {
  let treatyTypeScope = 'BOTH';
  let restrictedCobIds = [];
  if (userId) {
    const { rows } = await pool.query(
      `SELECT COALESCE(treaty_type_scope,'BOTH') AS treaty_type_scope,
              COALESCE(restricted_cob_ids,'{}')  AS restricted_cob_ids
         FROM public.v_user_mandate WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (rows[0]) {
      treatyTypeScope = rows[0].treaty_type_scope || 'BOTH';
      restrictedCobIds = Array.isArray(rows[0].restricted_cob_ids) ? rows[0].restricted_cob_ids : [];
    }
  }

  // Unrestricted mandate → no row filter (full portfolio).
  if (treatyTypeScope === 'BOTH' && restrictedCobIds.length === 0) {
    return { contractIds: null, treatyTypeScope, restrictedCobIds };
  }

  const conds = [];
  const params = [];
  if (treatyTypeScope === 'PROP_ONLY') conds.push(`NOT ${NP_CATEGORY}`);
  else if (treatyTypeScope === 'NP_ONLY') conds.push(NP_CATEGORY);
  if (restrictedCobIds.length) {
    params.push(restrictedCobIds);
    // A contract is excluded when its primary class of business is restricted;
    // unclassified (NULL) contracts are not treated as restricted.
    conds.push(`(c.primary_class_of_business_id IS NULL OR c.primary_class_of_business_id <> ALL($${params.length}::uuid[]))`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT c.contract_id
       FROM public.contract c
       LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
       ${where}`,
    params
  );
  return { contractIds: rows.map((r) => r.contract_id), treatyTypeScope, restrictedCobIds };
}
