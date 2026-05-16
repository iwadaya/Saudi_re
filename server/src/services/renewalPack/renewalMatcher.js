// Renewal matcher: given the extracted (cedant name, classes, latest UW
// year) from a renewal pack, find whether this maps to an existing
// treaty/contract — and if so, whether it's a renewal of one.
//
// Why fuzzy: cedant names drift year-to-year. "Al Rajhi Takaful" one
// year becomes "Al Rajhi Coop Ins" the next, or a typo creeps in
// ("Saudi Re" vs "Saudi Re Cooperative"). Strict equality fails. We
// pass a match if EITHER:
//   • Levenshtein distance ≤ 3  (handles typos)
//   • token-set Dice ≥ 0.85 on cleaned tokens (handles legal-form drift)
// either of which is forgiving enough for these inputs without
// matching unrelated companies.
//
// Output modes:
//   • renewal  — exactly one confident match AND the pack's latest UW
//                year is later than the matched contract's latest year
//                (= a new year of the same treaty).
//   • new      — zero matches.
//   • ambiguous — more than one candidate. Caller asks the user to pick.
//
// DB access is injected via opts.runQuery so the unit tests can run
// without a pg connection. The default runQuery uses the shared pool.

import { pool } from '../../db/pool.js';

// ── public API ───────────────────────────────────────────────────────────────

/**
 * @typedef {object} MatchInput
 * @property {string|null} cedantName
 * @property {string[]}    classes      - free-text class names from extraction
 * @property {number|null} uwYearEnd    - end of extracted uwYearRange (latest year)
 *
 * @typedef {object} MatchCandidate
 * @property {string} id                - contract_id
 * @property {string} cedant            - matched company name
 * @property {string} treatyName        - contract description / treaty type
 * @property {number} lastUwYear        - MAX(uw_year) for that cedant + (any class) group
 * @property {string|null} priorQuoteId - bound quote_id if the contract has one
 * @property {number} score             - max(1 - lev/maxLen, dice) — for sorting
 *
 * @typedef {{ mode: 'new' }
 *   | { mode: 'renewal', priorTreatyId: string, priorQuoteId: string|null, candidate: MatchCandidate }
 *   | { mode: 'ambiguous', candidates: MatchCandidate[] }} MatchResult
 *
 * @param {MatchInput} input
 * @param {object}    [opts]
 * @param {(text: string, params?: any[]) => Promise<{rows: any[]}>} [opts.runQuery]
 * @returns {Promise<MatchResult>}
 */
export async function findRenewalMatch(input, opts = {}) {
  const { cedantName, classes = [], uwYearEnd } = input;
  const runQuery = opts.runQuery || ((sql, params) => pool.query(sql, params));

  // Without a cedant name we can't fuzz-match anything reliably; bail
  // to "new" rather than producing false positives.
  if (!cedantName || typeof cedantName !== 'string') return { mode: 'new' };

  const candidates = await collectCandidates({ cedantName, classes, runQuery });
  if (candidates.length === 0) return { mode: 'new' };

  if (candidates.length === 1) {
    const c = candidates[0];
    const isLater = uwYearEnd != null && Number.isFinite(uwYearEnd) && c.lastUwYear < uwYearEnd;
    if (isLater) {
      return {
        mode: 'renewal',
        priorTreatyId: c.id,
        priorQuoteId: c.priorQuoteId,
        candidate: c,
      };
    }
    // Single match but no forward progression in years — surface it as
    // ambiguous so the underwriter can decide ("same year resubmission?
    // amendment? duplicate import?").
    return { mode: 'ambiguous', candidates };
  }

  return { mode: 'ambiguous', candidates };
}

// ── candidate collection ─────────────────────────────────────────────────────

