// server/scripts/seedLoadTestUsers.js
//
// Seed a pool of load-test accounts (loadtest001..loadtestNNN) so k6 can run
// one REAL login per VU without tripping the login brute-force limiter, which
// is keyed per IP + submitted identity (app.js createLoginLimiter, 5 attempts
// per 15 min). A single shared LOAD_USER account caps a run at 5 VUs from one
// address; a pool of distinct usernames keeps every VU at 1 login per identity.
//
// Never run against production: these are fixture accounts with a shared
// password. Local + staging only.
//
// Usage:
//   DATABASE_URL=postgres://… node server/scripts/seedLoadTestUsers.js
//   LOAD_USERS=200 LOAD_PASS=… node server/scripts/seedLoadTestUsers.js
//
// Idempotent: upserts on email, so re-running refreshes password/active state.
//
// Pair with the k6 side (load-test/k6/lib/auth.js):
//   LOAD_USER_PREFIX=loadtest LOAD_USER_COUNT=100 LOAD_PASS=… k6 run …

import pg from 'pg';
import { hashPassword } from '../src/lib/passwordHash.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:postgres@localhost:5432/reinsurance_tool';

const COUNT = Math.max(1, Number(process.env.LOAD_USERS || 100));
const PASSWORD = process.env.LOAD_PASS || 'demo2026';
const PREFIX = process.env.LOAD_USER_PREFIX || 'loadtest';
const PAD = Math.max(1, Number(process.env.LOAD_USER_PAD || 3));

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

async function main() {
  const role = await pool.query(
    "SELECT role_id FROM uw_role WHERE role_code = 'UW' ORDER BY display_order LIMIT 1",
  );
  if (!role.rows.length) {
    throw new Error("No 'UW' role found — run migrations/seeds first.");
  }
  const roleId = role.rows[0].role_id;

  // One hash shared by the whole pool (same fixture password), mirroring how
  // migration 132 provisions the demo personas.
  const hash = await hashPassword(PASSWORD);

  let created = 0;
  let updated = 0;
  // Account 0 (e.g. loadtest000) is reserved for k6's setup()/teardown()
  // context (__VU 0), so a setup login never spends a VU identity's
  // login-limiter budget; VUs use 1..COUNT.
  for (let i = 0; i <= COUNT; i += 1) {
    const username = `${PREFIX}${String(i).padStart(PAD, '0')}`;
    const email = `${username}@loadtest.local`;
    const res = await pool.query(
      `INSERT INTO uw_user (email, username, display_name, role_id, password_hash, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (email) DO UPDATE SET
         username = EXCLUDED.username,
         password_hash = EXCLUDED.password_hash,
         is_active = true,
         failed_attempts = 0,
         locked_until = NULL
       RETURNING (xmax = 0) AS inserted`,
      [email, username, `Load Tester ${String(i).padStart(PAD, '0')}`, roleId, hash],
    );
    if (res.rows[0]?.inserted) created += 1; else updated += 1;
  }

  console.log(`[seed-load-users] pool ready: ${COUNT} VU accounts + setup account (${PREFIX}${'0'.padStart(PAD, '0')}…${PREFIX}${String(COUNT).padStart(PAD, '0')}) — ${created} created, ${updated} refreshed`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('[seed-load-users] failed:', err.message);
    process.exitCode = 1;
    return pool.end();
  });
