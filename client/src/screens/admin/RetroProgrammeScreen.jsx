// src/screens/admin/RetroProgrammeScreen.jsx
//
// Admin capture of the outward retro contract — one placement per underwriting
// year per currency. The offer modal's retro cover analysis reads whatever is
// entered here (routes/retroProgrammes.js); nothing is derived or guessed, so a
// year with no record shows no analysis until an admin fills it in.
//
// Editing a year means re-saving it: the server upserts on (year, currency),
// which is also why the form key is the year and the currency, not a row id.
//
// Same access tier as user management — Chief Executive / Chief Underwriter /
// Chief Actuary (level 2), enforced again on the server.

import { useMemo, useState } from 'react';
import { api } from '../../api';
import { isAtLeast } from '../../utils/auth';
import { formatWithCommas, toN } from '../../utils/format';
import { useResource } from '../../hooks/useResource';
import { Button } from '../../components/ui';
import Topbar from '../../components/Topbar';

/** Form fields, grouped as the retro contract itself reads. */
const SECTIONS = [
  {
    title: 'Placement',
    fields: [
      { k: 'uw_year', label: 'Underwriting Year', kind: 'int', required: true, hint: 'The year this contract covers' },
      { k: 'currency', label: 'Currency', kind: 'ccy', required: true, hint: '3-letter code, e.g. USD' },
      { k: 'label', label: 'Contract Name', kind: 'text', hint: 'e.g. 2026 Cat XL Retro' },
      { k: 'reinsurer', label: 'Retrocessionaire', kind: 'text', hint: 'Lead or placement name' },
      { k: 'inception_date', label: 'Inception', kind: 'date' },
      { k: 'expiry_date', label: 'Expiry', kind: 'date' },
    ],
  },
  {
    title: 'Retro XL',
    fields: [
      { k: 'retention_amt', label: 'Retention', kind: 'money', hint: 'Net priority per event' },
      { k: 'limit_amt', label: 'Limit', kind: 'money', hint: 'Cover in excess of the retention' },
      { k: 'rol_pct', label: 'Rate On Line %', kind: 'pct', hint: 'Cost of cover per unit of limit' },
      { k: 'used_limit_amt', label: 'Limit Used', kind: 'money', hint: 'Burned by the book so far this year' },
    ],
  },
  {
    title: 'Retro Quota Share',
    fields: [
      { k: 'cession_pct', label: 'Cession %', kind: 'pct', hint: 'Ceded off the top, before the XL' },
      { k: 'commission_pct', label: 'Ceding Commission %', kind: 'pct', hint: 'Earned on the ceded premium' },
    ],
  },
  {
    title: 'Underwriting',
    fields: [
      { k: 'max_line_pct', label: 'Max Line %', kind: 'pct', hint: 'Largest line the optimiser may recommend' },
      { k: 'notes', label: 'Notes', kind: 'text' },
    ],
  },
];

const ALL_FIELDS = SECTIONS.flatMap(s => s.fields);
const MONEY_KEYS = new Set(ALL_FIELDS.filter(f => f.kind === 'money').map(f => f.k));

const EMPTY = {
  uw_year: String(new Date().getFullYear()), currency: 'USD', label: '', reinsurer: '',
  inception_date: '', expiry_date: '', retention_amt: '', limit_amt: '', rol_pct: '',
  used_limit_amt: '', cession_pct: '', commission_pct: '', max_line_pct: '25', notes: '',
};

/** Record → form strings, money formatted with separators for reading. */
function toForm(p) {
  const out = { ...EMPTY };
  ALL_FIELDS.forEach(({ k }) => {
    const v = p[k];
    if (v === null || v === undefined) { out[k] = ''; return; }
    out[k] = MONEY_KEYS.has(k) && Number.isFinite(Number(v)) ? formatWithCommas(Number(v)) : String(v);
  });
  return out;
}

const fmtMoney = (n, ccy) => (Number(n) > 0 ? `${ccy} ${formatWithCommas(Math.round(Number(n)))}` : '—');

