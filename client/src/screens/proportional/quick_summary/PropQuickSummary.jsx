import { useState, useEffect } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import { loadProjectedRows } from '../../../logic/projectWithSavedFactors';
import { loadLossCategoryByYear, deriveLossComponents } from '../../../logic/lossCategoryAmounts';
import { fmtOrEm as fmt } from '../../../utils/format';
import { logger } from '../../../utils/logger';
import {
  cn,
  applyLossCap,
  calcComm,
  makePCCalc,
  calcLPC,
  buildTreatyTerms,
} from '../../../logic/propTreatyEngine';

const ROUTE_KEY = 'PROP_QUICK_SUMMARY';

import PerformanceAnalysisModal from './PerformanceAnalysisModal';
function fp(n) { return n == null ? '—' : `${n.toFixed(1)}%`; }

/* ═══════════════════════════════════════════════════════════════
   FINANCIAL ENGINE
   Result = Premium - Claims(capped) - Commission - Brokerage
            - Taxes - ProfitComm + LPC
   ═══════════════════════════════════════════════════════════════ */
export function runFinancialEngine(standardRows, terms) {
  let cumResult = 0, actCumResult = 0, cumPremProj = 0, cumPremAct = 0;
  const pcProj = makePCCalc(terms);
  const pcAct = makePCCalc(terms);
  const ordered = [...standardRows].sort((a, b) => Number(a.year) - Number(b.year));
  const rows = ordered.map(row => {
    const yr = Number(row.year);
    /* Projected (ultimate) */
    const cappedUltLoss = applyLossCap(row.ultLoss, row.ultPrem, terms);
    const comm = calcComm(row.ultPrem, row.ultLoss, terms);
    const brok = row.ultPrem * (cn(terms.brokerage_pct) / 100);
    const taxes = row.ultPrem * (cn(terms.taxes_pct) / 100);
    const pc = pcProj(yr, row.ultPrem, row.ultLoss, comm);
    const lpc = calcLPC(row.ultPrem, row.ultLoss, terms);
    const result = row.ultPrem - cappedUltLoss - comm - brok - taxes - pc + lpc;
    cumResult += result; cumPremProj += row.ultPrem;

    /* Actual (incurred) */
    const cappedActLoss = applyLossCap(row.actLoss, row.actPrem, terms);
    const actComm = calcComm(row.actPrem, row.actLoss, terms);
    const actBrok = row.actPrem * (cn(terms.brokerage_pct) / 100);
    const actTaxes = row.actPrem * (cn(terms.taxes_pct) / 100);
    const actPC = pcAct(yr, row.actPrem, row.actLoss, actComm);
    const actLPC = calcLPC(row.actPrem, row.actLoss, terms);
    const actResult = row.actPrem - cappedActLoss - actComm - actBrok - actTaxes - actPC + actLPC;
    actCumResult += actResult; cumPremAct += row.actPrem;

    return {
      year: row.year,
      premium: row.ultPrem, ultClaims: cappedUltLoss, comm, profitComm: pc, brokerage: brok, taxes, lpc,
      result, cumResult, cumResultPct: cumPremProj > 0 ? (cumResult / cumPremProj) * 100 : 0,
      actPremium: row.actPrem, actClaims: cappedActLoss, actComm, actPC, actBrokerage: actBrok, actTaxes, actLPC,
      actResult, actCumResult, actCumResultPct: cumPremAct > 0 ? (actCumResult / cumPremAct) * 100 : 0,
    };
  });
  const sum = k => rows.reduce((a, b) => a + (b[k] || 0), 0);
  const totals = {
    premium: sum('premium'), ultClaims: sum('ultClaims'), comm: sum('comm'), profitComm: sum('profitComm'),
    brokerage: sum('brokerage'), taxes: sum('taxes'), lpc: sum('lpc'), result: sum('result'),
    cumResult, cumResultPct: cumPremProj > 0 ? (cumResult / cumPremProj) * 100 : 0,
    actPremium: sum('actPremium'), actClaims: sum('actClaims'), actComm: sum('actComm'), actPC: sum('actPC'),
    actBrokerage: sum('actBrokerage'), actTaxes: sum('actTaxes'), actLPC: sum('actLPC'), actResult: sum('actResult'),
    actCumResult, actCumResultPct: cumPremAct > 0 ? (actCumResult / cumPremAct) * 100 : 0,
  };
  return { rows, totals };
}

