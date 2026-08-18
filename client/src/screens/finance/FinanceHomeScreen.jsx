// src/screens/finance/FinanceHomeScreen.jsx
// Finance module home: the signed-treaty ledger. Every contract that reaches
// SIGNED (approval flow) or is BOUND from a quote lands here automatically —
// entries are written by the server in the same transaction as the status
// change. Finance acknowledges each entry once booked in the GL
// (PENDING_SETUP → ACTIVE) and can suspend / close entries thereafter.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import { Button, Select, Table } from '../../components/ui';
import { FinanceStatusBadge, KpiCard } from '../../components/ledger';
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

const COLUMNS = [
  { key: 'Cedant / Treaty' }, { key: 'UW Year' }, { key: 'Pushed' }, { key: 'Source' },
  { key: 'Line %', num: true }, { key: 'EPI 100%', num: true }, { key: 'EPI (our)', num: true },
  { key: 'Claims Paid (our)', num: true }, { key: 'Claims OS (our)', num: true },
  { key: 'Status' }, { key: '' },
];

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
    <div className="cf-screen">
      <Topbar title="Finance" subtitle="Signed-treaty ledger" />

      <div className="cf-page">

        {/* KPIs */}
        <div className="cf-kpi-row cf-kpi-row--wide">
          <KpiCard label="Awaiting Setup" value={summary ? summary.pending_setup : '–'} sub="pushed on sign, not yet booked" tone="warn" />
          <KpiCard label="Active Treaties" value={summary ? summary.active : '–'} tone="ok" />
          <KpiCard label="EPI — Our Share" value={summary ? fmtMoney(summary.epi_our_share_total) : '–'} sub="pending + active entries" />
          <KpiCard label="Ledger Entries" value={summary ? summary.total_entries : '–'} />
        </div>

        {/* Filters */}
        <div className="cf-filters">
          <Select className="ui-select--auto" value={statusFilter} aria-label="Filter by status"
            onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {['PENDING_SETUP', 'ACTIVE', 'SUSPENDED', 'CLOSED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </Select>
          <Button onClick={load}>Refresh</Button>
        </div>

        {error && <div className="cf-error" role="alert">{error}</div>}

        {/* Ledger */}
        <Table>
          <thead>
            <tr>
              {COLUMNS.map(({ key, num }) => (
                <th key={key || 'actions'} className={num ? 'cf-num' : undefined}>{key}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={COLUMNS.length} className="cf-empty">Loading…</td></tr>
            )}
            {!loading && !entries.length && (
              <tr><td colSpan={COLUMNS.length} className="cf-empty">No entries. Treaties appear here automatically the moment they are signed.</td></tr>
            )}
            {!loading && entries.map((e) => (
              <tr key={e.entry_id}>
                <td>
                  <div className="cf-cell-title">{e.cedant_name || '–'}</div>
                  <div className="cf-cell-sub">{e.treaty_type || ''}{e.country_name ? ` · ${e.country_name}` : ''}</div>
                </td>
                <td>{e.uw_year || '–'}</td>
                <td>{fmtDate(e.pushed_at)}</td>
                <td className="cf-cell-muted">{e.source}</td>
                <td className="cf-num">{fmtPct(e.signed_line_pct)}</td>
                <td className="cf-num">{fmtMoney(e.epi_100)} <span className="cf-ccy">{e.currency_code || ''}</span></td>
                <td className="cf-num cf-num--strong">{fmtMoney(e.epi_our_share)}</td>
                <td className="cf-num">{fmtMoney(e.paid_our_share)}</td>
                <td className="cf-num">{fmtMoney(e.os_our_share)}</td>
                <td><FinanceStatusBadge status={e.status} /></td>
                <td className="cf-actions-cell">
                  {e.status === 'PENDING_SETUP' && (
                    <Button size="sm" variant="primary" loading={ackBusy === e.entry_id} onClick={() => acknowledge(e.entry_id)}>Acknowledge</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
