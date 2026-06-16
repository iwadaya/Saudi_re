// server/scripts/assignUnderwriters.js
//
// Assigns underwriters to contracts already in the database and records the
// assignment in contract_assignment_history.
//
//   node server/scripts/assignUnderwriters.js                 # only unassigned contracts
//   node server/scripts/assignUnderwriters.js --reassign      # overwrite existing assignments too
//   node server/scripts/assignUnderwriters.js --only-seed     # limit to SEED_ME_TEST contracts
//
// Load is spread round-robin across active underwriters; the largest (top-
// quartile by total NP limit / prop EPI) contracts are steered to senior roles.
// The live schema is introspected; seeded users use the '@seed.test' domain.

import { pool } from '../src/db/pool.js';

const REASSIGN = process.argv.includes('--reassign');
const ONLY_SEED = process.argv.includes('--only-seed');
const SEED_DOMAIN = '@seed.test';

// Target roles to spread seeded underwriters across (matched by name; inserted
// if missing). "Senior" roles (used for the largest contracts) are the first two.
const TARGET_ROLES = [
  { name: 'Chief Underwriter', senior: true, order: 20, limit: 100_000_000 },
  { name: 'Senior Underwriter', senior: true, order: 35, limit: 25_000_000 },
  { name: 'Underwriter', senior: false, order: 40, limit: 10_000_000 },
  { name: 'Pricing Analyst', senior: false, order: 50, limit: 2_000_000 },
];
const SEED_USERS = [
  { display: 'Layla Haddad', role: 'Chief Underwriter' },
  { display: 'Omar Nasser', role: 'Senior Underwriter' },
  { display: 'Yousef Karam', role: 'Underwriter' },
  { display: 'Mona Saleh', role: 'Underwriter' },
  { display: 'Tariq Aziz', role: 'Pricing Analyst' },
];

async function ensureRoles(client) {
  const out = new Map(); // name -> { role_id, senior }
  for (const r of TARGET_ROLES) {
    const { rows } = await client.query(`SELECT role_id FROM public.uw_role WHERE role_name = $1 LIMIT 1`, [r.name]);
    let roleId = rows[0]?.role_id;
    if (!roleId) {
      const ins = await client.query(
        `INSERT INTO public.uw_role (role_name, authority_limit_usd, display_order) VALUES ($1,$2,$3) RETURNING role_id`,
        [r.name, r.limit, r.order]);
      roleId = ins.rows[0].role_id;
      console.log(`  + inserted role ${r.name}`);
    }
    out.set(r.name, { roleId, senior: r.senior });
  }
  return out;
}

async function ensureUnderwriters(client) {
  const roles = await ensureRoles(client);
  const { rows: active } = await client.query(
    `SELECT u.user_id, u.display_name, u.email, r.role_name, COALESCE(r.display_order, 99) AS display_order, COALESCE(r.authority_limit_usd, 0) AS authority
       FROM public.uw_user u JOIN public.uw_role r ON r.role_id = u.role_id
      WHERE u.is_active = true`);
  if (active.length < 6) {
    for (const s of SEED_USERS) {
      const email = `${s.display.toLowerCase().replace(/[^a-z]+/g, '.')}${SEED_DOMAIN}`;
      const role = roles.get(s.role);
      await client.query(
        `INSERT INTO public.uw_user (email, display_name, role_id, is_active, password_hash)
         VALUES ($1,$2,$3,true,'SEEDED_NO_LOGIN') ON CONFLICT (email) DO NOTHING`,
        [email, s.display, role.roleId]);
    }
    console.log(`  + ensured seeded underwriters (${SEED_DOMAIN})`);
  }
  // Re-read the active pool, ordered seniority-first.
  const { rows: pool2 } = await client.query(
    `SELECT u.user_id, u.display_name, r.role_name, COALESCE(r.display_order, 99) AS display_order, COALESCE(r.authority_limit_usd, 0) AS authority
       FROM public.uw_user u JOIN public.uw_role r ON r.role_id = u.role_id
      WHERE u.is_active = true
      ORDER BY r.display_order ASC, u.display_name ASC`);
  const seniorNames = new Set(TARGET_ROLES.filter((r) => r.senior).map((r) => r.name));
  const all = pool2.map((u) => ({ ...u, senior: seniorNames.has(u.role_name) || u.display_order <= 30 }));
  return all;
}