function calcStats(rows) {
  const lrs = rows.filter(r => r.actPremium > 0).map(r => (r.actClaims / r.actPremium) * 100);
  if (!lrs.length) return null;
  const n = lrs.length, mean = lrs.reduce((a, b) => a + b, 0) / n;
  const variance = lrs.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);
  const sorted = [...lrs].sort((a, b) => a - b);
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const m3 = lrs.reduce((a, b) => a + Math.pow(b - mean, 3), 0) / n;
  const skewness = stdDev > 0 ? m3 / Math.pow(stdDev, 3) : 0;
  const m4 = lrs.reduce((a, b) => a + Math.pow(b - mean, 4), 0) / n;
  const kurtosis = variance > 0 ? m4 / (variance * variance) - 3 : 0;
  const sortedDesc = [...lrs].sort((a, b) => b - a);
  const var95 = sortedDesc[Math.floor(n * 0.05)] || sortedDesc[0];
  const var99 = sortedDesc[Math.floor(n * 0.01)] || sortedDesc[0];
  const cv = mean > 0 ? (stdDev / mean) * 100 : 0;
  const iqr = n >= 4 ? sorted[Math.floor(n * 0.75)] - sorted[Math.floor(n * 0.25)] : 0;
  return { mean, median, min: Math.min(...lrs), max: Math.max(...lrs), stdDev, skewness, kurtosis, var95, var99, cv, iqr, n };
}

