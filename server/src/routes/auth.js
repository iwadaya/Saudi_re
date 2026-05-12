// server/src/routes/auth.js
// Authentication, user management, and mandate resolution
// Demo mode: password 'demo2026' accepted for all users.
// Production: swap DEMO_HASH check for bcrypt.compare(password, user.password_hash)

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { logAudit } from '../services/audit.js';

const router = Router();

// ─── helpers ───────────────────────────────────────────────────────────────
const DEMO_PASSWORD = 'demo2026';

// Static fallback — used when DB tables aren't ready yet (before migrations run)
const DEMO_USERS_FALLBACK = [
  { user_id:'00000000-0000-0000-0000-000000000001', username:'cuo', display_name:'Chief Underwriting Officer', email:'cuo@universe3.app', role_code:'CU', role_name:'Chief Underwriter', hierarchy_level:2, office:'Riyadh', treaty_limit_usd:null, approvals_required:1, is_active:true },
  { user_id:'00000000-0000-0000-0000-000000000002', username:'underwriter', display_name:'Underwriter', email:'uw@universe3.app', role_code:'TUW', role_name:'Underwriter', hierarchy_level:5, office:'Riyadh', treaty_limit_usd:10000000, approvals_required:2, is_active:true },
];

function buildSession(user) {
  return {
    userId:           user.user_id,
    username:         user.username,
    displayName:      user.display_name,
    email:            user.email,
    office:           user.office,
    roleId:           user.role_id,
    roleCode:         user.role_code,
    roleName:         user.role_name,
    hierarchyLevel:   user.hierarchy_level,
    canOverrideBelow: user.can_override_below,
    effectiveLimitUsd:    user.effective_limit_usd,
    singleRiskLimitUsd:   user.single_risk_limit_usd,
    treatyTypeScope:      user.treaty_type_scope || 'BOTH',
    approvalsRequired:    user.approvals_required || 1,
    allowedCobIds:        user.allowed_cob_ids || [],
    restrictedCobIds:     user.restricted_cob_ids || [],
    allowedCountryIds:    user.allowed_country_ids || [],
    isSystemAdmin:        user.is_system_admin || false,
    mandateActive:        user.mandate_active !== false,
  };
}

// ── POST /api/auth/login ───────────────────────────────────────────────────
router.post('/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  // Look up user via username or email (support both)
  // Try v_user_mandate view first, fall back to direct table join if view doesn't exist yet
  let rows = [];
  try {
    const result = await pool.query(
      `SELECT vm.*
       FROM public.v_user_mandate vm
       WHERE (vm.username = $1 OR vm.email = $1)
         AND vm.is_active = true
       LIMIT 1`,
      [String(username).trim().toLowerCase()]
    );
    rows = result.rows;
  } catch (viewErr) {
    // View not yet created — try direct query
    try {
      const result = await pool.query(
        `SELECT u.*, r.role_name, r.role_code, r.hierarchy_level, r.authority_limit_usd,
                r.can_override_below, r.display_order,
                r.authority_limit_usd AS effective_limit_usd,
                NULL AS single_risk_limit_usd, 'BOTH' AS treaty_type_scope,
                1 AS approvals_required, true AS mandate_active
         FROM public.uw_user u
         JOIN public.uw_role r ON r.role_id = u.role_id
         WHERE (u.username = $1 OR u.email = $1) AND u.is_active = true
         LIMIT 1`,
        [String(username).trim().toLowerCase()]
      );
      rows = result.rows;
    } catch (tableErr) {
      // Tables don't exist yet — check static demo users
      const lc = String(username).trim().toLowerCase();
      const demo = DEMO_USERS_FALLBACK.find(u => u.username === lc || u.email === lc);
      if (demo && password === DEMO_PASSWORD) {
        return res.json({ session: {
          userId: demo.user_id, username: demo.username, displayName: demo.display_name,
          email: demo.email, office: demo.office, roleId: demo.user_id,
          roleCode: demo.role_code, roleName: demo.role_name,
          hierarchyLevel: demo.hierarchy_level, canOverrideBelow: demo.hierarchy_level <= 3,
          effectiveLimitUsd: demo.treaty_limit_usd, singleRiskLimitUsd: null,
          treatyTypeScope: 'BOTH', approvalsRequired: demo.approvals_required || 1,
          allowedCobIds: [], restrictedCobIds: [], allowedCountryIds: [],
          isSystemAdmin: false, mandateActive: true,
        }});
      }
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
  }

  if (!rows.length) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const user = rows[0];

  // Account lock check
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(403).json({
      error: `Account locked until ${new Date(user.locked_until).toISOString()}. Contact your administrator.`,
    });
  }

  // Password check.
  //
  // Demo mode: every seeded user has password_hash='DEMO_HASH_2026' and
  // logs in with DEMO_PASSWORD. This is intentional for the testing
  // build — bcrypt is not yet wired up — and is checked uniformly for
  // every account so it is obvious we are not silently bypassing a
  // real-hash branch. When real auth lands, replace this block with
  // `await bcrypt.compare(password, user.password_hash)` and remove
  // the DEMO_HASH_2026 seed in the user-create path.
  const passwordOk = password === DEMO_PASSWORD;

  if (!passwordOk) {
    // Increment failed attempts (fire-and-forget)
    pool.query(
      `UPDATE public.uw_user SET failed_attempts = failed_attempts + 1,
        locked_until = CASE WHEN failed_attempts >= 4 THEN now() + interval '15 minutes' ELSE locked_until END,
        updated_at = now()
       WHERE user_id = $1`,
      [user.user_id]
    ).catch(() => {});
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  // Reset failed attempts on success
  pool.query(
    `UPDATE public.uw_user SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
     WHERE user_id = $1`,
    [user.user_id]
  ).catch(() => {});

  await logAudit(pool, {
    entityType: 'USER', entityId: user.user_id,
    eventType: 'LOGIN', actor: user.username || user.email,
    payload: { office: user.office },
  }).catch(() => {});

  res.json({ session: buildSession(user) });
}));

