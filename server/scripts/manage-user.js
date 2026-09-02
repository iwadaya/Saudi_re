// server/scripts/manage-user.js — operator CLI for user accounts.
//
// Used at deploy time to rotate the seeded demo credentials and to unlock or
// reset a user without touching the database by hand. Every action revokes the
// user's live sessions (epoch bump + auth_session rows) and writes an audit_log
// row with actor 'OPS_CLI', so the trail shows who did what and when.
//
// Usage (run from server/, or via `npm run user:manage -- …` from the root):
//   node scripts/manage-user.js list
//   node scripts/manage-user.js set-password <username|email> [--must-change]
//   node scripts/manage-user.js deactivate   <username|email>
//   node scripts/manage-user.js activate     <username|email>
//
// set-password reads the new password from the NEW_PASSWORD environment
// variable, or prompts for it (hidden) on an interactive terminal. It applies
// the same strength policy as the app (>= 12 chars, not the seeded temp, not a
// common value). --must-change forces the user to choose their own password on
// first login (recommended when resetting someone else's account).
//
// DATABASE_URL comes from the environment or the repo-root .env, exactly as for
// the server itself.

import { createInterface } from 'node:readline';
import { pool, closePools } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/passwordHash.js';
import { validatePasswordStrength } from '../src/routes/auth.js';
import { revokeAllForUser } from '../src/services/sessions.js';

const [command, target, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));

function usage(code = 2) {
  console.error([
    'Usage:',
    '  node scripts/manage-user.js list',
    '  node scripts/manage-user.js set-password <username|email> [--must-change]',
    '  node scripts/manage-user.js deactivate   <username|email>',
    '  node scripts/manage-user.js activate     <username|email>',
    '',
    'set-password takes the password from $NEW_PASSWORD or prompts for it.',
  ].join('\n'));
  process.exit(code);
}

async function promptHidden(question) {
  if (!process.stdin.isTTY) {
    throw new Error('No terminal for a hidden prompt — set NEW_PASSWORD in the environment instead.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const originalWrite = rl._writeToOutput;
  rl._writeToOutput = function muted(str) {
    // Echo the prompt, then swallow the typed characters.
    if (str.startsWith(question)) originalWrite.call(rl, question);
  };
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

async function findUser(client, needle) {
  const { rows } = await client.query(
    `SELECT u.user_id, u.username, u.email, u.display_name, u.is_active, u.must_change_password,
            u.locked_until, r.role_code, r.role_name
       FROM public.uw_user u
       JOIN public.uw_role r ON r.role_id = u.role_id
      WHERE lower(u.username) = lower($1) OR lower(u.email) = lower($1) OR u.user_id::text = $1
      FOR UPDATE OF u`,
    [String(needle).trim()],
  );
  if (!rows.length) throw new Error(`No user matches "${needle}" (tried username, email, user_id).`);
  if (rows.length > 1) throw new Error(`"${needle}" is ambiguous (${rows.length} matches) — use the user_id.`);
  return rows[0];
}

async function audit(client, user, eventType, payload) {
  await client.query(
    `INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor, payload)
     VALUES ('USER', $1, $2, 'OPS_CLI', $3::jsonb)`,
    [user.user_id, eventType, JSON.stringify({
      actor: { name: 'OPS_CLI', via: 'scripts/manage-user.js', os_user: process.env.SUDO_USER || process.env.USER || null },
      username: user.username,
      ...payload,
    })],
  );
}

async function list() {
  const { rows } = await pool.query(
    `SELECT u.username, u.display_name, r.role_code, u.is_active, u.must_change_password,
            u.locked_until, u.last_login_at, u.password_changed_at
       FROM public.uw_user u
       JOIN public.uw_role r ON r.role_id = u.role_id
      ORDER BY r.hierarchy_level, u.username`,
  );
  const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '-');
  const header = ['username', 'display_name', 'role', 'active', 'must_change', 'locked_until', 'last_login', 'pw_changed'];
  const lines = rows.map((u) => [
    u.username || '-', u.display_name, u.role_code, u.is_active ? 'yes' : 'NO',
    u.must_change_password ? 'yes' : 'no', fmt(u.locked_until), fmt(u.last_login_at), fmt(u.password_changed_at),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  const row = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(row(header));
  console.log(row(widths.map((w) => '-'.repeat(w))));
  for (const l of lines) console.log(row(l));
  console.log(`\n${rows.length} user(s).`);
}

async function withUserTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await findUser(client, target);
    await fn(client, user);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function setPassword() {
  let password = process.env.NEW_PASSWORD;
  if (!password) {
    password = await promptHidden('New password: ');
    const confirm = await promptHidden('Confirm password: ');
    if (password !== confirm) throw new Error('Passwords do not match.');
  }
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);
  const mustChange = flags.has('--must-change');
  const hash = await hashPassword(password);

  await withUserTransaction(async (client, user) => {
    await client.query(
      `UPDATE public.uw_user
          SET password_hash = $2, password_changed_at = now(), must_change_password = $3,
              failed_attempts = 0, locked_until = NULL, updated_at = now()
        WHERE user_id = $1`,
      [user.user_id, hash, mustChange],
    );
    const revoked = await revokeAllForUser(user.user_id, 'PASSWORD_CHANGE', client);
    await audit(client, user, 'PASSWORD_RESET', { must_change_password: mustChange, sessions_revoked: revoked });
    console.log(`Password set for ${user.username} (${user.role_code}). ${revoked} live session(s) revoked.`
      + (mustChange ? ' User must choose a new password on next login.' : ''));
    if (!user.is_active) console.log('Note: this account is INACTIVE — run `activate` if they should be able to log in.');
  });
}

async function setActive(active) {
  await withUserTransaction(async (client, user) => {
    if (user.is_active === active) {
      console.log(`${user.username} is already ${active ? 'active' : 'inactive'} — nothing to do.`);
      return;
    }
    if (!active) {
      const { rows: [{ n }] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM public.uw_user u JOIN public.uw_role r ON r.role_id = u.role_id
          WHERE u.is_active = true AND r.hierarchy_level <= 2 AND u.user_id <> $1`,
        [user.user_id],
      );
      if (user.role_code && n === 0) {
        throw new Error(`Refusing to deactivate ${user.username}: it is the last active admin-level account (level <= 2). Create another first.`);
      }
    }
    await client.query(
      `UPDATE public.uw_user SET is_active = $2, updated_at = now() WHERE user_id = $1`,
      [user.user_id, active],
    );
    const revoked = active ? 0 : await revokeAllForUser(user.user_id, 'DEACTIVATED', client);
    await audit(client, user, active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', { sessions_revoked: revoked });
    console.log(`${user.username} ${active ? 'activated' : 'deactivated'}.${active ? '' : ` ${revoked} live session(s) revoked.`}`);
  });
}

(async () => {
  try {
    switch (command) {
      case 'list':
        await list();
        break;
      case 'set-password':
        if (!target) usage();
        await setPassword();
        break;
      case 'deactivate':
        if (!target) usage();
        await setActive(false);
        break;
      case 'activate':
        if (!target) usage();
        await setActive(true);
        break;
      case undefined:
      case '--help':
      case '-h':
        usage(command ? 0 : 2);
        break;
      default:
        console.error(`Unknown command "${command}".`);
        usage();
    }
  } catch (err) {
    console.error(`manage-user: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closePools().catch(() => {});
  }
})();