async function collectCandidates({ cedantName, classes, runQuery }) {
  // Pull every contract with its cedant + class names. The matching is
  // done in-process: doing fuzzy in SQL would need pg_trgm (not assumed
  // present) and we'd need to ship the same JS heuristics anyway for
  // parity with the tests. The candidate set is small (one cedant
  // family at most), so the in-process pass is cheap.
  const { rows } = await runQuery(
    `SELECT
        c.contract_id                       AS id,
        co.company_name                     AS cedant_name,
        c.contract_description              AS treaty_name,
        tt.treaty_type                      AS treaty_type_name,
        c.uw_year                           AS uw_year,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT cob.class_of_business), NULL) AS class_names,
        q.quote_id                          AS prior_quote_id
       FROM public.contract c
       LEFT JOIN public.companies co               ON co.company_id = c.cedant_id
       LEFT JOIN public.treaty_type tt             ON tt.treaty_type_id = c.treaty_type_id
       LEFT JOIN public.contract_class_of_business cxb
              ON cxb.contract_id = c.contract_id
       LEFT JOIN public.class_of_business cob
              ON cob.class_of_business_id = cxb.class_of_business_id
       LEFT JOIN public.quote q
              ON q.bound_contract_id = c.contract_id
      WHERE co.company_name IS NOT NULL
      GROUP BY c.contract_id, co.company_name, c.contract_description,
               tt.treaty_type, c.uw_year, q.quote_id`,
  );

  const wantTokens = classTokenSet(classes);

  // Group by cedant_id (id-of-id is the company name string here since
  // we don't have it in the result; collapse by name). We want the
  // latest contract per matched cedant.
  const byCedant = new Map();
  for (const row of rows) {
    const candidateName = row.cedant_name;
    const m = nameMatch(cedantName, candidateName);
    if (!m.matched) continue;
    // optional class filter: if user gave classes, at least one must overlap
    if (wantTokens.size > 0 && Array.isArray(row.class_names) && row.class_names.length > 0) {
      const candTokens = classTokenSet(row.class_names);
      const overlap = setsIntersect(wantTokens, candTokens);
      if (!overlap) continue;
    }
    const existing = byCedant.get(candidateName);
    const candidate = {
      id: row.id,
      cedant: candidateName,
      treatyName: row.treaty_name || row.treaty_type_name || '',
      lastUwYear: Number(row.uw_year) || 0,
      priorQuoteId: row.prior_quote_id || null,
      score: m.score,
    };
    if (!existing || candidate.lastUwYear > existing.lastUwYear) {
      byCedant.set(candidateName, candidate);
    }
  }

  return [...byCedant.values()].sort((a, b) => b.score - a.score || b.lastUwYear - a.lastUwYear);
}

// ── fuzzy matching primitives (pure, exported for tests) ─────────────────────

/**
 * Pass if Levenshtein ≤ 3 OR token-set Dice ≥ 0.85, after light cleanup.
 * Score = max(1 - lev/maxLen, dice).
 */
export function nameMatch(a, b) {
  const A = normaliseName(a);
  const B = normaliseName(b);
  if (!A || !B) return { matched: false, score: 0 };
  if (A === B) return { matched: true, score: 1 };

  const lev = levenshtein(A, B);
  const maxLen = Math.max(A.length, B.length);
  const levScore = maxLen ? 1 - lev / maxLen : 0;
  const dice = tokenSetDice(A, B);
  const score = Math.max(levScore, dice);
  const matched = lev <= 3 || dice >= 0.85;
  return { matched, score, lev, dice };
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Rolling two-row DP — O(min(m,n)) memory.
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,            // deletion
        prev[j - 1] + cost,     // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Dice coefficient on cleaned token sets: 2|A∩B| / (|A|+|B|).
 * Returns 0..1. Strips legal-form / suffix noise tokens before counting
 * so "Al Rajhi Takaful" and "Al Rajhi Coop Ins" both collapse to
 * {al, rajhi}.
 */
export function tokenSetDice(a, b) {
  const A = cleanedTokens(a);
  const B = cleanedTokens(b);
  if (!A.size && !B.size) return 0;
  let overlap = 0;
  for (const t of A) if (B.has(t)) overlap++;
  return (2 * overlap) / (A.size + B.size);
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Common noise tokens in reinsurance company names. Stripping these
// keeps the comparison focused on the distinctive root ("Al Rajhi",
// "Saudi Re", "Lloyd's"). Conservative list — extend if real-world
// data starts mis-matching.
const SUFFIX_NOISE = new Set([
  'co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'ltd',
  'limited', 'plc', 'llc', 'sa', 'sae', 'sarl', 'gmbh', 'ag', 'spa',
  'pty', 'group', 'holdings', 'holding',
  'insurance', 'insurances', 'reinsurance', 're', 'reinsurer', 'reinsurers',
  'general', 'mutual', 'cooperative', 'coop', 'takaful', 'ins',
  'the', 'and', '&', 'of',
]);

function normaliseName(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cleanedTokens(s) {
  const tokens = normaliseName(s).split(' ').filter(Boolean);
  const out = new Set();
  for (const t of tokens) {
    if (SUFFIX_NOISE.has(t)) continue;
    if (t.length === 1) continue; // strip lone initials
    out.add(t);
  }
  // If we've stripped everything (e.g. "Insurance Co" → {}), fall back
  // to the original tokens so we still have something to compare.
  if (!out.size) for (const t of tokens) if (t) out.add(t);
  return out;
}

function classTokenSet(classes) {
  const out = new Set();
  for (const c of classes || []) {
    for (const t of normaliseName(c).split(' ')) {
      if (t) out.add(t);
    }
  }
  return out;
}

function setsIntersect(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}
