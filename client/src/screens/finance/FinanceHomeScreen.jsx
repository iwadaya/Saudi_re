// src/screens/finance/FinanceHomeScreen.jsx
// Finance module home: the signed-treaty ledger. Every contract that reaches
// SIGNED (approval flow) or is BOUND from a quote lands here automatically —
// entries are written by the server in the same transaction as the status
// change. Finance acknowledges each entry once booked in the GL
// (PENDING_SETUP → ACTIVE) and can suspend / close entries thereafter.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import { Button } from '../../components/ui';
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
const fmtPct = (v) => (v == null ? '–' : `${Number(v)}%`);

const STATUS_STYLE = {
  PENDING_SETUP: { bg: 'rgba(251,191,36,0.12)',  text: '#fbbf24' },
  ACTIVE:        { bg: 'rgba(35,209,139,0.10)',  text: '#23d18b' },
  SUSPENDED:     { bg: 'rgba(248,113,113,0.10)', text: '#f87171' },
  CLOSED:        { bg: 'rgba(148,163,184,0.12)', text: '#94a3b8' },
};
function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.PENDING_SETUP;
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '.08em', padding: '3px 10px',
      borderRadius: 20, background: s.bg, color: s.text, whiteSpace: 'nowrap',
    }}>{String(status).replace('_', ' ')}</span>
  );
}

function KpiCard({ label, value, sub }) {
  return (
    <div style={{
      flex: '1 1 200px', minWidth: 200, padding: '18px 20px', borderRadius: 14,
      background: 'var(--surface-2)', border: '1px solid rgba(var(--accent-rgb),0.18)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{value}</div>
      {sub ? <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

export default function FinanceHomeScreen() {
  const [summary, setSummary] = useState(null);
  const [entries, setEntries] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ackBusy, setAckBusy] = useState(''); // entry_id being acknowledged

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [s, rows] = await Promise.all([
        api.getFinanceSummary(),
        api.listFinanceTreaties(statusFilter || undefined),
      ]);
      setSummary(s);
      setEntries(Array.isArray(rows) ? rows : []);
    } catch (e) {
      logger.error('finance load failed', e);
      setError('Failed to load the finance ledger. Please retry.');
    } finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const acknowledge = useCallback(async (entryId) => {
    setAckBusy(entryId);
    try { await api.acknowledgeFinanceEntry(entryId); await load(); }
    catch (e) {
      logger.error('acknowledge failed', e);
      setError(errMsg(e, 'Acknowledge failed.'));
    } finally { setAckBusy(''); }
  }, [load]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg0)', fontFamily: 'var(--font-sans)' }}>
      <Topbar title="Finance" subtitle="Signed-treaty ledger" />

      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 20px' }}>

        {/* KPIs */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 22 }}>
          <KpiCard label="Awaiting Setup" value={summary ? summary.pending_setup : '–'} sub="pushed on sign, not yet booked" />
          <KpiCard label="Active Treaties" value={summary ? summary.active : '–'} />
          <KpiCard label="EPI — Our Share" value={summary ? fmtMoney(summary.epi_our_share_total) : '–'} sub="pending + active entries" />
          <KpiCard label="Ledger Entries" value={summary ? summary.total_entries : '–'} />
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status"
            style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid rgba(var(--accent-rgb),0.25)', borderRadius: 8, padding: '8px 10px', fontSize: 12.5 }}>
            <option value="">All statuses</option>
            {['PENDING_SETUP', 'ACTIVE', 'SUSPENDED', 'CLOSED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
          <Button onClick={load}>Refresh</Button>
        </div>

        {error && <div style={{ color: '#f87171', fontSize: 13, marginBottom: 10 }}>{error}</div>}

        {/* Ledger */}
        <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(var(--accent-rgb),0.14)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                {['Cedant / Treaty', 'UW Year', 'Pushed', 'Source', 'Line %', 'EPI 100%', 'EPI (our)', 'Claims Paid (our)', 'Claims OS (our)', 'Status', ''].map((h, i) => (
                  <th key={h} style={{ padding: '10px 12px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-subtle)', textAlign: i >= 4 && i <= 8 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: 'var(--text-subtle)' }}>Loading…</td></tr>
              )}
              {!loading && !entries.length && (
                <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: 'var(--text-subtle)' }}>No entries. Treaties appear here automatically the moment they are signed.</td></tr>
              )}
              {!loading && entries.map((e) => (
                <tr key={e.entry_id} style={{ borderTop: '1px solid rgba(var(--accent-rgb),0.08)' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 700, color: 'var(--text)' }}>{e.cedant_name || '–'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{e.treaty_type || ''}{e.country_name ? ` · ${e.country_name}` : ''}</div>
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text)' }}>{e.uw_year || '–'}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text)' }}>{fmtDate(e.pushed_at)}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-subtle)' }}>{e.source}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text)' }}>{fmtPct(e.signed_line_pct)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney(e.epi_100)} <span style={{ color: 'var(--text-subtle)', fontSize: 10 }}>{e.currency_code || ''}</span></td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--text)' }}>{fmtMoney(e.epi_our_share)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney(e.paid_our_share)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney(e.os_our_share)}</td>
                  <td style={{ padding: '10px 12px' }}><StatusPill status={e.status} /></td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                    {e.status === 'PENDING_SETUP' && (
                      <Button size="sm" variant="primary" loading={ackBusy === e.entry_id} onClick={() => acknowledge(e.entry_id)}>Acknowledge</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
