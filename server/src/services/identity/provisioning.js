// server/src/services/identity/provisioning.js
// P1-identity Phase 1a — just-in-time SSO user provisioning.
//
// On a verified SSO login we upsert the local uw_user keyed on the IdP subject
// (idp_subject = claims.sub), NOT on email — auto-linking by email would let a
// new IdP account with a victim's email address take over an existing local
// account. A first-seen subject creates a fresh account; a returning subject is
// matched by its stable subject id.
//
// Role is RE-MAPPED on every login (the chosen policy): mapClaimsToRole turns
// the IdP claims into an internal role (defaulting to least privilege — D3). If
// the mapped role changed since last login, we report it so the caller can bump
// the revocation epoch (D5: an authority change forces re-login everywhere).
//
// SSO accounts carry NO usable local password: we store a non-scrypt sentinel so
// verifyPassword() can never succeed for them (local login is closed regardless
// of the break-glass list, which is keyed on username).

import { mapClaimsToRole } from '../../config/identity.js';

// Stored in password_hash for SSO accounts. verifyPassword() only accepts
// 'scrypt$…' values, so this can never authenticate a local password login.
const SSO_NO_PASSWORD = 'sso$no-local-password';

/** Derive a stable-ish username from claims; deduped against existing rows. */
async function deriveUsername(client, claims) {
  const base = String(
    claims.preferred_username
      || (claims.email ? String(claims.email).split('@')[0] : '')
      || `sso_${claims.sub}`,
  ).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '') || `sso_${claims.sub}`;
  let username = base;
  let n = 1;
  // Avoid colliding with a DIFFERENT user's username.
  while (true) {
    const { rows } = await client.query(
      `SELECT 1 FROM public.uw_user WHERE username = $1 AND (idp_subject IS DISTINCT FROM $2) LIMIT 1`,
      [username, claims.sub],
    );
    if (!rows.length) return username;
    n += 1;
    username = `${base}${n}`;
  }
}

/**
 * Upsert the local user for a verified SSO subject and return the resolved
 * identity. Runs on the caller's transaction client so it commits/rolls back
 * with the session creation.
 *
 * @param {import('pg').PoolClient} client transaction client.
 * @param {object} claims verified ID-token claims (sub required).
 * @param {object} cfg identity config (for role mapping).
 * @returns {Promise<{ userId: string, username: string, roleCode: string, roleChanged: boolean, created: boolean }>}
 */
export async function provisionFromClaims(client, claims, cfg) {
  if (!claims || !claims.sub) throw new Error('provisionFromClaims: claims.sub is required');

  const roleCode = mapClaimsToRole(claims, cfg);
  const { rows: roleRows } = await client.query(
    `SELECT role_id FROM public.uw_role WHERE role_code = $1 LIMIT 1`,
    [roleCode],
  );
  if (!roleRows.length) throw new Error(`provisionFromClaims: mapped role "${roleCode}" not found in uw_role`);
  const roleId = roleRows[0].role_id;

  const displayName = String(claims.name || claims.preferred_username || claims.email || 'SSO User').trim();
  const email = claims.email ? String(claims.email).trim().toLowerCase() : `${claims.sub}@sso.local`;

  // Match the existing account by IdP subject (stable, not email).
  const { rows: existing } = await client.query(
    `SELECT user_id, username, role_id, is_active FROM public.uw_user WHERE idp_subject = $1 LIMIT 1`,
    [claims.sub],
  );

  if (existing.length) {
    const u = existing[0];
    // A locally deactivated account must stay deactivated: an admin disabling a
    // departed/suspended user is the authoritative signal. Re-activating on the
    // next IdP login (offboarding lag, or a local-only disable) would silently
    // undo deprovisioning, so we refuse to mint a session for an inactive user.
    if (u.is_active === false) {
      throw Object.assign(new Error('account is deactivated'), { code: 'ACCOUNT_DEACTIVATED' });
    }
    const roleChanged = String(u.role_id) !== String(roleId);
    // NOTE: is_active is deliberately NOT written here — provisioning never
    // (re)activates an account; activation is an explicit admin action.
    await client.query(
      `UPDATE public.uw_user
          SET role_id = $2, display_name = $3, email = $4,
              auth_provider = 'SSO', updated_at = now()
        WHERE user_id = $1`,
      [u.user_id, roleId, displayName, email],
    );
    return { userId: u.user_id, username: u.username, roleCode, roleChanged, created: false };
  }

  const username = await deriveUsername(client, claims);
  const { rows: ins } = await client.query(
    `INSERT INTO public.uw_user
       (username, display_name, email, role_id, office, password_hash,
        must_change_password, auth_provider, idp_subject, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, false, 'SSO', $7, true)
     RETURNING user_id, username`,
    [username, displayName, email, roleId, claims.office || 'Riyadh', SSO_NO_PASSWORD, claims.sub],
  );
  // Default mandate (mirrors the local create path).
  await client.query(
    `INSERT INTO public.user_mandate (user_id, treaty_type_scope, approvals_required)
     VALUES ($1, 'BOTH', 1) ON CONFLICT (user_id) DO NOTHING`,
    [ins[0].user_id],
  );
  return { userId: ins[0].user_id, username: ins[0].username, roleCode, roleChanged: false, created: true };
}
