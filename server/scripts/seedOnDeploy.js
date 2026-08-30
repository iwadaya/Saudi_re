// server/scripts/seedOnDeploy.js
//
// Deploy-hook seeding: re-populate the treaty test portfolio automatically
// whenever the server is redeployed, gated by SEED_ON_DEPLOY so a deploy
// path can call this unconditionally and production stays clean by default.
//
//   node server/scripts/seedOnDeploy.js        # or: npm run seed:deploy
//
// Wired into both deploy paths:
//   • deploy.sh runs it after the PM2 reload
//   • render.yaml runs it from preDeployCommand, after migrations
//
// SEED_ON_DEPLOY (read from the environment or the .env file):
//   unset | 0 | false | no | off   do nothing — the default, exits 0
//   1 | true | yes | on | if-empty seed only when the database holds no
//                                  seeded treaties yet; a redeploy against an
//                                  already-seeded database is a fast no-op,
//                                  and testers' edits to seeded data survive
//   reset | always                 delete the previous seed and reseed on
//                                  every deploy — the generator is
//                                  deterministic, so the portfolio comes back
//                                  identical unless reference data changed
//
// Setting SEED_ON_DEPLOY on a deployed environment is the deliberate opt-in
// that seedTestTreaties.js's production guard asks for, so this wrapper runs
// it with SEED_ALLOW_PRODUCTION=1; the seed script still prints the
// (password-redacted) target before writing a row.
//
// Run this AFTER migrations: it reads the schema, it never creates it.
// A seed failure exits non-zero so the deploy step fails loudly instead of
// leaving a half-seeded box unnoticed.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';

// Must match the sentinel seedTestTreaties.js stamps into import_metadata.
const SEED_SOURCE = 'seed:test-treaties';
const SEED_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'seedTestTreaties.js');

const OFF = new Set(['', '0', 'false', 'no', 'off']);
const IF_EMPTY = new Set(['1', 'true', 'yes', 'on', 'if-empty']);
const EVERY_DEPLOY = new Set(['reset', 'always']);

// pool.js → config/env.js has already loaded .env by the time this runs, so
// the flag can live in the deployed box's .env file, not just the process env.
const mode = String(process.env.SEED_ON_DEPLOY || '').trim().toLowerCase();

async function seededCount() {
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM public.contract WHERE import_metadata->>'source' = $1`,
      [SEED_SOURCE],
    );
    return rows[0].n;
  } catch (e) {
    if (e.code === '42P01') {
      throw new Error('the contract table does not exist yet — run the migrations before seed:deploy');
    }
    throw e;
  }
}

// 'skip' | 'seed' | 'reseed' | 'bad-flag' — pool queries happen only in here,
// so the caller can close the pool before the (long) child process starts.
async function decide() {
  if (OFF.has(mode)) return { action: 'skip', why: 'SEED_ON_DEPLOY is not set' };
  if (EVERY_DEPLOY.has(mode)) return { action: 'reseed' };
  if (!IF_EMPTY.has(mode)) return { action: 'bad-flag' };
  const existing = await seededCount();
  return existing > 0
    ? { action: 'skip', why: `${existing} seeded contracts already present` }
    : { action: 'seed' };
}

function runSeed(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SEED_SCRIPT, ...args], {
      stdio: 'inherit',
      env: { ...process.env, SEED_ALLOW_PRODUCTION: '1' },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

async function main() {
  let plan;
  try {
    plan = await decide();
  } finally {
    await pool.end();
  }

  switch (plan.action) {
    case 'skip':
      console.log(`seed-on-deploy: ${plan.why} — skipping. `
        + `(SEED_ON_DEPLOY=1 seeds an empty database; SEED_ON_DEPLOY=reset reseeds every deploy.)`);
      return 0;
    case 'bad-flag':
      console.error(`seed-on-deploy: unrecognised SEED_ON_DEPLOY value "${mode}".\n`
        + `  Use 1 (seed only when no seeded treaties exist) or reset (reseed on every deploy).`);
      return 1;
    case 'reseed':
      console.log(`seed-on-deploy: SEED_ON_DEPLOY=${mode} — resetting and reseeding the treaty test portfolio…`);
      return runSeed(['--reset']);
    default:
      console.log('seed-on-deploy: no seeded treaties found — seeding the treaty test portfolio…');
      return runSeed([]);
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    console.error('seed-on-deploy FAILED:', e.message || e);
    process.exitCode = 1;
    pool.end().catch(() => {});
  },
);
