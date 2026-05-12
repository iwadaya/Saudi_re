import { useState, useEffect, useMemo } from 'react';
import { api } from '../../../../../api.js';
import { cn, MetricBars, ViewTabs } from './_shared.jsx';

export function TreatyMetricsPanel({ shareGrid, contract, td, epi, limit, yearly, contractId }) {
  const [prevContract, setPrevContract] = useState(null);
  const [prevLoading, setPrevLoading] = useState(true);
  const [prevYearly, setPrevYearly] = useState([]); // prior contract's pricing-yearly rows
  const [manualPrev, setManualPrev] = useState({});
  const [view, setView] = useState('table');

  const hdr = contract?.header || contract || {};
  const det = contract?.detail || {};

  const curYear = det.inception_date
    ? new Date(det.inception_date).getFullYear()
    : (parseInt(hdr.uw_year || td.startYear) || new Date().getFullYear());
  const prevYear = curYear - 1;

  // Fetch previous year contract (same logic as CompareTerms)
  useEffect(() => {
    if (!contractId) { setPrevLoading(false); return; }
    const parentId = hdr.parent_contract_id;
    const cedantId = hdr.cedant_id || td.cedantId;
    (async () => {
      try {
        let prev = null;
        if (parentId) prev = await api.getContract(parentId).catch(() => null);
        if (!prev && cedantId) {
          const rows = await api.getCedantSummary(cedantId).catch(() => []);
          const r = Array.isArray(rows) ? rows.find(r => { const yr = r.inception_date ? new Date(r.inception_date).getFullYear() : Number(r.uw_year); return yr === prevYear; }) : null;
          if (r) { const pid = r.contract_id || r.id; if (pid) prev = await api.getContract(pid).catch(() => null); }
        }
        if (prev) setPrevContract(prev);
      } catch {}
      setPrevLoading(false);
    })();
  }, [contractId, hdr.cedant_id, hdr.parent_contract_id, prevYear, td.cedantId]);

  // Load the previous contract's pricing-yearly rows so the 5/10-year
  // moving averages can be computed for BOTH current and previous.
  // Was missing — dbPrev was hardcoded null on all four avg rows.
  useEffect(() => {
    const prevId = prevContract?.contract_id;
    if (!prevId) { setPrevYearly([]); return; }
    (async () => {
      try {
        const rows = await api.getPricingYearly(prevId).catch(() => []);
        setPrevYearly(Array.isArray(rows) ? rows : []);
      } catch { setPrevYearly([]); }
    })();
  }, [prevContract]);

  const n = v => { const x = Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(x) ? x : 0; };

  // ── Current year metrics ──
  const premium100 = cn(shareGrid?.['100%']?.premium_amt) || epi;
  const limit100 = cn(shareGrid?.['100%']?.limit_amt) || limit;
  const balanceCur = premium100 > 0 ? limit100 / premium100 : null;

  const retentionPct = n(det.retention_pct);
  const retentionOfLimit = limit100 > 0 && n(det.retention_amt) > 0
    ? (n(det.retention_amt) / limit100) * 100
    : retentionPct;

  // Risk profile average rate: from risk profile data or use premium/limit as proxy
  const avgRateRisk = premium100 > 0 && limit100 > 0 ? (premium100 / limit100) * 100 : 0;

  // Yearly data for LR and margin averages
  const actuals = useMemo(() => {
    return (yearly || [])
      .filter(r => r.uw_year && (String(r.record_type || '').toUpperCase() === 'ACTUAL' || !r.record_type))
      .sort((a, b) => Number(a.uw_year) - Number(b.uw_year));
  }, [yearly]);

  const calcAvgLR = (windowYears) => {
    const recent = actuals.slice(-windowYears);
    if (!recent.length) return null;
    const lrs = recent.map(r => {
      const p = cn(r.ultimate_premium), l = cn(r.ultimate_loss);
      if (r.loss_ratio) { const lr = cn(r.loss_ratio); return lr > 2 ? lr / 100 : lr; }
      return p > 0 ? l / p : null;
    }).filter(v => v !== null);
    return lrs.length ? lrs.reduce((a, b) => a + b, 0) / lrs.length : null;
  };

  const calcAvgMargin = (windowYears) => {
    const recent = actuals.slice(-windowYears);
    if (!recent.length) return null;
    const margins = recent.map(r => {
      const p = cn(r.ultimate_premium), l = cn(r.ultimate_loss), c = cn(r.commission_amt), b = cn(r.brokerage_amt);
      return p > 0 ? 1 - (l + c + b) / p : null;
    }).filter(v => v !== null);
    return margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null;
  };

  const lr5 = calcAvgLR(5);
  const lr10 = calcAvgLR(10);
  const margin5 = calcAvgMargin(5);
  const margin10 = calcAvgMargin(10);

  // Same calc, but over the previous contract's yearly rows.
  // Returns a fraction (0..1) matching calcAvgLR/calcAvgMargin so the
  // comparison is unit-consistent.
  const prevActuals = useMemo(() => {
    return (prevYearly || [])
      .filter(r => r.uw_year && (String(r.record_type || '').toUpperCase() === 'ACTUAL' || !r.record_type))
      .sort((a, b) => Number(a.uw_year) - Number(b.uw_year));
  }, [prevYearly]);

  const prevAvgLR = (w) => {
    const recent = prevActuals.slice(-w);
    if (!recent.length) return null;
    const lrs = recent.map(r => {
      const p = cn(r.ultimate_premium), l = cn(r.ultimate_loss);
      if (r.loss_ratio) { const lr = cn(r.loss_ratio); return lr > 2 ? lr / 100 : lr; }
      return p > 0 ? l / p : null;
    }).filter(v => v !== null);
    return lrs.length ? lrs.reduce((a, b) => a + b, 0) / lrs.length : null;
  };
  const prevAvgMargin = (w) => {
    const recent = prevActuals.slice(-w);
    if (!recent.length) return null;
    const margins = recent.map(r => {
      const p = cn(r.ultimate_premium), l = cn(r.ultimate_loss), c = cn(r.commission_amt), b = cn(r.brokerage_amt);
      return p > 0 ? 1 - (l + c + b) / p : null;
    }).filter(v => v !== null);
    return margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null;
  };
  const prevLr5     = prevAvgLR(5);
  const prevLr10    = prevAvgLR(10);
  const prevMargin5 = prevAvgMargin(5);
  const prevMargin10= prevAvgMargin(10);

  // ── Previous year metrics ──
  const pDet = prevContract?.detail || {};
  const pPrem = n(pDet.quota_share_epi) + n(pDet.surplus_epi);
  const pLim = n(pDet.qs_limit) || n(pDet.total_capacity);
  const prevBalance = pPrem > 0 ? pLim / pPrem : null;
  const prevRetPct = n(pDet.retention_pct);
  const prevRetOfLimit = pLim > 0 && n(pDet.retention_amt) > 0 ? (n(pDet.retention_amt) / pLim) * 100 : prevRetPct;
  const prevAvgRate = pPrem > 0 && pLim > 0 ? (pPrem / pLim) * 100 : 0;

  // Row definitions
  const METRIC_ROWS = useMemo(() => {
    const fmtR = (v, dec = 2) => v != null && v !== 0 ? `${v.toFixed(dec)}` : '—';
    const fmtP = v => v != null ? `${(v * 100).toFixed(2)}%` : '—';
    return [
      { key: 'balance', label: 'Balance', cur: balanceCur, dbPrev: prevBalance, fmt: v => fmtR(v, 1) },
      { key: 'ret_of_limit', label: 'Retention as % of Limit', cur: retentionOfLimit, dbPrev: prevRetOfLimit, fmt: v => fmtR(v, 2) + (v ? '%' : '') },
      { key: 'avg_rate', label: 'Average Rate (Risk Profile)', cur: avgRateRisk, dbPrev: prevAvgRate, fmt: v => fmtR(v, 3) + (v ? '%' : '') },
      { key: 'lr_5yr', label: '5 Year Average LR', cur: lr5, dbPrev: prevLr5, fmt: fmtP },
      { key: 'lr_10yr', label: '10 Year Average LR', cur: lr10, dbPrev: prevLr10, fmt: fmtP },
      { key: 'margin_5yr', label: '5 Year Average Margin', cur: margin5, dbPrev: prevMargin5, fmt: fmtP },
      { key: 'margin_10yr', label: '10 Year Average Margin', cur: margin10, dbPrev: prevMargin10, fmt: fmtP },
    ];
  }, [
    avgRateRisk,
    balanceCur,
    lr5,
    lr10,
    margin5,
    margin10,
    prevAvgRate,
    prevBalance,
    prevLr5,
    prevLr10,
    prevMargin5,
    prevMargin10,
    prevRetOfLimit,
    retentionOfLimit,
  ]);

  const hasPrev = !!prevContract;
  const isManualMode = !prevLoading && !prevContract;

  // Seed manual prev from DB. Note: the percent-formatted rows (LR + margin
  // averages) store fractions (0..1) in dbPrev. We seed the input with the
  // already-formatted string (e.g. "51.50") so the unit the user sees in
  // the cell matches the unit they'd type.
  useEffect(() => {
    if (!prevContract && !prevYearly.length) return;
    setManualPrev(prev => {
      const next = { ...prev };
      METRIC_ROWS.forEach(r => {
        if ((next[r.key] === undefined || next[r.key] === '') && r.dbPrev != null && r.dbPrev !== 0) {
          next[r.key] = String(r.fmt(r.dbPrev).replace(/[—%]/g, '').trim());
        }
      });
      return next;
    });
  }, [METRIC_ROWS, prevContract, prevYearly.length]);

  const setManual = (key, val) => setManualPrev(prev => ({ ...prev, [key]: val }));

  const getPrevDisplay = (r) => {
    if (manualPrev[r.key] !== undefined && manualPrev[r.key] !== '') return manualPrev[r.key];
    if (hasPrev && r.dbPrev != null && r.dbPrev !== 0) {
      // Show in the same unit the user sees on the current column:
      // formatted (e.g. "51.50" for LR fractions, "1.5" for ratios).
      return String(r.fmt(r.dbPrev).replace(/[—%]/g, '').trim());
    }
    return '';
  };

  // Change calc — works with the displayed (un-formatted) numbers
  // so "51.50" and "62.39" are on the same scale.
  const calcChange = (curVal, prevStr, row) => {
    // Display values for the current col: run the formatter, strip %,
    // parse. That gives apples-to-apples against prevStr.
    const curDisplayed = row?.fmt ? row.fmt(curVal).replace(/[—%,]/g, '').trim() : String(curVal ?? '');
    const c = Number(curDisplayed);
    const p = Number(String(prevStr).replace(/,/g, ''));
    if (!Number.isFinite(c) || !Number.isFinite(p) || c === 0 || p === 0) {
      return { label: '—', color: 'rgba(255,255,255,0.35)' };
    }
    const delta = ((c - p) / Math.abs(p)) * 100;
    const label = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
    const color = Math.abs(delta) < 0.5 ? 'rgba(255,255,255,0.5)' : delta > 0 ? '#4ade80' : '#f87171';
    return { label, color };
  };

  // Styles matching CompareTermsPanel
  const thS = { padding: '10px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.1)', whiteSpace: 'nowrap', background: 'rgba(15,26,46,0.98)', position: 'sticky', top: 0, zIndex: 2, textAlign: 'center' };
  const tdBase = { padding: '5px 6px', verticalAlign: 'middle', borderBottom: '1px solid rgba(148,163,184,0.06)', textAlign: 'center', fontSize: 13 };
  const cellRo = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 32, borderRadius: 6, border: '1px solid rgba(148,163,184,0.10)', background: 'rgba(2,6,23,0.22)', color: 'rgba(226,232,240,0.92)', fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', boxSizing: 'border-box', padding: '0 8px', opacity: 0.85 };
  const inpS = { width: '100%', height: 32, borderRadius: 6, border: '1px solid rgba(148,163,184,0.18)', background: 'rgba(2,6,23,0.30)', color: 'rgba(226,232,240,0.92)', padding: '0 8px', fontSize: 13, fontWeight: 500, outline: 'none', textAlign: 'center', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums', boxSizing: 'border-box' };
  const changeCellS = (color) => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 32, borderRadius: 6, border: '1px solid rgba(148,163,184,0.06)', background: 'rgba(2,6,23,0.15)', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', boxSizing: 'border-box', padding: '0 8px', color });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>Treaty Metrics</div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 }}>
            Comparing <b style={{ color: '#4ade80' }}>{curYear}</b> (current) vs <b style={{ color: '#60a5fa' }}>{prevYear}</b> (previous)
            {prevLoading && ' — loading…'}
            {isManualMode && <span style={{ color: '#fbbf24' }}> — manual entry for previous year</span>}
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
            {curYear} vs {prevYear} — at a glance
          </div>
          <MetricBars rows={METRIC_ROWS
            .filter(r => r.dbPrev != null || manualPrev[r.key])
            .map(r => ({
              key: r.key, label: r.label,
              cur:  Number(String(r.fmt(r.cur)).replace(/[—%,]/g, '').trim()) || 0,
              prev: Number(String(getPrevDisplay(r)).replace(/,/g, '')) || 0,
            }))
            .filter(r => r.cur || r.prev)} />
        </div>
      ) : (
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table className="bbg-table" style={{ width: '100%', minWidth: 600 }}>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: 'center', width: '30%' }}>Metric</th>
              <th style={{ ...thS, width: '23%' }}><span style={{ color: '#4ade80' }}>{curYear}</span> Current</th>
              <th style={{ ...thS, width: '23%' }}><span style={{ color: '#60a5fa' }}>{prevYear}</span> Previous</th>
              <th style={{ ...thS, width: '16%' }}>Change</th>
            </tr>
          </thead>
          <tbody>
            {METRIC_ROWS.map(r => {
              const prevStr = getPrevDisplay(r);
              const chg = calcChange(r.cur, prevStr, r);
              return (
                <tr key={r.key}>
                  <td style={tdBase}>
                    <div style={{ ...cellRo, justifyContent: 'center', fontWeight: 650, color: 'rgba(226,232,240,0.88)', border: 'none', background: 'transparent', opacity: 1 }}>
                      {r.label}
                    </div>
                  </td>
                  <td style={tdBase}>
                    <div style={{ ...cellRo, fontWeight: 700, color: '#fff', opacity: 1 }}>
                      {r.fmt(r.cur)}
                    </div>
                  </td>
                  <td style={tdBase}>
                    <input
                      type="text"
                      inputMode="decimal"
                      style={inpS}
                      value={prevStr}
                      placeholder="0"
                      onChange={e => setManual(r.key, e.target.value)}
                    />
                  </td>
                  <td style={tdBase}>
                    <div style={changeCellS(chg.color)}>{chg.label}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      {!actuals.length && (
        <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
            No yearly data available for LR and margin averages. Add historical year rows in the Projected Summary to populate these metrics.
          </div>
        </div>
      )}
    </div>
  );
}
