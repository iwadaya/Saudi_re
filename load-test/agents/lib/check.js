// load-test/agents/lib/check.js
//
// Assertion collector + type-aware round-trip comparators for the
// underwriter-agent simulation. Every PUT is followed by a GET; these
// helpers compare what an agent wrote against what the API returns,
// tolerating only representation differences (pg numeric -> string,
// date -> ISO timestamp), never value differences.

/** Numeric equality across pg-numeric strings / JS numbers. null==null. */
export function numEq(a, b) {
  const an = a === null || a === undefined || a === '' ? null : Number(a);
  const bn = b === null || b === undefined || b === '' ? null : Number(b);
  if (an === null && bn === null) return true;
  if (an === null || bn === null) return false;
  if (!Number.isFinite(an) || !Number.isFinite(bn)) return false;
  const scale = Math.max(1, Math.abs(an), Math.abs(bn));
  return Math.abs(an - bn) / scale < 1e-9;
}

/** Calendar-date equality: compares the YYYY-MM-DD the value denotes. */
export function dateEq(a, b) {
  const norm = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v);
    // Already a date-only or ISO string: take the date part directly when
    // it is an exact midnight-UTC ISO stamp or a bare date.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return `unparseable:${s}`;
    return d.toISOString().slice(0, 10);
  };
  return norm(a) === norm(b);
}

/** Boolean equality with pg 't'/'f' tolerance. */
export function boolEq(a, b) {
  const norm = (v) => {
    if (v === true || v === 'true' || v === 't' || v === 1) return true;
    if (v === false || v === 'false' || v === 'f' || v === 0) return false;
    return v === null || v === undefined ? null : v;
  };
  return norm(a) === norm(b);
}

/** Strict-ish scalar equality: null==undefined, otherwise ===. */
export function idEq(a, b) {
  const an = a === undefined || a === '' ? null : a;
  const bn = b === undefined || b === '' ? null : b;
  return an === bn;
}

const COMPARATORS = { num: numEq, date: dateEq, bool: boolEq, id: idEq, str: idEq };

export class Checker {
  constructor() {
    this.results = [];   // { agent, category, name, pass, detail, entity }
    this.failFastLog = [];
  }

  add({ agent, category, name, pass, detail, entity }) {
    this.results.push({
      agent, category, name, pass: !!pass,
      detail: pass ? null : (detail || null),
      entity: entity || null,
    });
    return !!pass;
  }

  /**
   * Compare a set of fields on `actual` against `expected` using per-field
   * type comparators. `types` maps field -> num|date|bool|id|str.
   * Unlisted expected fields default to `num` when both look numeric,
   * else `id`.
   */
  fields({ agent, category, entity, label, actual, expected, types = {} }) {
    let allPass = true;
    for (const [field, want] of Object.entries(expected)) {
      const got = actual ? actual[field] : undefined;
      const kind = types[field]
        || (want instanceof Date || /_date$/.test(field) || /_at$/.test(field) ? 'date' : null)
        || (typeof want === 'boolean' ? 'bool' : null)
        || (typeof want === 'number'
          || (typeof want === 'string' && /^-?\d+(\.\d+)?$/.test(want)
            && typeof got === 'string' && /^-?\d+(\.\d+)?$/.test(got)) ? 'num' : 'id');
      const cmp = COMPARATORS[kind] || idEq;
      const pass = cmp(got, want);
      if (!pass) allPass = false;
      this.add({
        agent, category, entity,
        name: `${label}.${field}`,
        pass,
        detail: pass ? null : `expected ${JSON.stringify(want)} got ${JSON.stringify(got)} (${kind})`,
      });
    }
    return allPass;
  }

  /** Unordered id-set equality (e.g. class_ids). */
  idSet({ agent, category, entity, label, actual, expected }) {
    const a = new Set((actual || []).map(String));
    const e = new Set((expected || []).map(String));
    const pass = a.size === e.size && [...e].every((x) => a.has(x));
    return this.add({
      agent, category, entity, name: label, pass,
      detail: pass ? null : `expected {${[...e].join(',')}} got {${[...a].join(',')}}`,
    });
  }

  /** Expect an exact HTTP status. Returns pass. */
  status({ agent, category, entity, label, res, want }) {
    const wanted = Array.isArray(want) ? want : [want];
    const pass = wanted.includes(res.status);
    return this.add({
      agent, category, entity, name: label, pass,
      detail: pass ? null : `expected HTTP ${wanted.join('/')} got ${res.status} ${res.error || (res.text || '').slice(0, 220)}`,
    });
  }

  summary() {
    const total = this.results.length;
    const failed = this.results.filter((r) => !r.pass);
    const byCategory = {};
    for (const r of this.results) {
      const c = (byCategory[r.category] ||= { total: 0, failed: 0 });
      c.total += 1;
      if (!r.pass) c.failed += 1;
    }
    return { total, passed: total - failed.length, failed: failed.length, byCategory, failures: failed };
  }
}
