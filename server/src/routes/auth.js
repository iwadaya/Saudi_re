// server/src/routes/auth.js
// Authentication, user management, and mandate resolution
// Demo mode: password 'demo2026' accepted for all users.
// Production: swap DEMO_HASH check for bcrypt.compare(password, user.password_hash)

import { Router } from 'express';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { logAudit } from '../services/audit.js';
import { signAuthToken } from '../lib/authToken.js';
import { requireMinLevel } from '../middleware/requestContext.js';

const router = Router();

// Public auth endpoints (no identity needed): login, the login-screen lookups,
// and user creation (which self-gates open-registration vs authenticated CU/CE).
// Everything else under /auth (e.g. /auth/me, mandates) requires a real
// identity — authenticate() has already run and set req.user.
const PUBLIC_AUTH = new Set([
  'POST /auth/login',
  'GET /auth/users',
  'GET /auth/roles',
  'POST /auth/users',
]);
router.use((req, res, next) => {
  if (PUBLIC_AUTH.has(`${req.method} ${req.path}`)) return next();
  if (req.user) return next();
  return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
});

// ─── helpers ───────────────────────────────────────────────────────────────
const DEMO_PASSWORD = 'demo2026';

// Password hashing with the Node stdlib (no new dependency). Format:
//   scrypt$<saltHex>$<hashHex>
// Demo/seeded accounts keep the legacy 'DEMO_HASH_2026' sentinel and log in
// with DEMO_PASSWORD; real accounts created through the Add-user flow get a
// scrypt hash and are verified against it.
export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  let actual;
  try { actual = scryptSync(String(plain), saltHex, 64); } catch { return false; }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Open (login-screen) registration is allowed only when explicitly enabled —
// default ON in dev/test, OFF in production unless the env says otherwise.
// render.yaml pins ALLOW_OPEN_REGISTRATION=false for the prod service.
function openRegistrationEnabled() {
  const flag = process.env.ALLOW_OPEN_REGISTRATION;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}


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
      // Tables don't exist yet — check static demo users (dev/test only).
      if (process.env.ALLOW_DEMO_AUTH !== 'true') {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
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
          token: signAuthToken({ sub: demo.user_id }),
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
  //   • Real accounts carry a scrypt hash ('scrypt$...') and are verified
  //     against it — this is the ONLY path accepted in production.
  //   • The universal DEMO_PASSWORD shortcut is a dev/test backdoor and is
  //     honoured ONLY when ALLOW_DEMO_AUTH=true (never in production).
  const storedHash = user.password_hash;
  const demoAuthAllowed = process.env.ALLOW_DEMO_AUTH === 'true';
  const passwordOk = (demoAuthAllowed && password === DEMO_PASSWORD)
    || (typeof storedHash === 'string' && storedHash.startsWith('scrypt$') && verifyPassword(password, storedHash));

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

  // Issue a signed token carrying only the user id; role/level are re-read from
  // the DB on every request, so the token can't preserve elevated rights.
  res.json({ session: { ...buildSession(user), token: signAuthToken({ sub: user.user_id }) } });
}));

