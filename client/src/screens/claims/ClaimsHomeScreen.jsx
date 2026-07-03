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

function KpiCard({ label, value, sub }) {
  return (
    <div style={{
      flex: '1 1 180px', minWidth: 180, padding: '18px 20px', borderRadius: 14,
      background: 'var(--surface-2)', border: '1px solid rgba(var(--accent-rgb),0.18)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{value}</div>
      {sub ? <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

const EMPTY_FORM = {
  contract_id: '', loss_date: '', reported_date: '', insured_name: '',
  cedant_claim_ref: '', cause_of_loss: '', description: '',
  loss_type: 'ATTRITIONAL', cat_event_ref: '', gross_paid_100: '0', gross_os_100: '0',
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
    setCreateOpen(true); setCreateError(''); setForm(EMPTY_FORM);
    try {
      const rows = await api.getClaimsEligibleContracts();
      setContracts(Array.isArray(rows) ? rows : []);
    } catch (e) {
      logger.error('eligible contracts load failed', e);
      setCreateError('Could not load signed treaties.');
    }
  }, []);

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
      setCreateOpen(false);
      navigate(`/claims/${out.claim_id}`);
    } catch (e) {
      logger.error('claim create failed', e);
      setCreateError(errMsg(e, 'Claim creation failed.'));
    } finally { setSaving(false); }
  }, [form, navigate]);

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

        {/* Dashboard KPIs */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 22 }}>
          <KpiCard label="Total Claims Paid to Date" value={summary ? fmtMoney(summary.total_paid_our_share) : '–'} sub="our share, excl. rejected" />
          <KpiCard label="Draft Claims" value={summary ? summary.draft_claims : '–'} />
          <KpiCard label="Waiting for Approval" value={summary ? summary.waiting_approval_claims : '–'} />
          <KpiCard label="Rejected" value={summary ? summary.rejected_claims : '–'} />
          <KpiCard label="Finalised" value={summary ? summary.finalised_claims : '–'} sub={`${summary ? summary.total_claims : '–'} claims total`} />
        </div>

        {/* Position KPIs */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 22 }}>
          <KpiCard label="Open Claims" value={summary ? summary.open_claims : '–'} />
          <KpiCard label="Open Incurred (our share)" value={summary ? fmtMoney(summary.open_incurred_our_share) : '–'} />
          <KpiCard label="Outstanding (our share)" value={summary ? fmtMoney(summary.open_os_our_share) : '–'} />
          <KpiCard label="CAT Claims" value={summary ? summary.cat_claims : '–'} />
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
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Treaty (SIGNED / BOUND only)" required>
              <select value={form.contract_id} onChange={set('contract_id')} style={{ ...selStyle, width: '100%' }}>
                <option value="">Select treaty…</option>
                {contracts.map((c) => (
                  <option key={c.contract_id} value={c.contract_id}>
                    {(c.cedant_name || 'Unnamed')} · {c.treaty_type || 'Treaty'} · UW {c.uw_year}
                    {c.signed_line_pct != null ? ` · line ${Number(c.signed_line_pct)}%` : ''}
                  </option>
                ))}
              </select>
            </Field>
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
