import { useState, useEffect, useMemo } from 'react';
import { api } from '../../../../../api';
import { MetricBars, ViewTabs } from './_shared.jsx';

const num = v => { const x = Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(x) ? x : 0; };
// Currency is treaty-constant, so the comparison table keeps values compact.
const money = v => { const x = num(v); return x ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'; };
const pctFmt = v => { const x = num(v); return x ? `${x.toFixed(2)}%` : '—'; };
const plain = v => v != null && v !== '' ? String(v) : '—';
const commLabel = m => { const s = String(m || '').toUpperCase(); return s === 'SLIDING' ? 'Sliding Scale' : s === 'PROVISIONAL' ? 'Provisional' : 'Fixed'; };

const sumCresta = (data, field) => {
  if (!data) return 0;
  const rows = data.zones || data.rows || data || [];
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((a, r) => a + num(r[field] || r.sum_insured || 0), 0);
};

const sumLosses = data => {
  if (!data) return 0;
  const rows = data.losses || data || [];
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((a, r) => a + (num(r.incurred) || num(r.paid) + num(r.os)), 0);
};

/* ── Compare Terms Panel — Current Year vs Previous Year ── */
export function CompareTermsPanel({ contractId, contract, td }) {
  const [prevContract, setPrevContract] = useState(null);
  const [prevLoading, setPrevLoading] = useState(true);
  const [curAgg, setCurAgg] = useState(null);
  const [prevAgg, setPrevAgg] = useState(null);
  const [manualPrev, setManualPrev] = useState({});
  const [view, setView] = useState('table'); // 'table' | 'graphs'

  const hdr = useMemo(() => contract?.header || contract || {}, [contract]);
  const det = useMemo(() => contract?.detail || {}, [contract]);
  const comm = useMemo(() => contract?.commissions || {}, [contract]);

  const curYear = det.inception_date
    ? new Date(det.inception_date).getFullYear()
    : (parseInt(hdr.uw_year || td.startYear) || new Date().getFullYear());
  const prevYear = curYear - 1;

  // Find previous year contract
  useEffect(() => {
    if (!contractId) { setPrevLoading(false); return; }
    const parentId = hdr.parent_contract_id;
    const cedantId = hdr.cedant_id || td.cedantId;
    const fetchPrev = async () => {
      try {
        let prev = null;
        if (parentId) {
          prev = await api.getContract(parentId).catch(() => null);
        }
        if (!prev && cedantId) {
          const cedantRows = await api.getCedantSummary(cedantId).catch(() => []);
          const prevRow = Array.isArray(cedantRows)
            ? cedantRows.find(r => {
                const iDate = r.inception_date;
                const yr = iDate ? new Date(iDate).getFullYear() : Number(r.uw_year);
                return yr === prevYear;
              })
            : null;
          if (prevRow) {
            const prevId = prevRow.contract_id || prevRow.id;
            if (prevId) prev = await api.getContract(prevId).catch(() => null);
          }
        }
        if (prev) setPrevContract(prev);
      } catch {}
      setPrevLoading(false);
    };
    fetchPrev();
  }, [contractId, hdr.cedant_id, hdr.parent_contract_id, prevYear, td.cedantId]);

  // Fetch aggregate data for current
  useEffect(() => {
    if (!contractId) return;
    (async () => {
      try {
        const [cresta, large, cat] = await Promise.all([
          api.getCrestaData(contractId).catch(() => null),
          api.getLargeLosses(contractId).catch(() => null),
          api.getCatLosses(contractId).catch(() => null),
        ]);
        setCurAgg({ cresta, large, cat });
      } catch {}
    })();
  }, [contractId]);

  // Fetch aggregate data for previous (only if found from DB)
  useEffect(() => {
    const prevId = prevContract?.contract_id;
    if (!prevId) return;
    (async () => {
      try {
        const [cresta, large, cat] = await Promise.all([
          api.getCrestaData(prevId).catch(() => null),
          api.getLargeLosses(prevId).catch(() => null),
          api.getCatLosses(prevId).catch(() => null),
        ]);
        setPrevAgg({ cresta, large, cat });
      } catch {}
    })();
  }, [prevContract]);

  const pDet = useMemo(() => prevContract?.detail || {}, [prevContract]);
  const pComm = useMemo(() => prevContract?.commissions || {}, [prevContract]);
  const pHdr = useMemo(() => prevContract?.header || {}, [prevContract]);

  const curEpi = num(det.quota_share_epi) + num(det.surplus_epi);
  const prevEpi = num(pDet.quota_share_epi) + num(pDet.surplus_epi);

  const curTSI = sumCresta(curAgg?.cresta, 'sum_insured');
  const prevTSI = sumCresta(prevAgg?.cresta, 'sum_insured');

  const curTotalLoss = sumLosses(curAgg?.large);
  const prevTotalLoss = sumLosses(prevAgg?.large);
  const curCatLoss = sumLosses(curAgg?.cat);
  const prevCatLoss = sumLosses(prevAgg?.cat);

  const curEvLim = num(det.event_limit);
  const prevEvLim = num(pDet.event_limit);

  // Row definitions — key is used for manual override state
  const METRIC_ROWS = useMemo(() => [
    { section: 'Treaty Structure' },
    { key: 'broker', label: 'Broker', cur: plain(hdr.broker_name || td.brokerName), dbPrev: plain(pHdr.broker_name), type: 'text' },
    { key: 'qs_limit', label: 'Quota Share Limit', cur: num(det.qs_limit), dbPrev: num(pDet.qs_limit), type: 'money' },
    { key: 'cession_pct', label: 'Cession %', cur: num(det.cession_pct), dbPrev: num(pDet.cession_pct), type: 'pct' },
    { key: 'retention_pct', label: 'Retention %', cur: num(det.retention_pct), dbPrev: num(pDet.retention_pct), type: 'pct' },
    { key: 'surplus_retention', label: 'Surplus Retention', cur: num(det.surplus_max_retention), dbPrev: num(pDet.surplus_max_retention), type: 'money' },
    { key: 'surplus_lines', label: 'Surplus Lines', cur: num(det.num_lines), dbPrev: num(pDet.num_lines), type: 'num' },
    { key: 'total_limit', label: 'Total Limit', cur: num(det.total_capacity) || num(det.qs_limit), dbPrev: num(pDet.total_capacity) || num(pDet.qs_limit), type: 'money' },
    { key: 'event_limit', label: 'Event Limit', cur: curEvLim, dbPrev: prevEvLim, type: 'money' },
    { key: 'aal', label: 'AAL', cur: num(det.aal), dbPrev: num(pDet.aal), type: 'money' },
    { section: 'Commissions & Costs' },
    { key: 'comm_type', label: 'Commission Type', cur: commLabel(comm.mode), dbPrev: commLabel(pComm.mode), type: 'text' },
    { key: 'comm_qs', label: 'Commission (QS)', cur: num(comm.fixed_commission_qs_pct || comm.fixed_commission_pct), dbPrev: num(pComm.fixed_commission_qs_pct || pComm.fixed_commission_pct), type: 'pct' },
    { key: 'comm_surplus', label: 'Commission (Surplus)', cur: num(comm.fixed_commission_surplus_pct || comm.fixed_commission_pct), dbPrev: num(pComm.fixed_commission_surplus_pct || pComm.fixed_commission_pct), type: 'pct' },
    { key: 'mgmt_exp', label: 'Mgmt Expenses', cur: num(comm.mgmt_expenses_pct), dbPrev: num(pComm.mgmt_expenses_pct), type: 'pct' },
    { key: 'profit_comm', label: 'Profit Commission', cur: num(comm.profit_commission_pct), dbPrev: num(pComm.profit_commission_pct), type: 'pct' },
    { section: 'Premium & Exposure' },
    { key: 'total_epi', label: 'Total EPI', cur: curEpi, dbPrev: prevEpi, type: 'money' },
    { key: 'tsi', label: 'Total Sum Insured', cur: curTSI, dbPrev: prevTSI, type: 'money' },
    { section: 'Loss Experience' },
    { key: 'total_losses', label: 'Total Losses', cur: curTotalLoss, dbPrev: prevTotalLoss, type: 'money' },
    { key: 'cat_losses', label: 'Total CAT Losses', cur: curCatLoss, dbPrev: prevCatLoss, type: 'money' },
    { key: 'event', label: 'Event', cur: curEvLim, dbPrev: prevEvLim, type: 'money' },
  ], [
    comm,
    curCatLoss,
    curEpi,
    curEvLim,
    curTotalLoss,
    curTSI,
    det,
    hdr,
    pComm,
    pDet,
    pHdr,
    prevCatLoss,
    prevEpi,
    prevEvLim,
    prevTotalLoss,
    prevTSI,
    td,
  ]);

  // Get effective previous value: manual override if set, else DB value
  const getPrev = (row) => {
    if (manualPrev[row.key] !== undefined && manualPrev[row.key] !== '') return manualPrev[row.key];
    return row.dbPrev;
  };

  // Seed manual state from DB when prevContract loads
  useEffect(() => {
    if (!prevContract) return;
    // Only seed keys that don't already have manual values
    setManualPrev(prev => {
      const next = { ...prev };
      METRIC_ROWS.filter(r => r.key && !r.section).forEach(r => {
        if (next[r.key] === undefined || next[r.key] === '') {
          const dbVal = r.dbPrev;
          if (dbVal != null && dbVal !== '' && dbVal !== 0 && dbVal !== '—') {
            next[r.key] = String(dbVal);
          }
        }
      });
      return next;
    });
  }, [METRIC_ROWS, prevContract]);

  const setManual = (key, val) => setManualPrev(prev => ({ ...prev, [key]: val }));

  // Change calculation
  const calcChange = (cur, prev, type) => {
    if (type === 'text') {
      const c = plain(cur), p = plain(prev);
      if (p === '—' || c === p) return { label: '—', color: 'rgba(255,255,255,0.35)' };
      return { label: 'Changed', color: '#fbbf24' };
    }
    const c = num(cur), p = num(prev);
    if (!p || !c) return { label: '—', color: 'rgba(255,255,255,0.35)' };
    const delta = ((c - p) / Math.abs(p)) * 100;
    const label = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
    const color = Math.abs(delta) < 0.5 ? 'rgba(255,255,255,0.5)' : delta > 0 ? '#4ade80' : '#f87171';
    return { label, color };
  };

  const fmtVal = (v, type) => {
    if (type === 'money') return money(v);
    if (type === 'pct') return pctFmt(v);
    if (type === 'num') return v ? String(v) : '—';
    return plain(v);
  };

  const hasPrev = !!prevContract;
  const isManualMode = !prevLoading && !prevContract;

  /* ── Shared cell style: matches pricing table (.bbg-inp / .bbg-td) ── */
  const thS = { padding: '10px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.1)', whiteSpace: 'nowrap', background: 'rgba(15,26,46,0.98)', position: 'sticky', top: 0, zIndex: 2, textAlign: 'center' };
  const tdBase = { padding: '5px 6px', verticalAlign: 'middle', borderBottom: '1px solid rgba(148,163,184,0.06)', textAlign: 'center', fontSize: 13 };
  const secS = { padding: '10px 12px', fontSize: 10, fontWeight: 800, letterSpacing: '.16em', textTransform: 'uppercase', color: '#ff9a00', borderBottom: '1px solid rgba(255,165,0,0.18)', background: 'rgba(255,165,0,0.04)' };

  /* Read-only cell pill — matches .bbg-inp--ro */
  const cellRo = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 32, borderRadius: 6, border: '1px solid rgba(148,163,184,0.10)', background: 'rgba(2,6,23,0.22)', color: 'rgba(226,232,240,0.92)', fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', boxSizing: 'border-box', padding: '0 8px', opacity: 0.85 };

  /* Editable input cell */
  const inpS = { width: '100%', height: 32, borderRadius: 6, border: '1px solid rgba(148,163,184,0.18)', background: 'rgba(2,6,23,0.30)', color: 'rgba(226,232,240,0.92)', padding: '0 8px', fontSize: 13, fontWeight: 500, outline: 'none', textAlign: 'center', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums', boxSizing: 'border-box' };

  /* Change cell pill */
  const changeCellS = (color) => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 32, borderRadius: 6, border: '1px solid rgba(148,163,184,0.06)', background: 'rgba(2,6,23,0.15)', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', boxSizing: 'border-box', padding: '0 8px', color });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 13 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>Compare Terms</div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 }}>
            Comparing <b style={{ color: '#4ade80' }}>{curYear}</b> (current) vs <b style={{ color: '#60a5fa' }}>{prevYear}</b> (previous)
            {prevLoading && ' — loading…'}
            {isManualMode && <span style={{ color: '#fbbf24' }}> — manual entry mode (no prior treaty found)</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ViewTabs value={view} onChange={setView} />
          {isManualMode && (
            <button className="bbg-btn" onClick={() => setManualPrev({})} style={{ fontSize: 11, padding: '6px 12px' }}>Clear All</button>
          )}
        </div>
      </div>

      {view === 'graphs' ? (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '16px 20px' }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', marginBottom: 12 }}>
            {curYear} vs {prevYear} — headline moves
          </div>
          <MetricBars rows={METRIC_ROWS
            .filter(r => r.key && (r.type === 'money' || r.type === 'pct'))
            .map(r => ({
              key: r.key, label: r.label,
              cur:  num(r.cur),
              prev: num(getPrev(r)),
            }))
            .filter(r => r.cur || r.prev)} />
        </div>
      ) : (
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table className="bbg-table" style={{ width: '100%', minWidth: 700 }}>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: 'center', width: '28%' }}>Metric</th>
              <th style={{ ...thS, width: '24%' }}>
                <span style={{ color: '#4ade80' }}>{curYear}</span> Current
              </th>
              <th style={{ ...thS, width: '24%' }}>
                <span style={{ color: '#60a5fa' }}>{prevYear}</span> Previous
              </th>
              <th style={{ ...thS, width: '16%' }}>Change</th>
            </tr>
          </thead>
          <tbody>
            {METRIC_ROWS.map((r) => {
              if (r.section) {
                return (
                  <tr key={r.section}>
                    <td colSpan={4} style={secS}>▸ {r.section}</td>
                  </tr>
                );
              }

              const prevVal = getPrev(r);
              const chg = calcChange(r.cur, prevVal, r.type);
              const manualVal = manualPrev[r.key] ?? '';
              const hasDbVal = hasPrev && r.dbPrev != null && r.dbPrev !== '' && r.dbPrev !== 0 && r.dbPrev !== '—';
              const placeholder = r.type === 'money' ? '0' : r.type === 'pct' ? '0.00' : r.type === 'num' ? '0' : 'Enter…';

              // Display value in the input, formatted per type:
              //   money → 1,234,567  |  pct → 12.5 (no % on numeric types while editing)
              // Parse on change by stripping commas + %. Keeps the
              // stored manualPrev value numeric-clean for the change calc.
              const rawVal = manualVal || (hasDbVal ? String(r.dbPrev) : '');
              const displayVal = (() => {
                if (r.type === 'text') return rawVal;
                const n = Number(String(rawVal).replace(/[, ]/g, ''));
                if (!Number.isFinite(n) || rawVal === '') return rawVal;
                if (r.type === 'money') return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
                if (r.type === 'num')   return String(n);
                return rawVal; // pct — leave as-is so 25.5 doesn't become 26
              })();

              return (
                <tr key={r.key}>
                  {/* Metric label — in cell */}
                  <td style={tdBase}>
                    <div style={{ ...cellRo, justifyContent: 'center', fontWeight: 650, color: 'rgba(226,232,240,0.88)', border: 'none', background: 'transparent', opacity: 1 }}>
                      {r.label}
                    </div>
                  </td>
                  {/* Current year — read-only cell */}
                  <td style={tdBase}>
                    <div style={{ ...cellRo, fontWeight: 700, color: '#fff', opacity: 1 }}>
                      {fmtVal(r.cur, r.type)}
                    </div>
                  </td>
                  {/* Previous year — editable input cell */}
                  <td style={tdBase}>
                    <input
                      type="text"
                      inputMode={r.type === 'text' ? 'text' : 'decimal'}
                      style={inpS}
                      value={displayVal}
                      placeholder={placeholder}
                      onChange={e => setManual(r.key, e.target.value.replace(/,/g, ''))}
                    />
                  </td>
                  {/* Change — read-only cell */}
                  <td style={tdBase}>
                    <div style={changeCellS(chg.color)}>
                      {chg.label}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
