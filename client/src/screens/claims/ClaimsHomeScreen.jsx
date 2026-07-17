// src/screens/claims/ClaimsHomeScreen.jsx
// Claims module home: portfolio KPIs, filterable claims register, the
// New Claim flow (booked against SIGNED/BOUND treaties only — enforced
// server-side, mirrored in the contract dropdown here), and the PLA
// (Preliminary Loss Advice) section for pre-claim notifications.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import { Button, Field, Input, Modal } from '../../components/ui';
import { logger } from '../../utils/logger';
import { formatWithCommasDecimal, sanitizeNumber } from '../../utils/format';
import PlaSection from './PlaSection';

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
const parseAmt = (v) => Number(String(v ?? '').replace(/,/g, ''));

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
  loss_type: 'ATTRITIONAL', cat_event_ref: '', gross_paid_100: '0', gross_os_100: '0', comment: '',
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
  const [section, setSection] = useState('claims'); // 'claims' | 'plas'
  const [plaCreateNonce, setPlaCreateNonce] = useState(0);
  const [summary, setSummary] = useState(null);
  const [claims, setClaims] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [statusFilter, setStatusFilter] = useState('');
  const [approvalFilter, setApprovalFilter] = useState('');
  const [lossTypeFilter, setLossTypeFilter] = useState('');
  const [search, setSearch] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [createTab, setCreateTab] = useState(0); // 0 Details · 1 Claim Amounts · 2 Send for Approval
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
    setCreateOpen(true); setCreateTab(0); setCreateError(''); setForm(EMPTY_FORM); setPicker(EMPTY_PICKER); setFiles([]);
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

  const selectedTreaty = useMemo(
    () => contracts.find((c) => c.contract_id === form.contract_id) || null,
    [contracts, form.contract_id],
  );

  /** Per-tab validation; returns an error message or '' when the tab is good. */
  const tabError = useCallback((tab) => {
    if (tab === 0) {
      if (!form.contract_id) return 'Select the treaty the claim attaches to.';
      if (!form.loss_date) return 'Loss date is required.';
    }
    if (tab === 1) {
      const paid = parseAmt(form.gross_paid_100);
      const os = parseAmt(form.gross_os_100);
      if (!Number.isFinite(paid) || paid < 0 || !Number.isFinite(os) || os < 0) {
        return 'Opening paid and OS must be non-negative amounts.';
      }
    }
    return '';
  }, [form]);

  /** Move to a tab, validating every tab before it. */
  const goToTab = useCallback((target) => {
    for (let t = 0; t < target; t += 1) {
      const err = tabError(t);
      if (err) { setCreateTab(t); setCreateError(err); return; }
    }
    setCreateError('');
    setCreateTab(target);
  }, [tabError]);

  const submitCreate = useCallback(async (sendForApproval) => {
    setCreateError('');
    for (let t = 0; t <= 1; t += 1) {
      const err = tabError(t);
      if (err) { setCreateTab(t); setCreateError(err); return; }
    }
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
        gross_paid_100: parseAmt(form.gross_paid_100) || 0,
        gross_os_100: parseAmt(form.gross_os_100) || 0,
        comment: form.comment || undefined,
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
      if (sendForApproval) {
        try {
          await api.submitClaim(out.claim_id);
        } catch (e) {
          logger.error('claim submit-for-approval failed', e);
          window.alert(`Claim ${out.claim_ref || ''} was created as a draft, but sending it for approval failed. You can submit it from the claim screen.`);
        }
      }
      setCreateOpen(false);
      navigate(`/claims/${out.claim_id}`);
    } catch (e) {
      logger.error('claim create failed', e);
      setCreateError(errMsg(e, 'Claim creation failed.'));
    } finally { setSaving(false); }
  }, [form, files, navigate, tabError]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  const filtered = useMemo(() => claims, [claims]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg0)', fontFamily: 'var(--font-sans)' }}>
      <Topbar
        title="Claims"
        subtitle="Claims dashboard & register"
        actions={(
          <div style={{ display: 'flex', gap: 8 }}>
            {section === 'claims' ? (
              <>
                <Button onClick={() => setApprovalFilter('WAITING_APPROVAL')}>
                  Review Claims{summary && Number(summary.waiting_approval_claims) > 0 ? ` (${summary.waiting_approval_claims})` : ''}
                </Button>
                <Button variant="primary" onClick={openCreate}>+ New Claim</Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => setPlaCreateNonce((n) => n + 1)}>+ New PLA</Button>
            )}
          </div>
        )}
      />

      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 20px' }}>

        {/* Section tabs: formal claims register vs. pre-claim PLAs */}
        <div role="tablist" aria-label="Claims sections" className="claims-tabs">
          {[['claims', 'Claims Register'], ['plas', 'Preliminary Loss Advices (PLA)']].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={section === key} onClick={() => setSection(key)}
              className={`claims-tab${section === key ? ' claims-tab--active' : ''}`}>
              {label}
            </button>
          ))}
        </div>

        {section === 'plas' && <PlaSection createNonce={plaCreateNonce} />}

        {section === 'claims' && (
        <>
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
        </>
        )}
      </div>

      {/* New Claim wizard — full screen, tabbed */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New Claim"
        className="ui-modal--full"
        closeOnBackdrop={false}
        footer={(
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            {createTab > 0 && <Button onClick={() => goToTab(createTab - 1)}>← Back</Button>}
            {createTab < 2 && <Button variant="primary" onClick={() => goToTab(createTab + 1)}>Next →</Button>}
            {createTab === 2 && <Button loading={saving} onClick={() => submitCreate(false)}>Create Draft</Button>}
            {createTab === 2 && <Button variant="primary" loading={saving} onClick={() => submitCreate(true)}>Create &amp; Send for Approval</Button>}
          </>
        )}
      >
        {/* Tab bar */}
        <div role="tablist" aria-label="New claim steps" style={{ display: 'flex', gap: 4, borderBottom: '1px solid rgba(var(--accent-rgb),0.16)', marginBottom: 20 }}>
          {['1 · Details', '2 · Claim Amounts', '3 · Send for Approval'].map((t, i) => (
            <button key={t} type="button" role="tab" aria-selected={i === createTab} onClick={() => goToTab(i)} style={tabStyle(i === createTab)}>
              {t}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', width: '100%' }}>
          <div style={{ maxWidth: 960, margin: '0 auto' }}>

            {/* ── Tab 1 · Details ── */}
            {createTab === 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ gridColumn: '1 / -1', ...sectionHead }}>Treaty</div>
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
                  {selectedTreaty?.contract_description && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-subtle)', marginTop: 4 }}>{selectedTreaty.contract_description}</div>
                  )}
                </div>

                <div style={{ gridColumn: '1 / -1', ...sectionHead }}>Loss</div>
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

                <div style={{ gridColumn: '1 / -1', ...sectionHead }}>Attachments</div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Field label="Supporting documents (cedant advice, adjuster report, …)">
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
            )}

            {/* ── Tab 2 · Claim Amounts ── */}
            {createTab === 1 && (() => {
              const paid = parseAmt(form.gross_paid_100) || 0;
              const os = parseAmt(form.gross_os_100) || 0;
              const line = selectedTreaty?.signed_line_pct != null ? Number(selectedTreaty.signed_line_pct) : null;
              const ccy = selectedTreaty?.currency_code || '';
              const share = (v) => (line == null ? null : (v * line) / 100);
              return (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ gridColumn: '1 / -1', ...sectionHead }}>Opening position @ 100% (cumulative)</div>
                  <div style={{ gridColumn: '1 / -1', fontSize: 12.5, color: 'var(--text-subtle)', lineHeight: 1.55 }}>
                    Enter the cedant-advised position at 100% — it is booked as movement #1 (ADVICE) on the claim ledger.
                  </div>
                  <Field label={`Opening paid @100%${ccy ? ` (${ccy})` : ''}`}>
                    <Input inputMode="decimal" value={formatWithCommasDecimal(form.gross_paid_100)} onChange={(e) => set('gross_paid_100')(sanitizeNumber(e.target.value))} />
                  </Field>
                  <Field label={`Opening OS reserve @100%${ccy ? ` (${ccy})` : ''}`}>
                    <Input inputMode="decimal" value={formatWithCommasDecimal(form.gross_os_100)} onChange={(e) => set('gross_os_100')(sanitizeNumber(e.target.value))} />
                  </Field>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <Field label="Movement comment"><Input value={form.comment} onChange={set('comment')} placeholder="e.g. Initial advice per cedant email" /></Field>
                  </div>

                  <div style={{ gridColumn: '1 / -1', ...sectionHead }}>Position preview</div>
                  <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                    {[
                      ['Incurred @100%', fmtMoney(paid + os)],
                      [`Our line${line != null ? ` (${line}%)` : ''}`, line != null ? `${line}%` : 'select a treaty'],
                      ['Paid (our share)', share(paid) != null ? fmtMoney(share(paid)) : '–'],
                      ['OS (our share)', share(os) != null ? fmtMoney(share(os)) : '–'],
                      ['Incurred (our share)', share(paid + os) != null ? fmtMoney(share(paid + os)) : '–'],
                    ].map(([k, v]) => (
                      <div key={k} style={{ padding: '14px 16px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid rgba(var(--accent-rgb),0.14)' }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 6 }}>{k}</div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* ── Tab 3 · Send for Approval ── */}
            {createTab === 2 && (() => {
              const paid = parseAmt(form.gross_paid_100) || 0;
              const os = parseAmt(form.gross_os_100) || 0;
              const line = selectedTreaty?.signed_line_pct != null ? Number(selectedTreaty.signed_line_pct) : null;
              const ccy = selectedTreaty?.currency_code || '';
              const rows = [
                ['Treaty', selectedTreaty ? treatyLabel(selectedTreaty) : '–'],
                ['Contract description', selectedTreaty?.contract_description || '–'],
                ['Country', selectedTreaty?.country_name || '–'],
                ['Loss date', form.loss_date || '–'],
                ['Reported date', form.reported_date || 'today'],
                ['Insured', form.insured_name || '–'],
                ['Cedant claim ref', form.cedant_claim_ref || '–'],
                ['Loss type', form.loss_type + (form.loss_type === 'CAT' && form.cat_event_ref ? ` · ${form.cat_event_ref}` : '')],
                ['Cause of loss', form.cause_of_loss || '–'],
                ['Description', form.description || '–'],
                [`Opening paid @100%${ccy ? ` (${ccy})` : ''}`, fmtMoney(paid)],
                [`Opening OS @100%${ccy ? ` (${ccy})` : ''}`, fmtMoney(os)],
                ['Incurred (our share)', line != null ? fmtMoney(((paid + os) * line) / 100) : '–'],
                ['Attachments', files.length ? files.map((f) => f.name).join(', ') : 'none'],
              ];
              return (
                <div>
                  <div style={sectionHead}>Review &amp; submit</div>
                  <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12,
                    padding: '16px 18px', borderRadius: 14, marginBottom: 18,
                    background: 'var(--surface-2)', border: '1px solid rgba(var(--accent-rgb),0.14)', fontSize: 12.5,
                  }}>
                    {rows.map(([k, v]) => (
                      <div key={k}>
                        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 3 }}>{k}</div>
                        <div style={{ color: 'var(--text)', fontWeight: 600, overflowWrap: 'anywhere' }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-subtle)', lineHeight: 1.6 }}>
                    <b style={{ color: 'var(--text)' }}>Create Draft</b> books the claim and leaves it in DRAFT so you can keep working on it.<br />
                    <b style={{ color: 'var(--text)' }}>Create &amp; Send for Approval</b> books the claim and submits it for review immediately — it is then frozen until approved or rejected.
                  </div>
                </div>
              );
            })()}
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

const sectionHead = {
  fontSize: 11, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase',
  color: 'var(--text-subtle)', marginTop: 6,
};

const tabStyle = (active) => ({
  background: 'none', border: 'none', cursor: 'pointer',
  padding: '10px 16px', fontSize: 12.5, fontFamily: 'var(--font-sans)',
  fontWeight: active ? 800 : 600,
  color: active ? 'var(--accent)' : 'var(--text-subtle)',
  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
  marginBottom: -1,
});