// ── GET /api/auth/me — refresh session from server ─────────────────────────
router.get('/auth/me', asyncHandler(async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  const { rows } = await pool.query(
    `SELECT * FROM public.v_user_mandate WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId]
  );
  if (!rows.length) return res.status(401).json({ error: 'User not found or inactive.' });

  res.json({ session: buildSession(rows[0]) });
}));

// ── GET /api/auth/users — list all users
// Safe fields only; login screen uses this to populate the user selector
router.get('/auth/users', asyncHandler(async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         u.user_id, u.username,
         REPLACE(u.display_name, 'Treaty Underwriter', 'Underwriter') AS display_name,
         u.email, u.office,
         u.is_active,
         REPLACE(r.role_name, 'Treaty Underwriter', 'Underwriter') AS role_name,
         r.role_code, r.hierarchy_level, r.authority_limit_usd,
         m.treaty_limit_usd, m.single_risk_limit_usd, m.treaty_type_scope,
         m.approvals_required
       FROM public.uw_user u
       JOIN public.uw_role r ON r.role_id = u.role_id
       LEFT JOIN public.user_mandate m ON m.user_id = u.user_id
       WHERE u.is_active = true
       ORDER BY r.hierarchy_level, u.display_name`
    );
    if (rows.length) return res.json(rows);
    // No users yet — return static demo fallback
    return res.json(DEMO_USERS_FALLBACK);
  } catch (e) {
    // Tables not yet created — return static demo fallback so login screen works
    logger.warn('auth/users: DB tables not ready, using fallback', { error: e.message.split('\n')[0] });
    return res.json(DEMO_USERS_FALLBACK);
  }
}));

// ── GET /api/auth/roles — list roles for dropdowns ────────────────────────
router.get('/auth/roles', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT role_id, role_name, role_code, hierarchy_level, authority_limit_usd, display_order
     FROM public.uw_role ORDER BY display_order`
  );
  res.json(rows);
}));

// ── POST /api/auth/users — create new user ────────────────────────────────
router.post('/auth/users', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { username, display_name, email, role_id, office, phone, company_id } = b;

  if (!username || !display_name || !email || !role_id) {
    return res.status(400).json({ error: 'username, display_name, email and role_id are required.' });
  }

  // Check caller has authority to create users (hierarchy_level <= 2)
  const callerUserId = req.headers['x-user-id'];
  const { rows: callerRows } = await pool.query(
    `SELECT r.hierarchy_level FROM public.uw_user u JOIN public.uw_role r ON r.role_id = u.role_id WHERE u.user_id = $1`,
    [callerUserId]
  );
  if (!callerRows.length || callerRows[0].hierarchy_level > 2) {
    return res.status(403).json({ error: 'Only Chief Underwriter or Chief Executive can create users.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO public.uw_user
       (username, display_name, email, role_id, office, phone, company_id, password_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'DEMO_HASH_2026')
     RETURNING user_id, username, display_name, email, role_id, office, created_at`,
    [username.trim(), display_name.trim(), email.trim().toLowerCase(),
     role_id, office || 'Riyadh', phone || null, company_id || null]
  );

  // Create default mandate
  await pool.query(
    `INSERT INTO public.user_mandate (user_id, treaty_type_scope, approvals_required)
     VALUES ($1, 'BOTH', 1) ON CONFLICT (user_id) DO NOTHING`,
    [rows[0].user_id]
  );

  await logAudit(pool, {
    entityType: 'USER', entityId: rows[0].user_id,
    eventType: 'USER_CREATED', actor: req.headers['x-user-name'] || 'ADMIN',
    payload: { username, role_id },
  }).catch(() => {});

  res.status(201).json(rows[0]);
}));

