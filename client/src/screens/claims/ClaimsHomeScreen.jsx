// src/screens/claims/ClaimsHomeScreen.jsx
// Claims module home: portfolio KPIs, filterable claims register, and the
// New Claim flow (booked against SIGNED/BOUND treaties only — enforced
// server-side, mirrored in the contract dropdown here).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import { Button, Field, Input, Modal } from '../../components/ui';
import { logger } from '../../utils/logger';

const errMsg = (e, fallback) => {
  const b = e?.body;
  if (b && typeof b === 'object' && (b.error || b.message)) return String(b.error || b.message);
  return e?.message ? String(e.message) : fallback;
};

const fmtMoney = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '–';
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
};
const fmtDate = (v) => (v ? String(v).slice(0, 10) : '–');

const STATUS_STYLE = {
  OPEN:     { bg: 'rgba(96,165,250,0.12)',  text: '#60a5fa' },
  REOPENED: { bg: 'rgba(251,191,36,0.12)',  text: '#fbbf24' },
  CLOSED:   { bg: 'rgba(35,209,139,0.10)',  text: '#23d18b' },
  DECLINED: { bg: 'rgba(248,113,113,0.10)', text: '#f87171' },
};
function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.OPEN;
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '.08em', padding: '3px 10px',
      borderRadius: 20, background: s.bg, color: s.text, whiteSpace: 'nowrap',
    }}>{status}</span>
  );
}

const APPROVAL_STYLE = {
  DRAFT:            { bg: 'rgba(148,163,184,0.14)', text: '#94a3b8', label: 'DRAFT' },
  WAITING_APPROVAL: { bg: 'rgba(251,191,36,0.12)',  text: '#fbbf24', label: 'WAITING APPROVAL' },
  REJECTED:         { bg: 'rgba(248,113,113,0.10)', text: '#f87171', label: 'REJECTED' },
  FINALISED:        { bg: 'rgba(35,209,139,0.10)',  text: '#23d18b', label: 'FINALISED' },
};
export function ApprovalPill({ status }) {
  const s = APPROVAL_STYLE[status] || APPROVAL_STYLE.DRAFT;
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '.08em', padding: '3px 10px',
      borderRadius: 20, background: s.bg, color: s.text, whiteSpace: 'nowrap',
    }}>{s.label}</span>
  );
}

function KpiCard({ label, value, sub, accent }) {
  return (
    <div style={{
      padding: '16px 18px', borderRadius: 14, minWidth: 0,
      background: 'var(--surface-2)', border: '1px solid rgba(var(--accent-rgb),0.18)',
    }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent || 'var(--text)', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 6, minHeight: 13 }}>{sub || ''}</div>
    </div>
  );
}

const kpiRowStyle = (min) => ({
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
  gap: 14,
  marginBottom: 14,
});

const EMPTY_FORM = {
  contract_id: '', loss_date: '', reported_date: '', insured_name: '',
  cedant_claim_ref: '', cause_of_loss: '', description: '',
  loss_type: 'ATTRITIONAL', cat_event_ref: '', gross_paid_100: '0', gross_os_100: '0',
};
const EMPTY_PICKER = { country_id: '', cedant_id: '', uw_year: '', search: '' };

/** Short human label for a treaty in the picker. */
const treatyLabel = (c) => {
  const bits = [c.cedant_name || 'Unnamed', c.treaty_type || 'Treaty', `UW ${c.uw_year}`];
  if (c.alt_contract_id) bits.push(c.alt_contract_id);
  if (c.signed_line_pct != null) bits.push(`line ${Number(c.signed_line_pct)}%`);
  return bits.join(' · ');
};

