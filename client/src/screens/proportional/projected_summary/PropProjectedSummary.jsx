import { useState, useEffect } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import { loadProjectedRows } from '../../../logic/projectWithSavedFactors';
import { loadLossCategoryByYear, deriveLossComponents } from '../../../logic/lossCategoryAmounts';
import { runFinancialEngine } from '../quick_summary/PropQuickSummary';
import { buildTreatyTerms } from '../../../logic/propTreatyEngine';
import { toN as cn } from '../../../utils/format';
import { logger } from '../../../utils/logger';

const ROUTE_KEY = 'PROP_PROJECTED_SUMMARY';

function fmt0(n) { return n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fPct(n) { return n == null ? '—' : `${(n * 100).toFixed(1)}%`; }
function lrCls(v) { return Number.isFinite(v) && v > 1.0 ? 'ps-cell--hot' : ''; }

export default function PropProjectedSummary() {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [topMetric, setTopMetric] = useState('PREMIUM');
  const [error, setError] = useState(null);
  const [source, setSource] = useState('');
  const [showAnalyses, setShowAnalyses] = useState(false);
  const [lossCat, setLossCat] = useState({ large: new Map(), cat: new Map() });
  const [showLossModal, setShowLossModal] = useState(false);
  const [modalTab, setModalTab] = useState('abs');
  const [terms, setTerms] = useState({});
  // Staleness of the dev factors driving this projection: the paid/OS
  // (incurred) and premium triangles, each compared against their saved
  // factors. Either being stale prompts a re-review.
  const [stale, setStale] = useState({ incurred: false, premium: false });
  // True when large/cat losses were edited after the loss selection was saved.
  const [lossStale, setLossStale] = useState(false);
  // True when the projection fell back to hard-coded placeholder benchmark
  // curves (no saved factors, no triangle, no saved blend).
  const [usedPlaceholderLdfs, setUsedPlaceholderLdfs] = useState(false);

  useEffect(() => {
    if (!contractId) return;
    // Guard against a stale response overwriting a newer one: switching contract
    // or toggling quote mode re-fires this effect, and an older in-flight load
    // must not clobber the current selection's projected figures.
    let cancelled = false;
    setLoading(true); setError(null);
    (async () => {
      try {
        /* ── Use saved dev factors via shared utility ── */
        // Incurred figures here are NOT read from stored INCURRED cells.
        // loadProjectedRows projects the STRIPPED (attritional) incurred
        // triangle with the saved INCURRED dev factors (falling back to PAID
        // factors, then a fresh weighted recalc) and adds the raw large/CAT
        // loadings back on top. r.projectedLosses is that full incurred total;
        // r.actualLosses is the raw full paid+OS latest diagonal.
        // deriveLossComponents below subtracts large/CAT back out to recover
        // the attritional component.
        const qm = appState.quoteMode ? { quote: true } : undefined;
        const contract = await api.getContract(contractId, qm).catch(() => ({}));
        const t = buildTreatyTerms(contract, appState.propTreatyDetail || {});
        if (cancelled) return;
        setTerms(t);
        const { rows: standardRows, source: src, usedPlaceholderLdfs: placeholder } = await loadProjectedRows(contractId, qm);
        const lc = await loadLossCategoryByYear(contractId, qm).catch(() => ({ large: new Map(), cat: new Map() }));
        if (cancelled) return;
        setSource(src || '');
        setUsedPlaceholderLdfs(!!placeholder);
        setLossCat(lc);

        if (standardRows && standardRows.length > 0) {
          // Raw projection outputs only. Loss components and the derived
          // Incurred (= Attritional + Large + CAT) are computed below via
          // deriveLossComponents so incurred is never an independent figure.
          setResults(standardRows.map(r => ({
            year: r.year,
            premium: r.actPrem, projectedPremium: r.ultPrem,
            actualLosses: r.actLoss, projectedLosses: r.ultLoss,
            ultPaid: r.ultPaid ?? null,
          })));
        } else {
          setResults([]);
        }
      } catch (e) {
        if (!cancelled) {
          logger.error('Projected Summary Load Failed', e);
          setError(e.message || 'Failed to load data');
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [appState.propTreatyDetail, appState.quoteMode, contractId]);

  /* Staleness: were the incurred (paid/OS) or premium triangles saved after
     their respective dev factors? Both endpoints fetched in parallel. */
  useEffect(() => {
    if (!contractId) return;
    let cancelled = false;
    const qm = appState.quoteMode ? { quote: true } : undefined;
    Promise.all([
      api.getDevFactorStaleness(contractId, 'INCURRED', qm).catch(() => null),
      api.getDevFactorStaleness(contractId, 'PREMIUM', qm).catch(() => null),
      api.getLossSelectionStaleness(contractId, qm).catch(() => null),
    ]).then(([inc, prem, loss]) => {
      if (cancelled) return;
      setStale({ incurred: !!inc?.stale, premium: !!prem?.stale });
      setLossStale(!!loss?.stale);
    });
    return () => { cancelled = true; };
  }, [appState.quoteMode, contractId]);

  /* ── Per-UW-year loss model ──
     PROJECTED basis: premium + incurred total are projected (dev factors via
     loadProjectedRows); large/CAT are NOT projected. ACTUAL basis: raw saved
     figures with no projection. Both bases route through deriveLossComponents,
     which enforces Incurred = Attritional + Large + CAT with zero-floored
     components — incurred is never sourced independently of its parts. */
  // When the treaty opts out of stripping, large/cat fold into attritional
  // (shown as nil) on both bases. Defaults to NOT stripping (full basis).
  const stripLC = appState.propTreatyDetail?.stripLargeCat === true;
  const rows = results.map(r => {
    const large = stripLC ? (lossCat.large.get(Number(r.year)) || 0) : 0;
    const cat = stripLC ? (lossCat.cat.get(Number(r.year)) || 0) : 0;
    return {
      year: r.year,
      ultPaid: r.ultPaid,
      proj: deriveLossComponents({ premium: r.projectedPremium, incurredTotal: r.projectedLosses, large, cat }),
      act: deriveLossComponents({ premium: r.premium, incurredTotal: r.actualLosses, large, cat }),
    };
  });

  /* Per-year financials (commission, brokerage, taxes, profit comm, LPC,
     result) from the shared Quick Summary engine, used to derive the
     expense / combined / result columns in the loss-breakdown modal. */
  const engineRows = results.map(r => ({
    year: r.year,
    ultPrem: r.projectedPremium,
    ultLoss: r.projectedLosses,
    actPrem: r.premium,
    actLoss: r.actualLosses,
  }));
  const finRows = Object.keys(terms).length > 0
    ? runFinancialEngine(engineRows, terms).rows
    : [];
  const finByYear = new Map(finRows.map(r => [r.year, r]));

  const save = async () => {
    if (!contractId || !rows.length) return true;
    try {
      const payload = [];
      rows.forEach(r => {
        payload.push({ uw_year: r.year, record_type: 'ACTUAL', ultimate_premium: r.act.premium, ultimate_loss: r.act.incurred, loss_ratio: r.act.incurredLR });
        payload.push({ uw_year: r.year, record_type: 'PROJECTED', ultimate_premium: r.proj.premium, ultimate_loss: r.proj.incurred, loss_ratio: r.proj.incurredLR });
      });
      await api.savePricingYearly(contractId, payload);
      return true;
    } catch (e) { logger.error('Save failed:', e); return false; }
  };

  const tPrem = rows.reduce((a, r) => a + r.act.premium, 0);
  const tUP = rows.reduce((a, r) => a + r.proj.premium, 0);
  const tAL = rows.reduce((a, r) => a + r.act.incurred, 0);
  const tUL = rows.reduce((a, r) => a + r.proj.incurred, 0);
  const tUPaid = rows.reduce((a, r) => a + (r.ultPaid || 0), 0);
  // Incurred ultimate is the derived projected incurred — never an independent value.
  const tUInc = tUL;
  const reservingDelta = tUPaid - tUInc;
  const reservingStatus = !Number.isFinite(reservingDelta) || (tUPaid === 0 && tUInc === 0)
    ? 'NONE'
    : reservingDelta > 0 ? 'UNDER' : reservingDelta < 0 ? 'OVER' : 'BALANCED';

  /* ── Loss-breakdown modal data (per underwriting year) ── */
  const sumYearRows = rs => {
    const premium = rs.reduce((a, r) => a + r.premium, 0);
    const attritional = rs.reduce((a, r) => a + r.attritional, 0);
    const large = rs.reduce((a, r) => a + r.large, 0);
    const cat = rs.reduce((a, r) => a + r.cat, 0);
    // Ratios aggregate as sum(ratio × premium) ÷ total premium — equivalent
    // to summing the underlying amounts then dividing, matching the LR rows.
    const expenseAmt = rs.reduce((a, r) => a + (r.expenseRatio || 0) * r.premium, 0);
    const combinedAmt = rs.reduce((a, r) => a + (r.combinedRatio || 0) * r.premium, 0);
    const resultAmt = rs.reduce((a, r) => a + (r.resultPct || 0) * r.premium, 0);
    const lr = n => (premium > 0 ? n / premium : 0);
    return {
      year: 'Total', premium, attritional, large, cat, incurred: attritional + large + cat,
      attrLR: lr(attritional), largeLR: lr(large), catLR: lr(cat), incurredLR: lr(attritional + large + cat),
      expenseRatio: lr(expenseAmt), combinedRatio: lr(combinedAmt), resultPct: lr(resultAmt),
    };
  };
  const lossModalBases = [
    {
      key: 'ACTUAL', label: 'Actual (Incurred)',
      rows: rows.map(r => {
        const fin = finByYear.get(r.year) || {};
        const prem = r.act.premium;
        const exp = prem > 0
          ? (cn(fin.actComm) + cn(fin.actBrokerage) + cn(fin.actTaxes) + cn(fin.actPC)) / prem
          : 0;
        const cr = prem > 0
          ? (r.act.incurred + cn(fin.actComm) + cn(fin.actBrokerage) + cn(fin.actTaxes) + cn(fin.actPC) - cn(fin.actLPC)) / prem
          : 0;
        const rp = prem > 0 ? cn(fin.actResult) / prem : 0;
        return { year: r.year, ...r.act, expenseRatio: exp, combinedRatio: cr, resultPct: rp };
      }),
    },
    {
      key: 'PROJECTED', label: 'Projected (Ultimate)',
      rows: rows.map(r => {
        const fin = finByYear.get(r.year) || {};
        const prem = r.proj.premium;
        const exp = prem > 0
          ? (cn(fin.comm) + cn(fin.brokerage) + cn(fin.taxes) + cn(fin.profitComm)) / prem
          : 0;
        const cr = prem > 0
          ? (r.proj.incurred + cn(fin.comm) + cn(fin.brokerage) + cn(fin.taxes) + cn(fin.profitComm) - cn(fin.lpc)) / prem
          : 0;
        const rp = prem > 0 ? cn(fin.result) / prem : 0;
        return { year: r.year, ...r.proj, expenseRatio: exp, combinedRatio: cr, resultPct: rp };
      }),
    },
  ];
  const renderLossCells = r => modalTab === 'abs' ? (
    <>
      <td className="ps-dash"><div className="ps-cell">{fmt0(r.premium)}</div></td>
      <td className="ps-dash"><div className="ps-cell">{fmt0(r.attritional)}</div></td>
      <td className="ps-dash"><div className="ps-cell">{fmt0(r.large)}</div></td>
      <td className="ps-dash"><div className="ps-cell">{fmt0(r.cat)}</div></td>
      <td className="ps-dash"><div className="ps-cell">{fPct(r.expenseRatio)}</div></td>
      <td className={`ps-dash ${lrCls(r.combinedRatio)}`}><div className="ps-cell">{fPct(r.combinedRatio)}</div></td>
      <td className={`ps-dash ${r.resultPct < 0 ? 'ps-cell--hot' : ''}`}><div className="ps-cell">{fPct(r.resultPct)}</div></td>
    </>
  ) : (
    <>
      <td className="ps-dash"><div className="ps-cell">{r.premium > 0 ? '100.0%' : '—'}</div></td>
      <td className={`ps-dash ${lrCls(r.attrLR)}`}><div className="ps-cell">{fPct(r.attrLR)}</div></td>
      <td className="ps-dash"><div className="ps-cell">{fPct(r.largeLR)}</div></td>
      <td className="ps-dash"><div className="ps-cell">{fPct(r.catLR)}</div></td>
      <td className="ps-dash"><div className="ps-cell">{fPct(r.expenseRatio)}</div></td>
      <td className={`ps-dash ${lrCls(r.combinedRatio)}`}><div className="ps-cell">{fPct(r.combinedRatio)}</div></td>
      <td className={`ps-dash ${r.resultPct < 0 ? 'ps-cell--hot' : ''}`}><div className="ps-cell">{fPct(r.resultPct)}</div></td>
    </>
  );

  /* ── Bar Chart ── */
  const BarChart = ({ title, subtitle, showToggle }) => {
    const years = rows.map(r => r.year);
    const isLoss = topMetric === 'LOSSES';
    const actSeries = rows.map(r => isLoss ? r.act.incurred : r.act.premium);
    const projSeries = rows.map(r => isLoss ? r.proj.incurred : r.proj.premium);
    const max = Math.max(...actSeries, ...projSeries, 1);
    const h = v => Math.max(2, Math.round((v / max) * 100));
    return (
      <div className="ps-card glass">
        <div className="ps-card-head">
          <div className="ps-card-head-left"><div className="ps-card-title">{title}</div><div className="ps-card-sub">{subtitle}</div></div>
          {showToggle && <div className="ps-card-head-right"><div className="ps-metric-toggle"><div className="toggle-group">
            <button type="button" className={`toggle-option ${topMetric === 'PREMIUM' ? 'active' : ''}`} style={topMetric === 'PREMIUM' ? undefined : { color: 'rgba(var(--text-rgb),.82)' }} onClick={() => setTopMetric('PREMIUM')}>Premium</button>
            <button type="button" className={`toggle-option ${topMetric === 'LOSSES' ? 'active' : ''}`} style={topMetric === 'LOSSES' ? undefined : { color: 'rgba(var(--text-rgb),.82)' }} onClick={() => setTopMetric('LOSSES')}>Losses</button>
          </div></div></div>}
        </div>
        <div className="ps-legend">
          <div className="ps-legend-item"><span className="ps-legend-dot ps-legend-dot--proj" /><span>Projected</span></div>
          <div className="ps-legend-item"><span className="ps-legend-dot ps-legend-dot--act" /><span>Actual</span></div>
        </div>
        <div className="ps-chart-shell"><div className="ps-chart-surface"><div className="ps-bars">
          {years.map((y, i) => <div key={y} className="ps-bars-col" title={String(y)}><div className="ps-bars-pair">
            <div className="ps-bar ps-bar--proj" style={{ height: `${h(projSeries[i])}%` }} />
            <div className="ps-bar ps-bar--act" style={{ height: `${h(actSeries[i])}%` }} />
          </div></div>)}
        </div></div><div className="ps-x-axis">{years.map(y => <div key={y} className="ps-x-tick">{y}</div>)}</div></div>
      </div>
    );
  };

  /* ── LR Chart ── */
  const LRChart = () => {
    const years = rows.map(r => r.year);
    const act = rows.map(r => r.act.incurredLR * 100), proj = rows.map(r => r.proj.incurredLR * 100);
    const max = Math.max(...act, ...proj, 1);
    const h = v => Math.max(2, Math.round((v / max) * 100));
    return (
      <div className="ps-card glass">
        <div className="ps-card-head"><div className="ps-card-head-left"><div className="ps-card-title">Projected vs Actual Loss Ratio</div><div className="ps-card-sub">Ultimate vs Incurred LR</div></div></div>
        <div className="ps-legend">
          <div className="ps-legend-item"><span className="ps-legend-dot ps-legend-dot--proj" /><span>Projected</span></div>
          <div className="ps-legend-item"><span className="ps-legend-dot ps-legend-dot--act" /><span>Actual</span></div>
        </div>
        <div className="ps-chart-shell"><div className="ps-chart-surface"><div className="ps-bars">
          {years.map((y, i) => <div key={y} className="ps-bars-col" title={String(y)}><div className="ps-bars-pair">
            <div className="ps-bar ps-bar--proj" style={{ height: `${h(proj[i])}%` }} />
            <div className="ps-bar ps-bar--act" style={{ height: `${h(act[i])}%` }} />
          </div></div>)}
        </div></div><div className="ps-x-axis">{years.map(y => <div key={y} className="ps-x-tick">{y}</div>)}</div></div>
      </div>
    );
  };

  /* Source label */
  const sourceLabel = source === 'saved-factors' ? 'Using saved underwriter dev factors'
    : source === 'triangle-recalc' ? 'Recalculated from triangle (no saved factors)'
    : source === 'straight-long' ? 'Long Tail portfolio dev factors'
    : source === 'straight-short' ? 'Short Tail portfolio dev factors'
    : '';

  const staleMessages = [];
  if (stale.premium && stale.incurred) staleMessages.push('Premium and incurred triangles updated since dev factors were last saved — consider reviewing.');
  else if (stale.incurred) staleMessages.push('Incurred triangle updated since dev factors were last saved — consider reviewing.');
  else if (stale.premium) staleMessages.push('Premium triangle updated since dev factors were last saved — consider reviewing.');
  if (lossStale) staleMessages.push('Loss selection is outdated — losses have changed since the last selection was saved.');

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Projected Summary" headerPill="PROPORTIONAL TREATY: PROJECTED SUMMARY" onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className="PROJECTED_SUMMARY_PAGE">
          {loading ? (
            <div className="df-card df-card--notice"><div className="df-note">Loading triangle data and running projections...</div></div>
          ) : error ? (
            <div className="df-card df-card--notice"><div className="df-note" style={{ color: '#f87171' }}>Error: {error}</div></div>
          ) : results.length === 0 ? (
            <div className="df-card df-card--notice"><div className="df-note">No data available. Enter data in triangles or the Experience (No Triangulation) screen first.</div></div>
          ) : (
            <div className="ps-page">
              <h2 className="ps-h2">Ultimate – Projected vs Actual
                {sourceLabel && <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 12, color: source === 'saved-factors' ? 'var(--accent)' : 'rgba(var(--text-rgb),.45)' }}>
                  ({sourceLabel})
                </span>}
              </h2>
              {usedPlaceholderLdfs && (
                <div role="alert" style={{ margin: '0 0 12px', padding: '12px 16px', borderRadius: 10, background: 'rgba(249,115,22,0.14)', border: '2px solid #f97316', color: 'var(--accent-amber)', fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>
                  No saved development factors found — projection is using placeholder benchmark curves. Go to the Development Factors screen to select and save factors before relying on these figures.
                </div>
              )}
              {staleMessages.length > 0 && (
                <div role="alert" style={{ margin: '0 0 12px', padding: '10px 14px', borderRadius: 10, background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.30)', color: 'var(--accent-amber)', fontSize: 12, lineHeight: 1.5 }}>
                  {staleMessages.map((m, i) => <div key={i}>{m}</div>)}
                </div>
              )}
              <div style={{
                margin: '4px 0 16px',
                padding: '10px 14px',
                borderRadius: 10,
                background: 'rgba(56,189,248,0.06)',
                border: '1px solid rgba(56,189,248,0.22)',
                fontSize: 12,
                color: 'rgba(var(--text-rgb),.78)',
                lineHeight: 1.5,
              }}>
                <b style={{ color: 'var(--accent-blue)', letterSpacing: '.04em' }}>UNCAPPED ULTIMATES.</b>{' '}
                Premium and loss values shown here are the raw triangle / dev-factor
                projections. Treaty caps, sliding commission, profit commission (with
                LCF) and loss-participation credits are <b>not</b> applied — those
                live on the Quick Summary screen, which produces a different loss
                ratio because claims are capped before the LR is computed.
              </div>
              <div className="ps-grid">
                {/* Left: Charts */}
                <div className="ps-col ps-stack">
                  <BarChart title={`Projected vs Actual – ${topMetric === 'LOSSES' ? 'Losses' : 'Premium'}`} subtitle="Comparison" showToggle />
                  <LRChart />
                </div>

                {/* Right: Tables */}
                <div className="ps-col">
                  <div className="ps-card glass">
                    <div className="ps-card-head"><div className="ps-card-title">Summary Statistics</div></div>

                    {/* Projected Ultimate table */}
                    <div className="ps-block">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <div className="ps-block-title" style={{ marginBottom: 0 }}>Projected Ultimate</div>
                        <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => setShowLossModal(true)}
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            padding: '6px 12px',
                            borderRadius: 8,
                            cursor: 'pointer',
                            border: '1px solid rgba(56,189,248,0.45)',
                            background: 'rgba(56,189,248,0.08)',
                            color: 'var(--accent-blue)',
                          }}
                        >
                          ▦ Loss Breakdown
                        </button>
                        <button
                          onClick={() => setShowAnalyses(s => !s)}
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            padding: '6px 12px',
                            borderRadius: 8,
                            cursor: 'pointer',
                            border: '1px solid rgba(99,102,241,0.45)',
                            background: showAnalyses ? 'rgba(99,102,241,0.20)' : 'rgba(99,102,241,0.08)',
                            color: 'var(--accent-blue)',
                          }}
                        >
                          {showAnalyses ? '▾ Analyses' : '▸ Analyses'}
                        </button>
                        </div>
                      </div>
                      {showAnalyses && (() => {
                        const classify = (paid, inc) => {
                          if (!Number.isFinite(paid) || !Number.isFinite(inc) || (paid === 0 && inc === 0)) return 'NONE';
                          const d = paid - inc;
                          return d > 0 ? 'UNDER' : d < 0 ? 'OVER' : 'BALANCED';
                        };
                        const toneFor = (status) => status === 'UNDER'
                          ? { bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.35)', text: 'var(--accent-rose)', label: 'Under Reserving', detail: 'Paid ultimate exceeds incurred ultimate — case reserves may be too low.' }
                          : status === 'OVER'
                            ? { bg: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.35)', text: 'var(--accent)', label: 'Over Reserving', detail: 'Incurred ultimate exceeds paid ultimate — case reserves may be conservative.' }
                            : status === 'BALANCED'
                              ? { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.35)', text: 'var(--muted)', label: 'Balanced', detail: 'Paid and incurred ultimates align.' }
                              : { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.35)', text: 'var(--muted)', label: 'No Data', detail: 'Paid and incurred projections are unavailable.' };
                        const combinedTone = toneFor(reservingStatus);
                        return (
                          <div style={{ marginBottom: 10 }}>
                            {/* ── Per-year comparison ── */}
                            <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--surface-hover)', border: '1px solid rgba(99,102,241,0.25)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-blue)', letterSpacing: '0.04em' }}>RESERVING ANALYSIS — PER YEAR</div>
                                <div style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.55)' }}>Paid Ultimate vs Incurred Ultimate</div>
                              </div>
                              <div className="ps-table-wrap">
                                <table className="ps-table">
                                  <thead><tr><th>UW Year</th><th>Paid Ult</th><th>Incurred Ult</th><th>Δ</th><th>Status</th></tr></thead>
                                  <tbody>
                                    {rows.map(r => {
                                      const incUlt = r.proj.incurred;
                                      const status = classify(r.ultPaid, incUlt);
                                      const t = toneFor(status);
                                      const delta = (r.ultPaid || 0) - incUlt;
                                      return (
                                        <tr key={r.year}>
                                          <td className="ps-year"><div className="ps-cell">{r.year}</div></td>
                                          <td className="ps-dash"><div className="ps-cell">{fmt0(r.ultPaid)}</div></td>
                                          <td className="ps-dash"><div className="ps-cell">{fmt0(incUlt)}</div></td>
                                          <td className="ps-dash"><div className="ps-cell" style={{ color: t.text }}>{fmt0(delta)}</div></td>
                                          <td className="ps-dash">
                                            <div className="ps-cell" style={{ display: 'inline-flex', padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', color: t.text, background: t.bg, border: `1px solid ${t.border}` }}>
                                              {t.label.toUpperCase()}
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                    <tr className="ps-total">
                                      <td className="ps-year"><div className="ps-cell">Combined</div></td>
                                      <td className="ps-dash"><div className="ps-cell">{fmt0(tUPaid)}</div></td>
                                      <td className="ps-dash"><div className="ps-cell">{fmt0(tUInc)}</div></td>
                                      <td className="ps-dash"><div className="ps-cell" style={{ color: combinedTone.text }}>{fmt0(reservingDelta)}</div></td>
                                      <td className="ps-dash">
                                        <div className="ps-cell" style={{ display: 'inline-flex', padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', color: combinedTone.text, background: combinedTone.bg, border: `1px solid ${combinedTone.border}` }}>
                                          {combinedTone.label.toUpperCase()}
                                        </div>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            </div>

                            {/* ── Combined verdict ── */}
                            <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10, background: combinedTone.bg, border: `1px solid ${combinedTone.border}` }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                                <div style={{ fontSize: 12, fontWeight: 800, color: combinedTone.text, letterSpacing: '0.04em' }}>COMBINED — {combinedTone.label.toUpperCase()}</div>
                                <div style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.55)' }}>Δ {fmt0(reservingDelta)}</div>
                              </div>
                              <div style={{ marginTop: 6, fontSize: 11, color: 'rgba(var(--text-rgb),.65)' }}>{combinedTone.detail}</div>
                            </div>
                          </div>
                        );
                      })()}
                      <div className="ps-table-wrap">
                        <table className="ps-table">
                          <thead><tr><th>UW Year</th><th>Premium</th><th>Ult. Losses</th><th>Ult. LR %</th></tr></thead>
                          <tbody>
                            {rows.map(r => (
                              <tr key={r.year}>
                                <td className="ps-year"><div className="ps-cell">{r.year}</div></td>
                                <td className="ps-dash"><div className="ps-cell">{fmt0(r.proj.premium)}</div></td>
                                <td className="ps-dash"><div className="ps-cell">{fmt0(r.proj.incurred)}</div></td>
                                <td className={`ps-dash ${lrCls(r.proj.incurredLR)}`}><div className="ps-cell">{fPct(r.proj.incurredLR)}</div></td>
                              </tr>
                            ))}
                            <tr className="ps-total" onClick={() => setShowLossModal(true)} style={{ cursor: 'pointer' }} title="View attritional / large / CAT loss breakdown">
                              <td className="ps-year"><div className="ps-cell">Total</div></td>
                              <td className="ps-dash"><div className="ps-cell">{fmt0(tUP)}</div></td>
                              <td className="ps-dash"><div className="ps-cell">{fmt0(tUL)}</div></td>
                              <td className={`ps-dash ${lrCls(tUP > 0 ? tUL / tUP : 0)}`}><div className="ps-cell">{fPct(tUP > 0 ? tUL / tUP : 0)}</div></td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Actual Incurred table */}
                    <div className="ps-block">
                      <div className="ps-block-title">Actual Incurred</div>
                      <div className="ps-table-wrap">
                        <table className="ps-table">
                          <thead><tr><th>UW Year</th><th>Premium</th><th>Incurred</th><th>Inc. LR %</th></tr></thead>
                          <tbody>
                            {rows.map(r => (
                              <tr key={r.year}>
                                <td className="ps-year"><div className="ps-cell">{r.year}</div></td>
                                <td className="ps-dash"><div className="ps-cell">{fmt0(r.act.premium)}</div></td>
                                <td className="ps-dash"><div className="ps-cell">{fmt0(r.act.incurred)}</div></td>
                                <td className={`ps-dash ${lrCls(r.act.incurredLR)}`}><div className="ps-cell">{fPct(r.act.incurredLR)}</div></td>
                              </tr>
                            ))}
                            <tr className="ps-total" onClick={() => setShowLossModal(true)} style={{ cursor: 'pointer' }} title="View attritional / large / CAT loss breakdown">
                              <td className="ps-year"><div className="ps-cell">Total</div></td>
                              <td className="ps-dash"><div className="ps-cell">{fmt0(tPrem)}</div></td>
                              <td className="ps-dash"><div className="ps-cell">{fmt0(tAL)}</div></td>
                              <td className={`ps-dash ${lrCls(tPrem > 0 ? tAL / tPrem : 0)}`}><div className="ps-cell">{fPct(tPrem > 0 ? tAL / tPrem : 0)}</div></td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {showLossModal && (
            <div
              // Backdrop dismissal is pointer-only; keyboard users close via the ✕ button.
              role="presentation"
              onClick={e => { if (e.target === e.currentTarget) setShowLossModal(false); }}
              style={{ position: 'fixed', inset: 0, zIndex: 120000, background: 'rgba(2,6,23,0.72)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            >
              <div role="dialog" aria-modal="true" className="glass" style={{ width: 'min(1380px,96vw)', maxHeight: '88vh', overflow: 'auto', borderRadius: 16, border: '1px solid var(--stroke-soft)', background: 'var(--panel-bg-strong)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--stroke-soft)' }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '0.03em', color: 'var(--text)' }}>Loss Breakdown — Actual vs Projected</div>
                    <div style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.5)', marginTop: 2 }}>Attritional = ultimate / incurred loss − large − CAT (raw incurred from the saved loss grids)</div>
                  </div>
                  <button onClick={() => setShowLossModal(false)} style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--stroke-soft)', background: 'transparent', color: 'rgba(var(--text-rgb),.7)', cursor: 'pointer', fontSize: 14 }}>✕</button>
                </div>
                <div style={{ display: 'flex', padding: '0 20px', borderBottom: '1px solid var(--stroke-soft)' }}>
                  {[{ k: 'abs', l: 'Amounts' }, { k: 'pct', l: 'Percentages' }].map(t => (
                    <button key={t.k} onClick={() => setModalTab(t.k)} style={{ padding: '12px 18px', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer', background: 'transparent', color: modalTab === t.k ? 'var(--accent-blue)' : 'rgba(var(--text-rgb),.45)', borderBottom: modalTab === t.k ? '2px solid var(--accent-blue)' : '2px solid transparent', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{t.l}</button>
                  ))}
                </div>
                <div style={{ padding: 20 }}>
                  {lossModalBases.map(base => (
                    <div key={base.key} style={{ marginBottom: 18 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.04em', color: 'var(--accent-blue)', marginBottom: 8 }}>{base.label}</div>
                      <div className="ps-table-wrap">
                        <table className="ps-table">
                          <thead><tr>
                            <th>UW Year</th><th>Premium</th><th>Attritional</th><th>Large Loss</th><th>CAT Loss</th><th>Expense Ratio</th><th>Combined Ratio</th><th>Result %</th>
                          </tr></thead>
                          <tbody>
                            {base.rows.map(r => (
                              <tr key={r.year}>
                                <td className="ps-year"><div className="ps-cell">{r.year}</div></td>
                                {renderLossCells(r)}
                              </tr>
                            ))}
                            <tr className="ps-total">
                              <td className="ps-year"><div className="ps-cell">Total</div></td>
                              {renderLossCells(sumYearRows(base.rows))}
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
