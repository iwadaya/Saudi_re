// server/scripts/anonymize-user.js — GDPR / right-to-erasure for a user.
//
// Reinsurance records (contracts, quotes, claims, audit trail) carry a legal and
// regulatory retention obligation, so we do NOT hard-delete a person and cascade
// away financial history. Instead we PSEUDONYMISE: the directly-identifying PII
// on the uw_user row is replaced with a tombstone, the credential is destroyed,
// the account is deactivated, every session is revoked, and the human-readable
// name is scrubbed from the audit payloads — while the stable user_id linkage is
// kept so the audit trail stays internally consistent and non-repudiable.
//
// This satisfies erasure of personal data while preserving the lawful-basis
// retention of the business/audit records (see docs/data-retention.md).
//
// Usage (run from server/):
//   node scripts/anonymize-user.js <email|username|user_id> --dry-run
//   node scripts/anonymize-user.js <email|username|user_id> --yes
//
// --dry-run  : show what would change, touch nothing (default if --yes absent).
// --yes      : actually perform the (irreversible) anonymisation.
import { pool, closePools } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';

const arg = process.argv[2];
const flags = new Set(process.argv.slice(3));
const commit = flags.has('--yes');
const dryRun = !commit || flags.has('--dry-run');

if (!arg || arg.startsWith('--')) {
  console.error('Usage: node scripts/anonymize-user.js <email|username|user_id> [--dry-run|--yes]');
  process.exit(2);
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT user_id, email, username, display_name, is_active, is_system_admin
         FROM public.uw_user
        WHERE user_id::text = $1 OR lower(email) = lower($1) OR lower(username) = lower($1)
        FOR UPDATE`,
      [arg],
    );
    if (!rows.length) {
      console.error(`No user matches "${arg}" (tried user_id, email, username).`);
      await client.query('ROLLBACK');
      process.exitCode = 1;
      return;
    }
    if (rows.length > 1) {
      console.error(`Ambiguous: "${arg}" matched ${rows.length} users — pass the exact user_id.`);
      await client.query('ROLLBACK');
      process.exitCode = 1;
      return;
    }

    const u = rows[0];
    const short = String(u.user_id).slice(0, 8);
    const tomb = {
      email: `erased+${short}@invalid.example`,
      username: `erased_${short}`,
      display_name: `Erased User ${short}`,
    };

    console.log('Target user:');
    console.log(`  user_id      : ${u.user_id}`);
    console.log(`  email        : ${u.email}  ->  ${tomb.email}`);
    console.log(`  username     : ${u.username ?? '(none)'}  ->  ${tomb.username}`);
    console.log(`  display_name : ${u.display_name}  ->  ${tomb.display_name}`);
    console.log(`  office/phone : -> NULL   credential -> destroyed   is_active -> false`);
    if (u.is_system_admin) console.warn('  ⚠  This user is a SYSTEM ADMIN — ensure another admin exists.');

    // Count what the scrub/revoke will touch (for the dry-run report).
    const { rows: [{ live_sessions }] } = await client.query(
      `SELECT count(*)::int AS live_sessions FROM public.auth_session
        WHERE user_id = $1 AND revoked_at IS NULL`, [u.user_id]);
    const { rows: [{ audit_rows }] } = await client.query(
      `SELECT (SELECT count(*) FROM public.audit_log WHERE actor::text = $1)
            + (SELECT count(*) FROM public.contract_audit_event WHERE actor::text = $1) AS audit_rows`,
      [String(u.user_id)]);
    console.log(`  live sessions to revoke : ${live_sessions}`);
    console.log(`  audit rows to name-scrub: ${audit_rows}  (user_id linkage preserved)`);

    if (dryRun) {
      console.log('\nDRY RUN — no changes written. Re-run with --yes to apply.');
      await client.query('ROLLBACK');
      return;
    }

    // 1. Pseudonymise PII, destroy the credential, deactivate, mass-revoke via epoch bump.
    await client.query(
      `UPDATE public.uw_user
          SET email         = $2,
              username      = $3,
              display_name  = $4,
              office        = NULL,
              phone         = NULL,
              password_hash = 'ERASED_' || gen_random_uuid()::text,
              is_active     = false,
              session_epoch = session_epoch + 1,
              updated_at    = now()
        WHERE user_id = $1`,
      [u.user_id, tomb.email, tomb.username, tomb.display_name],
    );

    // 2. Revoke every live session row (belt-and-suspenders with the epoch bump).
    await client.query(
      `UPDATE public.auth_session
          SET revoked_at = now(), revoked_reason = 'ERASED'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [u.user_id],
    );

    // 3. Scrub the human-readable name from audit payloads, KEEP the actor id.
    for (const table of ['audit_log', 'contract_audit_event']) {
      await client.query(
        `UPDATE public.${table}
            SET payload = jsonb_set(payload, '{actor,name}', '"[erased]"')
          WHERE actor::text = $1
            AND payload ? 'actor'
            AND (payload -> 'actor') ? 'name'`,
        [String(u.user_id)],
      );
    }

    await client.query('COMMIT');
    logger.info('[anonymize-user] done', { user_id: u.user_id, live_sessions, audit_rows });
    console.log(`\nDone. User ${u.user_id} anonymised, ${live_sessions} sessions revoked.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('[anonymize-user] failed', { error: err?.message, stack: err?.stack });
    process.exitCode = 1;
  } finally {
    client.release();
    await closePools().catch(() => {});
  }
})();