export default function ClaimsHomeScreen() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [claims, setClaims] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [statusFilter, setStatusFilter] = useState('');
  const [approvalFilter, setApprovalFilter] = useState('');
  const [lossTypeFilter, setLossTypeFilter] = useState('');
  const [search, setSearch] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [contracts, setContracts] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [picker, setPicker] = useState(EMPTY_PICKER);
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [s, c] = await Promise.all([
        api.getClaimsSummary(),
        api.listClaims({
          status: statusFilter || undefined,
          approvalStatus: approvalFilter || undefined,
          lossType: lossTypeFilter || undefined,
          q: search || undefined,
        }),
      ]);
      setSummary(s);
      setClaims(Array.isArray(c) ? c : []);
    } catch (e) {
      logger.error('claims load failed', e);
      setError('Failed to load claims. Please retry.');
    } finally { setLoading(false); }
  }, [statusFilter, approvalFilter, lossTypeFilter, search]);

  useEffect(() => { load(); }, [load]);

  const openCreate = useCallback(async () => {
    setCreateOpen(true); setCreateError(''); setForm(EMPTY_FORM); setPicker(EMPTY_PICKER); setFiles([]);
    try {
      const rows = await api.getClaimsEligibleContracts();
      setContracts(Array.isArray(rows) ? rows : []);
    } catch (e) {
      logger.error('eligible contracts load failed', e);
      setCreateError('Could not load signed treaties.');
    }
  }, []);

  // Cascading treaty picker: country → cedants in that country → that cedant's
  // treaties, further narrowed by UW year and free-text search (contract id /
  // alt id / description / cedant).
  const countries = useMemo(() => {
    const seen = new Map();
    for (const c of contracts) if (c.country_id && !seen.has(c.country_id)) seen.set(c.country_id, c.country_name || 'Unknown');
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [contracts]);

  const cedants = useMemo(() => {
    const seen = new Map();
    for (const c of contracts) {
      if (picker.country_id && c.country_id !== picker.country_id) continue;
      if (c.cedant_id && !seen.has(c.cedant_id)) seen.set(c.cedant_id, c.cedant_name || 'Unnamed');
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [contracts, picker.country_id]);

  const uwYears = useMemo(() => {
    const years = new Set();
    for (const c of contracts) {
      if (picker.country_id && c.country_id !== picker.country_id) continue;
      if (picker.cedant_id && c.cedant_id !== picker.cedant_id) continue;
      if (c.uw_year != null) years.add(c.uw_year);
    }
    return [...years].sort((a, b) => b - a);
  }, [contracts, picker.country_id, picker.cedant_id]);

  const eligibleTreaties = useMemo(() => {
    const needle = picker.search.trim().toLowerCase();
    return contracts.filter((c) => {
      if (picker.country_id && c.country_id !== picker.country_id) return false;
      if (picker.cedant_id && c.cedant_id !== picker.cedant_id) return false;
      if (picker.uw_year && String(c.uw_year) !== String(picker.uw_year)) return false;
      if (needle) {
        const hay = [c.contract_id, c.alt_contract_id, c.contract_description, c.cedant_name, c.treaty_type]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [contracts, picker]);

  const setPickerField = (k) => (e) => {
    const value = e?.target ? e.target.value : e;
    setPicker((p) => {
      const next = { ...p, [k]: value };
      if (k === 'country_id') { next.cedant_id = ''; next.uw_year = ''; }
      if (k === 'cedant_id') next.uw_year = '';
      return next;
    });
  };

  // Drop the treaty selection if it no longer survives the picker filters.
  useEffect(() => {
    if (form.contract_id && !eligibleTreaties.some((c) => c.contract_id === form.contract_id)) {
      setForm((f) => ({ ...f, contract_id: '' }));
    }
  }, [eligibleTreaties, form.contract_id]);

  const submitCreate = useCallback(async () => {
    setCreateError('');
    if (!form.contract_id) { setCreateError('Select the treaty the claim attaches to.'); return; }
    if (!form.loss_date) { setCreateError('Loss date is required.'); return; }
    setSaving(true);
    try {
      const body = {
        contract_id: form.contract_id,
        loss_date: form.loss_date,
        reported_date: form.reported_date || undefined,
        insured_name: form.insured_name || undefined,
        cedant_claim_ref: form.cedant_claim_ref || undefined,
        cause_of_loss: form.cause_of_loss || undefined,
        description: form.description || undefined,
        loss_type: form.loss_type,
        cat_event_ref: form.loss_type === 'CAT' ? (form.cat_event_ref || undefined) : undefined,
        gross_paid_100: Number(String(form.gross_paid_100).replace(/,/g, '')) || 0,
        gross_os_100: Number(String(form.gross_os_100).replace(/,/g, '')) || 0,
      };
      const out = await api.createClaim(body);
      // Attachments ride along after the claim exists; a failed upload is
      // reported but never blocks the created claim.
      const failed = [];
      for (const file of files) {
        try {
          const fd = new FormData();
          fd.append('file', file);
          await api.uploadClaimDocument(out.claim_id, fd);
        } catch (e) {
          logger.error('claim attachment upload failed', e);
          failed.push(file.name);
        }
      }
      if (failed.length) {
        window.alert(`Claim ${out.claim_ref || ''} was created, but these attachments failed to upload: ${failed.join(', ')}. You can re-attach them on the claim screen.`);
      }
      setCreateOpen(false);
      navigate(`/claims/${out.claim_id}`);
    } catch (e) {
      logger.error('claim create failed', e);
      setCreateError(errMsg(e, 'Claim creation failed.'));
    } finally { setSaving(false); }
  }, [form, files, navigate]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  const filtered = useMemo(() => claims, [claims]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg0)', fontFamily: 'var(--font-sans)' }}>
      <Topbar
        title="Claims"
        subtitle="Claims dashboard & register"
        actions={(
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => setApprovalFilter('WAITING_APPROVAL')}>
              Review Claims{summary && Number(summary.waiting_approval_claims) > 0 ? ` (${summary.waiting_approval_claims})` : ''}
            </Button>
            <Button variant="primary" onClick={openCreate}>+ New Claim</Button>
          </div>
        )}
      />

      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 20px' }}>

        {/* Claim counts */}
        <div style={kpiRowStyle(150)}>
          <KpiCard label="Total Claims" value={summary ? summary.total_claims : '–'} sub={summary ? `${summary.open_claims} open · ${summary.cat_claims} CAT` : ''} />
          <KpiCard label="Draft" value={summary ? summary.draft_claims : '–'} accent="#94a3b8" />
          <KpiCard label="Waiting for Approval" value={summary ? summary.waiting_approval_claims : '–'} accent="#fbbf24" />
          <KpiCard label="Rejected" value={summary ? summary.rejected_claims : '–'} accent="#f87171" />
          <KpiCard label="Finalised" value={summary ? summary.finalised_claims : '–'} accent="#23d18b" />
        </div>

        {/* Position (our share) */}
        <div style={{ ...kpiRowStyle(200), marginBottom: 22 }}>
          <KpiCard label="Total Claims Paid to Date" value={summary ? fmtMoney(summary.total_paid_our_share) : '–'} sub="our share, excl. rejected" />
          <KpiCard label="Open Incurred" value={summary ? fmtMoney(summary.open_incurred_our_share) : '–'} sub="our share, open claims" />
          <KpiCard label="Outstanding" value={summary ? fmtMoney(summary.open_os_our_share) : '–'} sub="our share, open claims" />
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <select value={approvalFilter} onChange={(e) => setApprovalFilter(e.target.value)} style={selStyle} aria-label="Filter by approval status">
            <option value="">All approval states</option>
            {['DRAFT', 'WAITING_APPROVAL', 'REJECTED', 'FINALISED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selStyle} aria-label="Filter by status">
            <option value="">All statuses</option>
            {['OPEN', 'REOPENED', 'CLOSED', 'DECLINED'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={lossTypeFilter} onChange={(e) => setLossTypeFilter(e.target.value)} style={selStyle} aria-label="Filter by loss type">
            <option value="">All loss types</option>
            {['ATTRITIONAL', 'LARGE', 'CAT'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Input placeholder="Search ref / insured / cedant…" value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
          </div>
          <Button onClick={load}>Refresh</Button>
        </div>

        {error && <div style={{ color: '#f87171', fontSize: 13, marginBottom: 10 }}>{error}</div>}

        {/* Register */}
        <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(var(--accent-rgb),0.14)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                {['Claim Ref', 'Cedant / Treaty', 'Insured', 'Loss Date', 'Type', 'Approval', 'Status', 'Incurred 100%', 'Incurred (our)', 'OS (our)'].map((h, i) => (
                  <th key={h} style={{ padding: '10px 12px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-subtle)', textAlign: i >= 7 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: 'var(--text-subtle)' }}>Loading…</td></tr>
              )}
              {!loading && !filtered.length && (
                <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: 'var(--text-subtle)' }}>No claims found. Book the first one with “+ New Claim”.</td></tr>
              )}
              {!loading && filtered.map((c) => (
                <tr key={c.claim_id}
                  onClick={() => navigate(`/claims/${c.claim_id}`)}
                  style={{ cursor: 'pointer', borderTop: '1px solid rgba(var(--accent-rgb),0.08)', background: 'var(--surface-1, transparent)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(var(--accent-rgb),0.05)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={{ padding: '10px 12px', fontWeight: 700, color: 'var(--accent)' }}>{c.claim_ref}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--text)' }}>{c.cedant_name || '–'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{c.treaty_type || ''} · UW {c.uw_year || '–'}</div>
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text)' }}>{c.insured_name || '–'}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text)' }}>{fmtDate(c.loss_date)}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-subtle)' }}>{c.loss_type}</td>
                  <td style={{ padding: '10px 12px' }}><ApprovalPill status={c.approval_status} /></td>
                  <td style={{ padding: '10px 12px' }}><StatusPill status={c.status} /></td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney(c.gross_incurred_100)} <span style={{ color: 'var(--text-subtle)', fontSize: 10 }}>{c.currency_code || ''}</span></td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--text)' }}>{fmtMoney(c.incurred_our_share)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney(c.os_our_share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* New Claim modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New Claim"
        footer={(
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={submitCreate}>Create Claim</Button>
          </>
        )}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {/* Treaty picker: country → cedant → treaty, with UW year + search */}
          <Field label="Country">
            <select value={picker.country_id} onChange={setPickerField('country_id')} style={{ ...selStyle, width: '100%' }}>
              <option value="">All countries</option>
              {countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Cedant">
            <select value={picker.cedant_id} onChange={setPickerField('cedant_id')} style={{ ...selStyle, width: '100%' }}>
              <option value="">All cedants{picker.country_id ? ' in country' : ''}</option>
              {cedants.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="UW year">
            <select value={picker.uw_year} onChange={setPickerField('uw_year')} style={{ ...selStyle, width: '100%' }}>
              <option value="">All years</option>
              {uwYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </Field>
          <Field label="Search treaties">
            <Input value={picker.search} onChange={setPickerField('search')} placeholder="Contract ID / description…" />
          </Field>
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label={`Treaty (SIGNED / BOUND only — ${eligibleTreaties.length} match${eligibleTreaties.length === 1 ? '' : 'es'})`} required>
              <select value={form.contract_id} onChange={set('contract_id')} style={{ ...selStyle, width: '100%' }}>
                <option value="">Select treaty…</option>
                {eligibleTreaties.map((c) => (
                  <option key={c.contract_id} value={c.contract_id}>{treatyLabel(c)}</option>
                ))}
              </select>
            </Field>
            {form.contract_id && (() => {
              const sel = contracts.find((c) => c.contract_id === form.contract_id);
              return sel?.contract_description
                ? <div style={{ fontSize: 11.5, color: 'var(--text-subtle)', marginTop: 4 }}>{sel.contract_description}</div>
                : null;
            })()}
          </div>
          <Field label="Loss date" required><Input type="date" value={form.loss_date} onChange={set('loss_date')} /></Field>
          <Field label="Reported date"><Input type="date" value={form.reported_date} onChange={set('reported_date')} /></Field>
          <Field label="Insured"><Input value={form.insured_name} onChange={set('insured_name')} placeholder="Insured name" /></Field>
          <Field label="Cedant claim ref"><Input value={form.cedant_claim_ref} onChange={set('cedant_claim_ref')} placeholder="Cedant's reference" /></Field>
          <Field label="Loss type">
            <select value={form.loss_type} onChange={set('loss_type')} style={{ ...selStyle, width: '100%' }}>
              {['ATTRITIONAL', 'LARGE', 'CAT'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          {form.loss_type === 'CAT' && (
            <Field label="CAT event ref"><Input value={form.cat_event_ref} onChange={set('cat_event_ref')} placeholder="e.g. Jeddah Floods 2026" /></Field>
          )}
          <Field label="Cause of loss"><Input value={form.cause_of_loss} onChange={set('cause_of_loss')} placeholder="e.g. Fire" /></Field>
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Description"><Input value={form.description} onChange={set('description')} placeholder="Advice narrative" /></Field>
          </div>
          <Field label="Opening paid @100%"><Input inputMode="numeric" value={form.gross_paid_100} onChange={set('gross_paid_100')} /></Field>
          <Field label="Opening OS reserve @100%"><Input inputMode="numeric" value={form.gross_os_100} onChange={set('gross_os_100')} /></Field>
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Attachments">
              <input
                type="file" multiple
                onChange={(e) => setFiles(Array.from(e.target.files || []))}
                style={{ ...selStyle, width: '100%', padding: '7px 10px' }}
                aria-label="Claim attachments"
              />
            </Field>
            {files.length > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--text-subtle)', marginTop: 4 }}>
                {files.length} file{files.length === 1 ? '' : 's'} will be attached: {files.map((f) => f.name).join(', ')}
              </div>
            )}
          </div>
        </div>
        {createError && <div style={{ color: '#f87171', fontSize: 12.5, marginTop: 12 }}>{createError}</div>}
      </Modal>
    </div>
  );
}

const selStyle = {
  background: 'var(--surface-2)', color: 'var(--text)',
  border: '1px solid rgba(var(--accent-rgb),0.25)', borderRadius: 8,
  padding: '8px 10px', fontSize: 12.5, fontFamily: 'var(--font-sans)',
};