async function main() {
  const t0 = Date.now();
  const client = await pool.connect();
  try {
    console.log('Ensuring active underwriters…');
    const underwriters = await ensureUnderwriters(client);
    if (!underwriters.length) throw new Error('no active underwriters available to assign');
    let seniors = underwriters.filter((u) => u.senior);
    if (!seniors.length) seniors = underwriters; // fall back: treat all as eligible for big ones
    // Assigner = most senior active user (lowest display_order).
    const assigner = underwriters[0];
    console.log(`Pool: ${underwriters.length} underwriters (${seniors.length} senior). Assigner: ${assigner.display_name} (${assigner.role_name}).`);

    // Candidate contracts (+ size) and their current assignee.
    const filters = [];
    if (!REASSIGN) filters.push('c.assigned_to_user_id IS NULL');
    if (ONLY_SEED) filters.push(`c.contract_description = 'SEED_ME_TEST'`);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows: candidates } = await client.query(
      `SELECT c.contract_id, c.assigned_to_user_id, c.created_by_user_id,
              COALESCE(
                (SELECT sum(layer_limit) FROM public.contract_np_layers WHERE contract_id = c.contract_id),
                (SELECT GREATEST(COALESCE(quota_share_epi,0), COALESCE(surplus_epi,0)) FROM public.contract_prop_details WHERE contract_id = c.contract_id),
                0)::numeric AS size
         FROM public.contract c ${where}`);

    const total = await client.query(`SELECT count(*)::int n FROM public.contract`);
    const skipped = total.rows[0].n - candidates.length;
    if (!candidates.length) {
      console.log(`Nothing to assign (${skipped} contracts skipped / already assigned). Use --reassign to overwrite.`);
      return;
    }

    // Top-quartile size threshold → those go to senior underwriters.
    const sizes = candidates.map((c) => Number(c.size)).sort((a, b) => a - b);
    const q75 = sizes[Math.floor(sizes.length * 0.75)] || 0;

    const dist = new Map(underwriters.map((u) => [u.user_id, { name: u.display_name, role: u.role_name, n: 0 }]));
    let allRR = 0; let seniorRR = 0; let assigned = 0; let reassignedRows = 0;

    const BATCH = 200;
    for (let start = 0; start < candidates.length; start += BATCH) {
      await client.query('BEGIN');
      try {
        for (const c of candidates.slice(start, start + BATCH)) {
          const big = Number(c.size) >= q75 && q75 > 0;
          const uw = big ? seniors[seniorRR++ % seniors.length] : underwriters[allRR++ % underwriters.length];
          const prior = c.assigned_to_user_id || null;
          const assignmentType = prior ? 'REASSIGNED' : 'CREATED';

          await client.query(
            `UPDATE public.contract
                SET assigned_to_user_id = $1,
                    created_by_user_id = COALESCE(created_by_user_id, $2),
                    updated_at = now()
              WHERE contract_id = $3`,
            [uw.user_id, c.created_by_user_id || uw.user_id, c.contract_id]);

          await client.query(
            `INSERT INTO public.contract_assignment_history
               (entity_type, entity_id, from_user_id, to_user_id, assigned_by, assignment_type, comment)
             VALUES ('contract', $1, $2, $3, $4, $5, 'Bulk assignment')`,
            [c.contract_id, prior, uw.user_id, assigner.user_id, assignmentType]);

          dist.get(uw.user_id).n += 1;
          assigned += 1;
          if (prior) reassignedRows += 1;
        }
        await client.query('COMMIT');
        process.stdout.write(`  …${Math.min(start + BATCH, candidates.length)}/${candidates.length}\r`);
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    }

    console.log(`\n\n=== ASSIGNMENT SUMMARY (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
    console.log(`Contracts assigned: ${assigned}  (of which reassigned: ${reassignedRows})`);
    console.log(`Skipped (already assigned / out of scope): ${skipped}`);
    console.log(`Top-quartile size threshold (→ senior): ${q75.toLocaleString()}`);
    console.log('Per-underwriter distribution:');
    [...dist.values()].sort((a, b) => b.n - a.n).forEach((d) => {
      if (d.n > 0) console.log(`  ${d.name.padEnd(22)} ${String(d.n).padStart(5)}   (${d.role})`);
    });
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ASSIGN FAILED:', e); process.exitCode = 1; pool.end().catch(() => {}); });