// ── GET /api/auth/me — refresh session from the verified token ─────────────
router.get('/auth/me', asyncHandler(async (req, res) => {
  // req.user is set by authenticate() from the bearer token (DB-backed).
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });

  const { rows } = await pool.query(
    `SELECT * FROM public.v_user_mandate WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [req.user.userId]
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
       ORDER BY u.display_name`
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
// Accepts two payload shapes:
//   • Add-user form (login screen): first_name, surname, title (role_code) OR
//     role_id, password, confirm_password. Composes display_name, derives
//     username/email, and stores a real scrypt password hash.
//   • Legacy admin form: username, display_name, email, role_id (DEMO hash).
router.post('/auth/users', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const isFormPayload = b.first_name != null || b.surname != null || b.password != null;

  // ── Caller gate ──
  // Authenticated creates require Chief Underwriter / Chief Executive
  // (hierarchy_level <= 2), read from the VERIFIED token identity (never a
  // header). With no identity it's an open (login-screen) create, allowed only
  // when test registration is enabled.
  if (req.user) {
    if (Number(req.user.hierarchyLevel) > 2) {
      return res.status(403).json({ error: 'Only Chief Underwriter or Chief Executive can create users.', code: 'FORBIDDEN' });
    }
  } else if (!openRegistrationEnabled()) {
    return res.status(403).json({ error: 'Open registration is disabled.' });
  }

  let displayName, finalUsername, finalEmail, roleId, passwordHash;

  if (isFormPayload) {
    const first = String(b.first_name || '').trim();
    const last  = String(b.surname || '').trim();
    const password = b.password;
    const roleCode = b.title || b.role_code || null;
    roleId = b.role_id || null;

    // Validate
    if (!first || !last) return res.status(400).json({ error: 'first_name and surname are required.' });
    if (!roleId && !roleCode) return res.status(400).json({ error: 'A role (title) is required.' });
    if (!password) return res.status(400).json({ error: 'password is required.' });
    if (password !== b.confirm_password) return res.status(400).json({ error: 'Passwords do not match' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    // Resolve role_id from title/role_code when not supplied directly.
    if (!roleId) {
      const { rows: roleRows } = await pool.query(
        `SELECT role_id FROM public.uw_role WHERE role_code = $1 LIMIT 1`, [roleCode]
      );
      if (!roleRows.length) return res.status(400).json({ error: `Unknown role/title "${roleCode}".` });
      roleId = roleRows[0].role_id;
    }

    displayName = `${first} ${last}`;

    // Username: supplied, else first.surname deduped with a numeric suffix.
    if (b.username) {
      finalUsername = String(b.username).trim().toLowerCase();
    } else {
      const base = `${first}.${last}`.toLowerCase().replace(/[^a-z0-9.]+/g, '');
      finalUsername = base;
      let n = 1;
      while (true) {
        const { rows: dup } = await pool.query(
          `SELECT 1 FROM public.uw_user WHERE username = $1 LIMIT 1`, [finalUsername]
        );
        if (!dup.length) break;
        n += 1;
        finalUsername = `${base}${n}`;
      }
    }
    finalEmail = b.email ? String(b.email).trim().toLowerCase() : `${finalUsername}@universe3.app`;
    passwordHash = hashPassword(password);
  } else {
    // Legacy admin payload.
    const { username, display_name, email, role_id } = b;
    if (!username || !display_name || !email || !role_id) {
      return res.status(400).json({ error: 'username, display_name, email and role_id are required.' });
    }
    displayName = display_name.trim();
    finalUsername = username.trim();
    finalEmail = email.trim().toLowerCase();
    roleId = role_id;
    passwordHash = 'DEMO_HASH_2026';
  }

  const { rows } = await pool.query(
    `INSERT INTO public.uw_user
       (username, display_name, email, role_id, office, phone, company_id, password_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING user_id, username, display_name, email, role_id, office, password_hash, created_at`,
    [finalUsername, displayName, finalEmail, roleId, b.office || 'Riyadh', b.phone || null, b.company_id || null, passwordHash]
  );

  // Create default mandate
  await pool.query(
    `INSERT INTO public.user_mandate (user_id, treaty_type_scope, approvals_required)
     VALUES ($1, 'BOTH', 1) ON CONFLICT (user_id) DO NOTHING`,
    [rows[0].user_id]
  );

  await logAudit(pool, {
    entityType: 'USER', entityId: rows[0].user_id,
    eventType: 'USER_CREATED', actor: req.user?.displayName || (req.user ? 'ADMIN' : 'SELF_REGISTRATION'),
    payload: { username: finalUsername, role_id: roleId, open_registration: !req.user },
  }).catch(() => {});

  res.status(201).json(rows[0]);
}));

// ── PATCH /api/auth/users/:id — update user ───────────────────────────────
router.patch('/auth/users/:id', requireMinLevel(2), asyncHandler(async (req, res) => {
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
  // Identity from the verified token. A user may read their OWN mandate;
  // reading anyone else's requires Chief Underwriter / Chief Executive (<=2).
  const callerId = req.user?.userId;
  const target = req.params.userId;
  if (target !== callerId && Number(req.user?.hierarchyLevel) > 2) {
    return res.status(403).json({ error: 'You may only view your own mandate.', code: 'FORBIDDEN' });
  }
  const { rows } = await pool.query(
    `SELECT * FROM public.v_user_mandate WHERE user_id = $1 LIMIT 1`,
    [target]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found.' });
  res.json(rows[0]);
}));

// ── PUT /api/auth/mandates/:userId — set/update mandate for a user ─────────
router.put('/auth/mandates/:userId', requireMinLevel(2), asyncHandler(async (req, res) => {
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
      req.user?.userId || null,
    ]
  );

  await logAudit(pool, {
    entityType: 'USER_MANDATE', entityId: userId,
    eventType: 'MANDATE_UPDATED', actor: req.user?.displayName || req.user?.userId || 'ADMIN',
    payload: b,
  }).catch(() => {});

  res.json(rows[0]);
}));

// ── GET /api/auth/mandate-check — can this user offer a treaty? ─────────────
// Query params: contract_id OR quote_id, plus epi_usd (optional if server can compute)
router.get('/auth/mandate-check', asyncHandler(async (req, res) => {
  // Always the CALLER's own mandate, from the verified token — never a header
  // or a client-supplied id, so one user can't probe another's authority.
  const userId = req.user?.userId;
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
      `SELECT c.class_of_business_id, c.min_hierarchy_level, c.requires_dual_approval, cb.class_of_business AS class_name
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