// ── PATCH /api/auth/users/:id — update user ───────────────────────────────
router.patch('/auth/users/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  const fields = [];
  const params = [];
  let i = 1;

  const allowed = ['display_name', 'email', 'role_id', 'office', 'phone', 'is_active', 'company_id'];
  for (const key of allowed) {
    if (b[key] !== undefined) {
      fields.push(`${key} = $${i++}`);
      params.push(b[key]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update.' });

  fields.push(`updated_at = now()`);
  params.push(id);

  const { rows } = await pool.query(
    `UPDATE public.uw_user SET ${fields.join(', ')} WHERE user_id = $${i} RETURNING user_id, display_name, email, role_id, office, is_active`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found.' });
  res.json(rows[0]);
}));

// ── GET /api/auth/mandates/:userId — get full mandate for a user ───────────
router.get('/auth/mandates/:userId', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM public.v_user_mandate WHERE user_id = $1 LIMIT 1`,
    [req.params.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found.' });
  res.json(rows[0]);
}));

// ── PUT /api/auth/mandates/:userId — set/update mandate for a user ─────────
router.put('/auth/mandates/:userId', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { userId } = req.params;

  const { rows } = await pool.query(
    `INSERT INTO public.user_mandate
       (user_id, treaty_limit_usd, single_risk_limit_usd, limit_currency,
        allowed_cob_ids, restricted_cob_ids, allowed_country_ids,
        treaty_type_scope, approvals_required, effective_from, effective_to, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (user_id) DO UPDATE SET
       treaty_limit_usd      = EXCLUDED.treaty_limit_usd,
       single_risk_limit_usd = EXCLUDED.single_risk_limit_usd,
       limit_currency        = EXCLUDED.limit_currency,
       allowed_cob_ids       = EXCLUDED.allowed_cob_ids,
       restricted_cob_ids    = EXCLUDED.restricted_cob_ids,
       allowed_country_ids   = EXCLUDED.allowed_country_ids,
       treaty_type_scope     = EXCLUDED.treaty_type_scope,
       approvals_required    = EXCLUDED.approvals_required,
       effective_from        = EXCLUDED.effective_from,
       effective_to          = EXCLUDED.effective_to,
       notes                 = EXCLUDED.notes,
       updated_at            = now()
     RETURNING *`,
    [
      userId,
      b.treaty_limit_usd ?? null,
      b.single_risk_limit_usd ?? null,
      b.limit_currency || 'USD',
      b.allowed_cob_ids || [],
      b.restricted_cob_ids || [],
      b.allowed_country_ids || [],
      b.treaty_type_scope || 'BOTH',
      b.approvals_required ?? 1,
      b.effective_from || new Date().toISOString().slice(0, 10),
      b.effective_to || null,
      b.notes || null,
      req.headers['x-user-id'] || null,
    ]
  );

  await logAudit(pool, {
    entityType: 'USER_MANDATE', entityId: userId,
    eventType: 'MANDATE_UPDATED', actor: req.headers['x-user-name'] || 'ADMIN',
    payload: b,
  }).catch(() => {});

  res.json(rows[0]);
}));

// ── GET /api/auth/mandate-check — can this user offer a treaty? ─────────────
// Query params: contract_id OR quote_id, plus epi_usd (optional if server can compute)
router.get('/auth/mandate-check', asyncHandler(async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { contract_id, quote_id, epi_usd, cob_ids } = req.query;

  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  // Load user mandate
  const { rows: mandateRows } = await pool.query(
    `SELECT * FROM public.v_user_mandate WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (!mandateRows.length) return res.status(404).json({ error: 'User not found.' });
  const m = mandateRows[0];

  // If neither provided, just return mandate info
  if (!contract_id && !quote_id && !epi_usd) {
    return res.json({ allowed: true, mandate: buildMandateInfo(m), reasons: [] });
  }

  const reasons = [];
  let resolvedEpiUsd = epi_usd ? Number(epi_usd) : null;

  // If contract_id provided, compute EPI in USD from DB
  if (contract_id && !resolvedEpiUsd) {
    const { rows: epiRows } = await pool.query(
      `SELECT
         COALESCE(cpd.estimated_premium_income, 0)  AS epi,
         COALESCE(er.rate_to_usd, 1)                AS fx,
         cur.currency_code
       FROM public.contract c
       LEFT JOIN public.contract_prop_details cpd ON cpd.contract_id = c.contract_id
       LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
       LEFT JOIN public.exchange_rate er ON er.currency_code = cur.currency_code
       WHERE c.contract_id = $1`,
      [contract_id]
    );
    if (epiRows.length) {
      const r = epiRows[0];
      resolvedEpiUsd = (Number(r.epi) || 0) * (Number(r.fx) || 1);
    }
  }

  // Check treaty type scope
  if (contract_id) {
    const { rows: typeRows } = await pool.query(
      `SELECT tt.category FROM public.contract c JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id WHERE c.contract_id = $1`,
      [contract_id]
    );
    if (typeRows.length) {
      const isNP = String(typeRows[0].category || '').toUpperCase().includes('NON');
      if (isNP && m.treaty_type_scope === 'PROP_ONLY') {
        reasons.push('Your mandate covers proportional treaties only. This is a non-proportional treaty.');
      }
      if (!isNP && m.treaty_type_scope === 'NP_ONLY') {
        reasons.push('Your mandate covers non-proportional treaties only. This is a proportional treaty.');
      }
    }
  }

  // Check authority limit
  if (resolvedEpiUsd && m.effective_limit_usd !== null) {
    if (resolvedEpiUsd > Number(m.effective_limit_usd)) {
      reasons.push(
        `Treaty EPI (USD ${(resolvedEpiUsd / 1e6).toFixed(1)}M) exceeds your authority limit (USD ${(Number(m.effective_limit_usd) / 1e6).toFixed(1)}M). Escalate to ${nextRoleName(m.hierarchy_level)}.`
      );
    }
  }

  // Check COB restrictions
  const cobList = cob_ids ? String(cob_ids).split(',').filter(Boolean) : [];
  if (m.restricted_cob_ids && m.restricted_cob_ids.length && cobList.length) {
    const blocked = cobList.filter(id => m.restricted_cob_ids.includes(id));
    if (blocked.length) {
      reasons.push(`One or more lines of business require Chief Underwriter or Chief Executive sign-off.`);
    }
  }

  // Check COB authority requirements from cob_authority_requirement table
  if (cobList.length) {
    const { rows: cobAuthRows } = await pool.query(
      `SELECT c.class_of_business_id, c.min_hierarchy_level, c.requires_dual_approval, cb.class_name
       FROM public.cob_authority_requirement c
       JOIN public.class_of_business cb ON cb.class_of_business_id = c.class_of_business_id
       WHERE c.class_of_business_id = ANY($1::uuid[])
         AND c.min_hierarchy_level < $2`,
      [cobList, m.hierarchy_level]
    );
    for (const row of cobAuthRows) {
      reasons.push(
        `Class "${row.class_name}" requires ${nextRoleName(row.min_hierarchy_level - 1)} authority or above.`
      );
    }
  }

  res.json({
    allowed: reasons.length === 0,
    reasons,
    mandate: buildMandateInfo(m),
    resolvedEpiUsd,
    approvalsRequired: m.approvals_required,
  });
}));

function buildMandateInfo(m) {
  return {
    roleName: m.role_name,
    roleCode: m.role_code,
    hierarchyLevel: m.hierarchy_level,
    effectiveLimitUsd: m.effective_limit_usd,
    singleRiskLimitUsd: m.single_risk_limit_usd,
    treatyTypeScope: m.treaty_type_scope,
    approvalsRequired: m.approvals_required,
    mandateActive: m.mandate_active,
  };
}

function nextRoleName(currentLevel) {
  const map = { 5: 'Treaty Manager', 4: 'Treaty Director', 3: 'Chief Underwriter', 2: 'Chief Executive', 1: 'Chief Executive' };
  return map[currentLevel] || 'a higher authority';
}

export default router;