/* Embeddable version for use in modals (no WizardLayout) */
export function QuickSummaryEmbed({ contractId: propContractId }) {
  const fallbackId = useContractId();
  const contractId = propContractId || fallbackId;
  const { state: appState } = useAppState();
  const [calcRows, setCalcRows] = useState([]);
  const [totals, setTotals] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lossCat, setLossCat] = useState({ large: new Map(), cat: new Map() });
  const [stripLC, setStripLC] = useState(false);

  useEffect(() => {
    if (!contractId) return;
    // Guard against a stale response overwriting a newer one: switching contract
    // or toggling quote mode re-fires this effect, and an older in-flight load
    // must not clobber the current selection's figures (would show the wrong
    // contract's/mode's pricing).
    let cancelled = false;
    setLoading(true); setError(null);
    const qm = appState.quoteMode ? { quote: true } : undefined;
    (async () => {
      try {
        const contract = await api.getContract(contractId, qm).catch(() => ({}));
        const t = buildTreatyTerms(contract, appState.propTreatyDetail || {});
        if (cancelled) return;
        setStripLC(t.strip_large_cat === true);
        const { rows: standardRows } = await loadProjectedRows(contractId, qm);
        if (cancelled) return;
        if (!standardRows || standardRows.length === 0) { setCalcRows([]); setLoading(false); return; }
        const { rows, totals: tot } = runFinancialEngine(standardRows, t);
        const lc = await loadLossCategoryByYear(contractId, qm).catch(() => ({ large: new Map(), cat: new Map() }));
        if (cancelled) return;
        setCalcRows(rows); setTotals(tot);
        setLossCat(lc);
      } catch (e) { if (!cancelled) { logger.error('Quick Summary Embed Load Failed', e); setError(e.message); } }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [appState.propTreatyDetail, appState.quoteMode, contractId]);

  /* The embed renders inside the pricing screen's Bloomberg insight modal
     (.bbg-modal — intentionally dark in every theme), so hardcoded light
     text here is correct. */
  if (loading) return <div style={{padding:40,textAlign:'center',color:'rgba(255,255,255,0.5)'}}>Loading Quick Summary...</div>;
  if (error) return <div style={{padding:40,textAlign:'center',color:'#f87171'}}>Error: {error}</div>;
  if (!calcRows.length) return <div style={{padding:40,textAlign:'center',color:'rgba(255,255,255,0.5)'}}>No triangle data available for Quick Summary.</div>;

  const TD = ({ v, pct, neg, pos }) => (
    <td className={neg ? 'qs-val--neg' : pos ? 'qs-val--pos' : ''}><div className="qs-td qs-td--num">{pct ? fp(v) : fmt(v)}</div></td>
  );
  const largeAmt = yr => (stripLC ? (lossCat.large.get(Number(yr)) || 0) : 0);
  const catAmt = yr => (stripLC ? (lossCat.cat.get(Number(yr)) || 0) : 0);
  const projComp = r => deriveLossComponents({ premium: r.premium, incurredTotal: r.ultClaims, large: largeAmt(r.year), cat: catAmt(r.year) });
  const actComp = r => deriveLossComponents({ premium: r.actPremium, incurredTotal: r.actClaims, large: largeAmt(r.year), cat: catAmt(r.year) });
  const sumComp = (fn, key) => calcRows.reduce((a, r) => a + fn(r)[key], 0);
  const ultLR = totals.premium > 0 ? (totals.ultClaims / totals.premium * 100) : 0;
  const actLR = totals.actPremium > 0 ? (totals.actClaims / totals.actPremium * 100) : 0;

  return (
    <div className="QUICK_SUMMARY_PAGE" style={{padding:0}}>
      <div style={{display:'flex',gap:8,marginBottom:16}}>
        <div style={{flex:1,background:'rgba(0,232,184,0.08)',borderRadius:8,padding:'12px 16px'}}>
          <div style={{fontSize:11,color:'rgba(255,255,255,0.5)',marginBottom:4}}>Ult. Loss Ratio</div>
          <div style={{fontSize:22,fontWeight:800,color:'#00e8b8'}}>{fp(ultLR)}</div>
        </div>
        <div style={{flex:1,background:'rgba(56,189,248,0.08)',borderRadius:8,padding:'12px 16px'}}>
          <div style={{fontSize:11,color:'rgba(255,255,255,0.5)',marginBottom:4}}>Inc. Loss Ratio</div>
          <div style={{fontSize:22,fontWeight:800,color:'#00d4ff'}}>{fp(actLR)}</div>
        </div>
        <div style={{flex:1,background:'rgba(255,187,0,0.08)',borderRadius:8,padding:'12px 16px'}}>
          <div style={{fontSize:11,color:'rgba(255,255,255,0.5)',marginBottom:4}}>Ult. Result</div>
          <div style={{fontSize:22,fontWeight:800,color:totals.result>=0?'#00e8b8':'#ff4d4d'}}>{fmt(totals.result)}</div>
        </div>
      </div>
      <div style={{fontSize:12,fontWeight:700,color:'#ff9600',marginBottom:8}}>PROJECTED (ULTIMATE)</div>
      <div className="qs-table-shell" style={{marginBottom:20}}><table className="qs-table qs-stats qs-table-modern qs-table--scroll">
        <thead><tr><th className="qs-left">UW Year</th><th>Premium</th><th>Attritional Loss</th><th>Large Loss</th><th>CAT Loss</th><th>Commission</th><th>Brokerage</th><th>Taxes</th><th>Result</th><th>Cum. %</th></tr></thead>
        <tbody>
          {calcRows.map(r => { const c = projComp(r); return (<tr key={r.year}><th className="qs-left qs-year">{r.year}</th>
            <TD v={r.premium}/><TD v={c.attritional}/><TD v={c.large}/><TD v={c.cat}/><TD v={r.comm}/><TD v={r.brokerage}/><TD v={r.taxes}/>
            <TD v={r.result} neg={r.result<0} pos={r.result>0}/><TD v={r.cumResultPct} pct neg={r.cumResultPct<0} pos={r.cumResultPct>0}/></tr>); })}
          <tr className="qs-total"><th className="qs-left qs-year">Total</th>
            <TD v={totals.premium}/><TD v={sumComp(projComp, 'attritional')}/><TD v={sumComp(projComp, 'large')}/><TD v={sumComp(projComp, 'cat')}/><TD v={totals.comm}/><TD v={totals.brokerage}/><TD v={totals.taxes}/>
            <TD v={totals.result} neg={totals.result<0} pos={totals.result>0}/><TD v={totals.cumResultPct} pct neg={totals.cumResultPct<0} pos={totals.cumResultPct>0}/></tr>
        </tbody>
      </table></div>
      <div style={{fontSize:12,fontWeight:700,color:'#00d4ff',marginBottom:8}}>ACTUAL (INCURRED)</div>
      <div className="qs-table-shell"><table className="qs-table qs-stats qs-table-modern qs-table--scroll">
        <thead><tr><th className="qs-left">UW Year</th><th>Premium</th><th>Attritional Loss</th><th>Large Loss</th><th>CAT Loss</th><th>Commission</th><th>Brokerage</th><th>Taxes</th><th>Result</th><th>Cum. %</th></tr></thead>
        <tbody>
          {calcRows.map(r => { const c = actComp(r); return (<tr key={r.year}><th className="qs-left qs-year">{r.year}</th>
            <TD v={r.actPremium}/><TD v={c.attritional}/><TD v={c.large}/><TD v={c.cat}/><TD v={r.actComm}/><TD v={r.actBrokerage}/><TD v={r.actTaxes}/>
            <TD v={r.actResult} neg={r.actResult<0} pos={r.actResult>0}/><TD v={r.actCumResultPct} pct neg={r.actCumResultPct<0} pos={r.actCumResultPct>0}/></tr>); })}
          <tr className="qs-total"><th className="qs-left qs-year">Total</th>
            <TD v={totals.actPremium}/><TD v={sumComp(actComp, 'attritional')}/><TD v={sumComp(actComp, 'large')}/><TD v={sumComp(actComp, 'cat')}/><TD v={totals.actComm}/><TD v={totals.actBrokerage}/><TD v={totals.actTaxes}/>
            <TD v={totals.actResult} neg={totals.actResult<0} pos={totals.actResult>0}/><TD v={totals.actCumResultPct} pct neg={totals.actCumResultPct<0} pos={totals.actCumResultPct>0}/></tr>
        </tbody>
      </table></div>
    </div>
  );
}

export default function PropQuickSummary() {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const [calcRows, setCalcRows] = useState([]);
  const [totals, setTotals] = useState({});
  const [terms, setTerms] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null);
  const [showPerfAnalysis, setShowPerfAnalysis] = useState(false);
  const [projSource, setProjSource] = useState('');
  const [lossCat, setLossCat] = useState({ large: new Map(), cat: new Map() });

  useEffect(() => {
    if (!contractId) return;
    // See QuickSummaryEmbed above: guard against a stale load overwriting the
    // current contract's/mode's figures when the deps change mid-flight.
    let cancelled = false;
    setLoading(true); setError(null);
    const qm = appState.quoteMode ? { quote: true } : undefined;
    (async () => {
      try {
        const contract = await api.getContract(contractId, qm).catch(() => ({}));
        const t = buildTreatyTerms(contract, appState.propTreatyDetail || {});
        if (cancelled) return;
        setTerms(t);

        /* ── Use saved dev factors via shared utility ── */
        const { rows: standardRows, source } = await loadProjectedRows(contractId, qm);
        if (cancelled) return;
        setProjSource(source || '');

        if (!standardRows || standardRows.length === 0) { setCalcRows([]); setLoading(false); return; }
        const { rows, totals: tot } = runFinancialEngine(standardRows, t);
        const lc = await loadLossCategoryByYear(contractId, qm).catch(() => ({ large: new Map(), cat: new Map() }));
        if (cancelled) return;
        setCalcRows(rows); setTotals(tot);
        setLossCat(lc);
      } catch (e) { if (!cancelled) { logger.error('Quick Summary Load Failed', e); setError(e.message); } }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [appState.propTreatyDetail, appState.quoteMode, contractId]);

  const stats = calcStats(calcRows);

  /* Loss components per UW year. Projected basis uses the projected (capped)
     claims; actual basis uses the unprojected (capped) incurred. Both route
     through deriveLossComponents so attritional/large/cat are zero-floored and
     claims = attritional + large + cat. Large/CAT are the same raw saved
     figures in both bases. */
  // When the treaty opts out of stripping, large/cat fold into attritional
  // (shown as nil); otherwise they come from the saved loss grids.
  const stripLC = terms?.strip_large_cat === true;
  const largeAmt = yr => (stripLC ? (lossCat.large.get(Number(yr)) || 0) : 0);
  const catAmt = yr => (stripLC ? (lossCat.cat.get(Number(yr)) || 0) : 0);
  const projComp = r => deriveLossComponents({ premium: r.premium, incurredTotal: r.ultClaims, large: largeAmt(r.year), cat: catAmt(r.year) });
  const actComp = r => deriveLossComponents({ premium: r.actPremium, incurredTotal: r.actClaims, large: largeAmt(r.year), cat: catAmt(r.year) });
  const sumComp = (fn, key) => calcRows.reduce((a, r) => a + fn(r)[key], 0);

  const TD = ({ v, pct, neg, pos }) => (
    <td className={neg ? 'qs-val--neg' : pos ? 'qs-val--pos' : ''}><div className="qs-td qs-td--num">{pct ? fp(v) : fmt(v)}</div></td>
  );

  const KPIRow = ({ items }) => (
    <div className="qs-kpis">
      {items.map((item, i) => (
        <div key={i} className={`qs-kpi ${item.color || ''}`}>
          <div className="qs-kpi-label">{item.label}</div>
          <div className="qs-kpi-value">{item.value}</div>
        </div>
      ))}
    </div>
  );

  /* ═══════════════ PROJECTED TABLE ═══════════════ */
  const ProjectedTable = () => {
    const ultLR = totals.premium > 0 ? (totals.ultClaims / totals.premium * 100) : 0;
    const ultCR = totals.premium > 0 ? ((totals.ultClaims + totals.comm + totals.brokerage + totals.taxes + totals.profitComm - totals.lpc) / totals.premium * 100) : 0;
    return (
      <div className="qs-card qs-card--green">
        <div className="qs-card-head"><div><div className="qs-card-title">Projected by Underwriting Year (Ultimate)</div><div className="qs-card-sub">
          Based on Ultimate Loss Projections + Treaty Terms
          {projSource === 'saved-factors' && <span style={{ marginLeft: 8, color: 'var(--accent)', fontSize: 11 }}>● Using saved dev factors</span>}
          {projSource === 'triangle-recalc' && <span style={{ marginLeft: 8, color: 'var(--accent-amber)', fontSize: 11 }}>● Recalculated (no saved factors)</span>}
        </div></div>
          <div className="qs-card-chip qs-card-chip--green">PROJECTED</div></div>
        <KPIRow items={[
          { label: 'Total Ult. Premium', value: fmt(totals.premium), color: 'qs-kpi--green' },
          { label: 'Total Ult. Claims', value: fmt(totals.ultClaims), color: 'qs-kpi--blue' },
          { label: 'Ult. Loss Ratio', value: fp(ultLR) },
          { label: 'Ult. Combined Ratio', value: fp(ultCR) },
        ]} />
        <div className="qs-table-shell"><table className="qs-table qs-stats qs-table-modern qs-table--scroll">
          <thead><tr><th className="qs-left">UW Year</th><th>Premium</th><th>Attritional Loss</th><th>Large Loss</th><th>CAT Loss</th><th>Commission</th><th>Profit Comm.</th><th>Brokerage</th><th>Taxes</th><th>LPC</th><th>Result</th><th>Cumulative</th><th>Cum. %</th></tr></thead>
          <tbody>
            {calcRows.map(r => {
              const c = projComp(r);
              return (
              <tr key={r.year}><th className="qs-left qs-year">{r.year}</th>
                <TD v={r.premium}/><TD v={c.attritional}/><TD v={c.large}/><TD v={c.cat}/><TD v={r.comm}/><TD v={r.profitComm}/><TD v={r.brokerage}/>
                <TD v={r.taxes}/><TD v={r.lpc}/><TD v={r.result} neg={r.result<0} pos={r.result>0}/><TD v={r.cumResult} neg={r.cumResult<0} pos={r.cumResult>0}/><TD v={r.cumResultPct} pct neg={r.cumResultPct<0} pos={r.cumResultPct>0}/></tr>
              );
            })}
            <tr className="qs-total"><th className="qs-left qs-year">Total</th>
              <TD v={totals.premium}/><TD v={sumComp(projComp, 'attritional')}/><TD v={sumComp(projComp, 'large')}/><TD v={sumComp(projComp, 'cat')}/><TD v={totals.comm}/><TD v={totals.profitComm}/><TD v={totals.brokerage}/>
              <TD v={totals.taxes}/><TD v={totals.lpc}/><TD v={totals.result} neg={totals.result<0} pos={totals.result>0}/><TD v={totals.cumResult} neg={totals.cumResult<0} pos={totals.cumResult>0}/><TD v={totals.cumResultPct} pct neg={totals.cumResultPct<0} pos={totals.cumResultPct>0}/></tr>
          </tbody>
        </table></div>
      </div>
    );
  };

  /* ═══════════════ ACTUAL TABLE ═══════════════ */
  const ActualTable = () => {
    const actLR = totals.actPremium > 0 ? (totals.actClaims / totals.actPremium * 100) : 0;
    const actCR = totals.actPremium > 0 ? ((totals.actClaims + totals.actComm + totals.actBrokerage + totals.actTaxes + totals.actPC - totals.actLPC) / totals.actPremium * 100) : 0;
    return (
      <div className="qs-card qs-card--blue">
        <div className="qs-card-head"><div><div className="qs-card-title">Actual by Underwriting Year (Incurred)</div><div className="qs-card-sub">Based on current Incurred (Paid + OS) positions</div></div>
          <div className="qs-card-chip qs-card-chip--blue">ACTUAL</div></div>
        <KPIRow items={[
          { label: 'Total Act. Premium', value: fmt(totals.actPremium), color: 'qs-kpi--green' },
          { label: 'Total Inc. Claims', value: fmt(totals.actClaims), color: 'qs-kpi--blue' },
          { label: 'Inc. Loss Ratio', value: fp(actLR) },
          { label: 'Inc. Combined Ratio', value: fp(actCR) },
        ]} />
        <div className="qs-table-shell"><table className="qs-table qs-stats qs-table-modern qs-table--scroll">
          <thead><tr><th className="qs-left">UW Year</th><th>Premium</th><th>Attritional Loss</th><th>Large Loss</th><th>CAT Loss</th><th>Commission</th><th>Profit Comm.</th><th>Brokerage</th><th>Taxes</th><th>LPC</th><th>Result</th><th>Cumulative</th><th>Cum. %</th></tr></thead>
          <tbody>
            {calcRows.map(r => {
              const c = actComp(r);
              return (
              <tr key={r.year}><th className="qs-left qs-year">{r.year}</th>
                <TD v={r.actPremium}/><TD v={c.attritional}/><TD v={c.large}/><TD v={c.cat}/><TD v={r.actComm}/><TD v={r.actPC}/><TD v={r.actBrokerage}/>
                <TD v={r.actTaxes}/><TD v={r.actLPC}/><TD v={r.actResult} neg={r.actResult<0} pos={r.actResult>0}/><TD v={r.actCumResult} neg={r.actCumResult<0} pos={r.actCumResult>0}/><TD v={r.actCumResultPct} pct neg={r.actCumResultPct<0} pos={r.actCumResultPct>0}/></tr>
              );
            })}
            <tr className="qs-total"><th className="qs-left qs-year">Total</th>
              <TD v={totals.actPremium}/><TD v={sumComp(actComp, 'attritional')}/><TD v={sumComp(actComp, 'large')}/><TD v={sumComp(actComp, 'cat')}/><TD v={totals.actComm}/><TD v={totals.actPC}/><TD v={totals.actBrokerage}/>
              <TD v={totals.actTaxes}/><TD v={totals.actLPC}/><TD v={totals.actResult} neg={totals.actResult<0} pos={totals.actResult>0}/><TD v={totals.actCumResult} neg={totals.actCumResult<0} pos={totals.actCumResult>0}/><TD v={totals.actCumResultPct} pct neg={totals.actCumResultPct<0} pos={totals.actCumResultPct>0}/></tr>
          </tbody>
        </table></div>
      </div>
    );
  };

  /* ═══════════════ STATS MODAL ═══════════════ */
  const StatsModal = () => {
    if (!modal) return null;
    const isAnalysis = modal === 'analysis';
    return (
      <div className="qs-modal-backdrop is-open" role="presentation" onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
        <div className={`qs-modal glass ${isAnalysis ? 'qs-modal--compact' : ''}`} role="dialog">
          <div className="qs-modal-head">
            <div className="qs-modal-title">{isAnalysis ? 'Portfolio Analysis' : 'Portfolio Stats'}</div>
            <button className="qs-x" onClick={() => setModal(null)}>✕</button>
          </div>
          <div className="qs-modal-body">
            {isAnalysis ? (
              stats ? (
                <div className="qs-analysis-centered">
                  <div className="qs-right-h2">Loss Ratio Distribution Analysis</div>
                  <div className="qs-analysis-sub">Based on {stats.n} underwriting years of incurred data</div>
                  <div className="qs-metrics-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                    <div className="qs-metric-card qs-metric--blue"><div className="qs-metric-title">Mean LR</div><div className="qs-metric-value">{stats.mean.toFixed(1)}%</div></div>
                    <div className="qs-metric-card qs-metric--green"><div className="qs-metric-title">Median LR</div><div className="qs-metric-value">{stats.median.toFixed(1)}%</div></div>
                    <div className="qs-metric-card qs-metric--amber"><div className="qs-metric-title">Std. Deviation</div><div className="qs-metric-value">{stats.stdDev.toFixed(2)}</div></div>
                    <div className="qs-metric-card qs-metric--green"><div className="qs-metric-title">Min LR</div><div className="qs-metric-value">{stats.min.toFixed(1)}%</div></div>
                    <div className="qs-metric-card qs-metric--slate"><div className="qs-metric-title">Max LR</div><div className="qs-metric-value">{stats.max.toFixed(1)}%</div></div>
                    <div className="qs-metric-card"><div className="qs-metric-title">Range</div><div className="qs-metric-value">{(stats.max - stats.min).toFixed(1)}</div></div>
                    <div className="qs-metric-card qs-metric--purple"><div className="qs-metric-title">Skewness</div><div className="qs-metric-value">{stats.skewness.toFixed(3)}</div><div className="qs-metric-desc">{stats.skewness > 0.5 ? 'Right-skewed' : stats.skewness < -0.5 ? 'Left-skewed' : 'Approx. symmetric'}</div></div>
                    <div className="qs-metric-card qs-metric--purple"><div className="qs-metric-title">Excess Kurtosis</div><div className="qs-metric-value">{stats.kurtosis.toFixed(3)}</div><div className="qs-metric-desc">{stats.kurtosis > 1 ? 'Heavy-tailed' : stats.kurtosis < -1 ? 'Light-tailed' : 'Near-normal'}</div></div>
                    <div className="qs-metric-card"><div className="qs-metric-title">Coeff. of Variation</div><div className="qs-metric-value">{stats.cv.toFixed(1)}%</div></div>
                  </div>
                  <div className="qs-right-h2" style={{ marginTop: 24 }}>Risk Measures</div>
                  <div className="qs-metrics-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                    <div className="qs-metric-card qs-metric--slate"><div className="qs-metric-title">VaR (95%)</div><div className="qs-metric-value">{stats.var95.toFixed(1)}%</div><div className="qs-metric-desc">1-in-20 year scenario</div></div>
                    <div className="qs-metric-card qs-metric--slate"><div className="qs-metric-title">VaR (99%)</div><div className="qs-metric-value">{stats.var99.toFixed(1)}%</div><div className="qs-metric-desc">1-in-100 year scenario</div></div>
                    <div className="qs-metric-card"><div className="qs-metric-title">IQR</div><div className="qs-metric-value">{stats.iqr.toFixed(1)}</div><div className="qs-metric-desc">Interquartile range</div></div>
                  </div>
                </div>
              ) : <div className="muted" style={{ padding: 20, textAlign: 'center' }}>No data for analysis.</div>
            ) : (
              <div className="qs-modal-grid">
                <div className="qs-modal-section" style={{ gridColumn: '1 / -1' }}>
                  <div className="qs-right-h2">UW Year Statistics (Actuals)</div>
                  <div className="qs-table-wrap">
                    <table className="qs-table qs-stats qs-table-modern qs-table--scroll">
                      <thead><tr><th className="qs-left">UW Year</th><th>Loss Ratio</th><th>Attritional LR</th><th>Large Loss LR</th><th>CAT Loss LR</th><th>Expense Ratio</th><th>Combined Ratio</th><th>Result %</th><th>Cum. Result %</th></tr></thead>
                      <tbody>
                        {calcRows.map(r => {
                          const c = actComp(r);
                          const exp = r.actComm + r.actBrokerage + r.actTaxes + r.actPC;
                          const lr = r.actPremium > 0 ? (r.actClaims / r.actPremium) * 100 : 0;
                          const er = r.actPremium > 0 ? (exp / r.actPremium) * 100 : 0;
                          const lpcPct = r.actPremium > 0 ? (r.actLPC / r.actPremium) * 100 : 0;
                          const rp = r.actPremium > 0 ? (r.actResult / r.actPremium) * 100 : 0;
                          return (<tr key={r.year}><th className="qs-left qs-year">{r.year}</th>
                            <td>{fp(lr)}</td>
                            <td>{fp(c.attrLR * 100)}</td><td>{fp(c.largeLR * 100)}</td><td>{fp(c.catLR * 100)}</td>
                            <td>{fp(er)}</td><td>{fp(lr + er - lpcPct)}</td>
                            <td className={rp < 0 ? 'qs-neg' : 'qs-pos'}>{fp(rp)}</td>
                            <td className={r.actCumResultPct < 0 ? 'qs-neg' : 'qs-pos'}>{fp(r.actCumResultPct)}</td></tr>);
                        })}
                        <tr className="qs-total"><th className="qs-left qs-year">Total</th>
                          <td>{fp(totals.actPremium > 0 ? (totals.actClaims / totals.actPremium) * 100 : 0)}</td>
                          <td>{fp(totals.actPremium > 0 ? (sumComp(actComp, 'attritional') / totals.actPremium) * 100 : 0)}</td>
                          <td>{fp(totals.actPremium > 0 ? (sumComp(actComp, 'large') / totals.actPremium) * 100 : 0)}</td>
                          <td>{fp(totals.actPremium > 0 ? (sumComp(actComp, 'cat') / totals.actPremium) * 100 : 0)}</td>
                          <td>{fp(totals.actPremium > 0 ? ((totals.actComm + totals.actBrokerage + totals.actTaxes + totals.actPC) / totals.actPremium) * 100 : 0)}</td>
                          <td>{fp(totals.actPremium > 0 ? ((totals.actClaims + totals.actComm + totals.actBrokerage + totals.actTaxes + totals.actPC - totals.actLPC) / totals.actPremium) * 100 : 0)}</td>
                          <td className={totals.actResult < 0 ? 'qs-neg' : 'qs-pos'}>{fp(totals.actPremium > 0 ? (totals.actResult / totals.actPremium) * 100 : 0)}</td>
                          <td className={totals.actCumResultPct < 0 ? 'qs-neg' : 'qs-pos'}>{fp(totals.actCumResultPct)}</td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="qs-modal-section">
                  <div className="qs-right-h2">Current Terms</div>
                  <div className="qs-table-wrap qs-table-wrap--tight">
                    <table className="qs-table qs-terms qs-table-modern">
                      <thead><tr><th className="qs-left">Term</th><th>Value</th></tr></thead>
                      <tbody>
                        <tr><th className="qs-left qs-term">Comm Mode</th><td>{terms.mode || 'FIXED'}</td></tr>
                        {(terms.mode || 'FIXED').toUpperCase() === 'SLIDING' ? (() => {
                          const tbl = (terms.sliding_table || [])
                            .map(r => ({ lr: cn(r.loss_ratio_pct ?? r.lossRatioPct), c: cn(r.commission_pct ?? r.commissionPct) }))
                            .filter(p => Number.isFinite(p.lr) && Number.isFinite(p.c))
                            .sort((a, b) => a.lr - b.lr);
                          if (tbl.length >= 2) return tbl.map((p, i) => (
                            <tr key={i}><th className="qs-left qs-term">{i === 0 ? 'Sliding Table' : ''}</th><td>{p.lr}% LR → {p.c}% comm</td></tr>
                          ));
                          return (<>
                            <tr><th className="qs-left qs-term">Min LR / Max Comm</th><td>{terms.sliding_min_loss_ratio || 0}% / {terms.sliding_max_commission || 0}%</td></tr>
                            <tr><th className="qs-left qs-term">Max LR / Min Comm</th><td>{terms.sliding_max_loss_ratio || 0}% / {terms.sliding_min_commission || 0}%</td></tr>
                          </>);
                        })() : (
                          <tr><th className="qs-left qs-term">Fixed Comm</th><td>{terms.fixed_commission_pct || 0}%</td></tr>
                        )}
                        <tr><th className="qs-left qs-term">Profit Comm</th><td>{terms.profit_commission_pct || 0}%</td></tr>
                        {cn(terms.lcf_years) > 0 && (
                          <tr><th className="qs-left qs-term">Loss Carry Fwd</th><td>{cn(terms.lcf_years)} yrs{terms.lcf_extinction ? ' (extinction)' : ''}</td></tr>
                        )}
                        <tr><th className="qs-left qs-term">Mgmt Expenses</th><td>{terms.mgmt_expenses_pct || 0}%</td></tr>
                        <tr><th className="qs-left qs-term">Brokerage</th><td>{terms.brokerage_pct || 0}%</td></tr>
                        <tr><th className="qs-left qs-term">Taxes</th><td>{terms.taxes_pct || 0}%</td></tr>
                        {cn(terms.loss_cap_pct) > 0 && <tr><th className="qs-left qs-term">Loss Cap</th><td>{terms.loss_cap_pct}%</td></tr>}
                        {terms.lp_enabled && (() => {
                          const corridors = (terms.lp_slides || [])
                            .map(r => ({ minLr: cn(r.min_lr ?? r.minLr), maxLr: cn(r.max_lr ?? r.maxLr), share: cn(r.share) }))
                            .filter(r => r.share > 0 && r.maxLr > r.minLr);
                          const useTable = corridors.length > 1;
                          return (<>
                            {/* StatsModal sits on the dark qs-modal shell (dark in every theme) — keep light text. */}
                            <tr><th className="qs-left qs-term" colSpan={2} style={{ paddingTop: 10, color: 'rgba(255,255,255,0.7)' }}>Loss Participation {useTable && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>(stepped)</span>}</th></tr>
                            {useTable
                              ? corridors.map((c, i) => (
                                  <tr key={i}><th className="qs-left qs-term">Corridor {i + 1}</th><td>{c.minLr}% – {c.maxLr}% @ {c.share}%</td></tr>
                                ))
                              : <>
                                  <tr><th className="qs-left qs-term">Min LR Threshold</th><td>{terms.lp_min_loss_ratio_pct || 0}%</td></tr>
                                  <tr><th className="qs-left qs-term">Max LR Cap</th><td>{terms.lp_max_loss_ratio_pct || 0}%</td></tr>
                                  <tr><th className="qs-left qs-term">Reinsurer Share</th><td>{terms.lp_reinsurer_share_pct || 0}%</td></tr>
                                </>}
                          </>);
                        })()}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Quick Summary" headerPill="PROPORTIONAL TREATY: QUICK SUMMARY">
      {() => (
        <div className="QUICK_SUMMARY_PAGE">
          <div className="qs-hero glass">
            <div className="qs-hero-left">
              <div className="qs-hero-title">Quick Summary</div>
              <div className="qs-hero-sub">Underwriting year summary (projected vs actual) and portfolio stats.</div>
            </div>
            <div className="qs-hero-right">
              <button className="qs-view-btn" onClick={() => setModal('stats')}>Portfolio Stats</button>
              <button className="qs-view-btn" onClick={() => setModal('analysis')}>Portfolio Analysis</button>
              <button className="qs-view-btn" style={{ borderColor: 'rgba(0,232,184,0.4)', color: '#00e8b8' }} onClick={() => setShowPerfAnalysis(true)}>📈 Performance Analysis</button>
            </div>
          </div>
          {loading ? (
            <div className="df-card df-card--notice"><div className="df-note">Loading data and running projections...</div></div>
          ) : error ? (
            <div className="df-card df-card--notice"><div className="df-note" style={{ color: '#f87171' }}>Error: {error}</div></div>
          ) : calcRows.length === 0 ? (
            <div className="df-card df-card--notice"><div className="df-note">No triangle data available. Please enter data in the triangle screens first.</div></div>
          ) : (
            <>
              <div style={{
                margin: '0 0 14px',
                padding: '10px 16px',
                borderRadius: 10,
                background: 'rgba(0,232,184,0.05)',
                border: '1px solid rgba(0,232,184,0.22)',
                fontSize: 12,
                color: 'rgba(var(--text-rgb),.78)',
                lineHeight: 1.5,
                width: '100%',
              }}>
                <b style={{ color: 'var(--accent)', letterSpacing: '.04em' }}>POST-TREATY-TERMS.</b>{' '}
                Premium / claims totals are the same projected ultimates shown on the
                Projected Summary, then transformed by this treaty's <b>loss cap</b>,
                commission (fixed or sliding), brokerage, taxes, profit commission
                (with LCF carry-forward) and loss-participation credit. Loss ratios
                here use <b>capped</b> claims and will diverge from Projected Summary
                whenever the cap binds.
              </div>
              <div className="qs-page">
                <div className="qs-sections">
                  <ProjectedTable />
                  <ActualTable />
                </div>
              </div>
            </>
          )}
          <StatsModal />
          {showPerfAnalysis && (
            <PerformanceAnalysisModal
              calcRows={calcRows}
              onClose={() => setShowPerfAnalysis(false)}
            />
          )}
        </div>
      )}
    </WizardLayout>
  );
}