export default function RetroProgrammeScreen() {
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // Hooks run before the access guard below, so gate the fetch on the tier
  // rather than firing a request the screen will never show.
  const canAdmin = isAtLeast(2);
  const resource = useResource(
    signal => api.getRetroProgrammes(undefined, { signal }),
    [],
    { enabled: canAdmin, reportLabel: 'retro programmes' },
  );
  const programmes = useMemo(() => resource.data?.programmes || [], [resource.data]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const startNew = () => { setEditingId(null); setForm(EMPTY); setErr(''); setMsg(''); };
  const startEdit = (p) => { setEditingId(p.retro_programme_id); setForm(toForm(p)); setErr(''); setMsg(''); };

  const save = async () => {
    setSaving(true); setErr(''); setMsg('');
    try {
      const body = {};
      ALL_FIELDS.forEach(({ k, kind }) => {
        const raw = String(form[k] ?? '').trim();
        if (raw === '') return;
        body[k] = kind === 'money' || kind === 'pct' || kind === 'int' ? toN(raw) : raw;
      });
      const { programme } = await api.saveRetroProgramme(body);
      setMsg(`Saved the ${programme.uw_year} ${programme.currency} retro contract.`);
      setEditingId(programme.retro_programme_id);
      await resource.refetch();
    } catch (e) { setErr(e?.message || 'Save failed.'); }
    finally { setSaving(false); }
  };

  const remove = async (p) => {
    if (!window.confirm(`Delete the ${p.uw_year} ${p.currency} retro contract? The offer modal will show no retro analysis for that year.`)) return;
    setErr(''); setMsg('');
    try {
      await api.deleteRetroProgramme(p.retro_programme_id);
      if (editingId === p.retro_programme_id) startNew();
      await resource.refetch();
    } catch (e) { setErr(e?.message || 'Delete failed.'); }
  };

  if (!canAdmin) {
    return <div className="rp-denied">Access restricted to Chief Underwriter, Chief Actuary and Chief Executive.</div>;
  }

  return (
    <div>
      <Topbar title="RETRO PROGRAMME" subtitle="Outward retro contract · captured per underwriting year" />
      <div className="rp-shell">

        <div className="rp-intro">
          <div>
            <div className="rp-intro-title">Retro Contracts</div>
            <div className="rp-intro-sub">
              {programmes.length
                ? `${programmes.length} placement${programmes.length === 1 ? '' : 's'} captured`
                : 'None captured yet — the offer modal shows no retro analysis until a year is entered'}
            </div>
          </div>
          <Button variant="ghost" onClick={startNew}>+ New Year</Button>
        </div>

        {/* ── Captured contracts ── */}
        <div className="rp-card">
          {resource.loading && <div className="rp-empty">Loading…</div>}
          {!resource.loading && programmes.length === 0 && (
            <div className="rp-empty">No retro contract has been captured yet.</div>
          )}
          {programmes.length > 0 && (
            <table className="rp-table">
              <thead>
                <tr>
                  <th>Year</th><th>Currency</th><th>Contract</th>
                  <th className="rp-num">Retention</th><th className="rp-num">Limit</th>
                  <th className="rp-num">ROL</th><th className="rp-num">Limit Used</th>
                  <th className="rp-num">Retro QS</th><th className="rp-num">Max Line</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {programmes.map(p => (
                  <tr key={p.retro_programme_id} data-testid={`rp-row-${p.uw_year}-${p.currency}`}
                    className={editingId === p.retro_programme_id ? 'rp-row rp-row--editing' : 'rp-row'}>
                    <td className="rp-strong">{p.uw_year}</td>
                    <td>{p.currency}</td>
                    <td>
                      {p.label || '—'}
                      {p.reinsurer && <div className="rp-sub">{p.reinsurer}</div>}
                    </td>
                    <td className="rp-num">{fmtMoney(p.retention_amt, p.currency)}</td>
                    <td className="rp-num">{fmtMoney(p.limit_amt, p.currency)}</td>
                    <td className="rp-num">{Number(p.rol_pct) > 0 ? `${Number(p.rol_pct)}%` : '—'}</td>
                    <td className="rp-num">{fmtMoney(p.used_limit_amt, p.currency)}</td>
                    <td className="rp-num">{Number(p.cession_pct) > 0 ? `${Number(p.cession_pct)}%` : '—'}</td>
                    <td className="rp-num">{Number(p.max_line_pct)}%</td>
                    <td className="rp-actions">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(p)}>Edit</Button>
                      <Button variant="ghost" size="sm" onClick={() => remove(p)}>Delete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Capture / edit ── */}
        <div className="rp-card rp-form" data-testid="rp-form">
          <div className="rp-form-head">
            {editingId ? `Editing ${form.uw_year} ${form.currency}` : 'Capture a retro contract'}
            <span className="rp-form-hint">Saving a year and currency that already exists replaces it.</span>
          </div>

          {SECTIONS.map(section => (
            <div key={section.title} className="rp-section">
              <div className="rp-section-title">{section.title}</div>
              <div className="rp-grid">
                {section.fields.map(f => (
                  <div key={f.k} className="rp-field">
                    <label className="rp-label" htmlFor={`rp-${f.k}`}>
                      {f.label}{f.required ? ' *' : ''}
                      {f.kind === 'money' ? ` (${form.currency || 'ccy'})` : ''}
                    </label>
                    <input id={`rp-${f.k}`} className="form-input rp-input"
                      type={f.kind === 'date' ? 'date' : 'text'}
                      inputMode={f.kind === 'money' || f.kind === 'pct' || f.kind === 'int' ? 'decimal' : undefined}
                      value={form[f.k] ?? ''}
                      onChange={e => set(f.k, f.kind === 'ccy' ? e.target.value.toUpperCase() : e.target.value)} />
                    {f.hint && <div className="rp-hint">{f.hint}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {err && <div className="rp-error" role="alert">{err}</div>}
          {msg && <div className="rp-ok" role="status">{msg}</div>}

          <div className="rp-form-actions">
            {editingId && <Button variant="ghost" onClick={startNew}>Cancel</Button>}
            <Button variant="primary" loading={saving} onClick={save}>
              {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Save Retro Contract'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
