// client/src/screens/facdashboard/FacDashboardScreen.jsx
// Facultative portfolio dashboard — the fac twin of dashboard/DashboardScreen.
// Same tabs, filters, pivot shapes and styling (styles/dashboard/dashboard.css),
// fed by /api/fac-dashboard/*. Treaty concepts are translated to fac ones:
// Treaty Type → FAC Type (Proportional FAC | XL FAC), LOB → fac class of
// business, and the proportional headline is Rate ‰ (premium ÷ sum insured ×
// 1000, the unit fac prices in) where treaty shows Balance ×; ROL stays the
// XL headline. UW Margin is the share of premium above the technical price.
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import AsyncBoundary from '../../components/AsyncBoundary';
import { useResource } from '../../hooks/useResource';
import { fmtNum, fmtPct, fmtMoney, fmtBal, fmtPerMille } from '../../utils/format';
import { FAC_REGION_COLS, FAC_LOB_COLS, FAC_BY_YEAR_COLS, FAC_TYPE_COLS, FAC_KPI_ROWS, FAC_DASHBOARD_EXPORT_MANIFEST } from './facDashboardColumns';
import { fitLabelColumn } from '../dashboard/labelWidth';
import { logger } from '../../utils/logger';
import ComboChart from '../dashboard/comboChart';

const TABS = [
  { key: 'portfolio-overview', label: 'Portfolio Overview' },
  { key: 'portfolio-summary', label: 'Portfolio Summary' },
  { key: 'regional-analysis', label: 'Regional Analysis' },
  { key: 'portfolio-technical-analysis', label: 'Portfolio Technical Analysis' },
  { key: 'regional-technical-analysis', label: 'Regional Technical Analysis' },
  { key: 'return-analysis-proportional', label: 'Return Analysis (Proportional)' },
  { key: 'return-analysis-nonproportional', label: 'Return Analysis (Non-proportional)' },
];

// Map a shared column { kind } → on-screen display formatter. The Excel export
// reads the same { key, label, kind } defs and maps kind → numFmt instead, so
// the two never drift. (fmtPerMille/fmtBal render a null as "—", not 0.)
const KIND_FMT = {
  money: fmtMoney,
  pct: fmtPct,
  mult: fmtBal,
  permille: fmtPerMille,
  int: (v) => fmtNum(v),
  text: (v) => (v == null ? '' : String(v)),
};
const withFmt = (cols) => cols.map((c) => ({ ...c, fmt: KIND_FMT[c.kind] }));

const regionCols = withFmt(FAC_REGION_COLS);
const lobCols = withFmt(FAC_LOB_COLS);
const byYearCols = withFmt(FAC_BY_YEAR_COLS);
const facTypeCols = withFmt(FAC_TYPE_COLS);

// Every value that can land in a table's first (row-label) column — across the
// loaded tab data plus the region/FAC-type filter universes — so the fixed
// label column is sized to the real longest class / region / FAC type.
function gatherLabels(data, filterOpts) {
  const out = new Set();
  for (const r of filterOpts?.regions || []) if (r != null && r !== '') out.add(String(r));
  for (const t of filterOpts?.facTypes || []) if (t != null && t !== '') out.add(String(t));
  const labelOf = (row) => row?.region ?? row?.lob ?? row?.country ?? row?.facType ?? row?.band ?? row?.uwYear ?? row?.key;
  const eat = (val) => {
    if (Array.isArray(val)) {
      for (const row of val) { const v = labelOf(row); if (v != null && v !== '') out.add(String(v)); }
    } else if (val && typeof val === 'object') {
      if (Array.isArray(val.rows)) {                 // pivot: { columns, rows, totals }
        for (const row of val.rows) { const v = labelOf(row); if (v != null && v !== '') out.add(String(v)); }
      } else {
        for (const inner of Object.values(val)) if (Array.isArray(inner)) eat(inner); // e.g. series.*
      }
    }
  };
  if (data) for (const val of Object.values(data)) eat(val);
  return [...out];
}

function sortRows(rows, key, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const av = a?.[key], bv = b?.[key];
    const an = Number(av), bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return sign * (an - bn);
    return sign * String(av ?? '').localeCompare(String(bv ?? ''));
  });
}

function sparklinePath(points, w = 220, h = 54, pad = 6) {
  const arr = (points || []).map(Number).filter(Number.isFinite);
  if (arr.length < 2) return '';
  const mn = Math.min(...arr), mx = Math.max(...arr);
  const dx = (w - pad * 2) / (arr.length - 1);
  const sy = v => { if (mx === mn) return h / 2; return pad + (1 - (v - mn) / (mx - mn)) * (h - pad * 2); };
  return arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * dx).toFixed(2)},${sy(v).toFixed(2)}`).join(' ');
}

/* Tile KPI */
function Tile({ label, value, sub }) {
  return (<div className="dash-tile glass"><div className="dash-tile-label">{label}</div><div className="dash-tile-value">{value}</div>{sub && <div className="dash-tile-sub">{sub}</div>}</div>);
}

/* Sortable Table Header */
function SortTh({ tableKey, colKey, label, sort, onSort }) {
  const active = sort?.key === colKey;
  const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '';
  return <th className="dash-th dash-th--sort" onClick={() => onSort(tableKey, colKey)}>{label} <span className="dash-sort">{arrow}</span></th>;
}

/* Pivot / Matrix Table */
function PivotTable({ title, data, cellFmt, rowLabel = 'Row' }) {
  if (!data?.columns?.length) return (<div className="glass dash-block"><div className="dash-block-title">{title}</div><div className="muted">No data.</div></div>);
  const { columns: cols, rows = [], totals = { values: {}, total: 0 } } = data;
  return (
    <div className="glass dash-block">
      <div className="dash-block-title">{title}</div>
      <div className="dash-table-wrap">
        <table className="table dash-table">
          <thead><tr><th className="dash-th">{rowLabel}</th>{cols.map(c => <th key={c} className="dash-th">{c}</th>)}<th className="dash-th">Total</th></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const key = r.region ?? r.lob ?? r.key ?? String(i);
              return (<tr key={key}><td className="dash-td">{key}</td>
                {cols.map(c => <td key={c} className="dash-td">{cellFmt(r.values?.[c] ?? 0)}</td>)}
                <td className="dash-td"><b>{cellFmt(r.total ?? 0)}</b></td></tr>);
            })}
            <tr><td className="dash-td"><b>Total</b></td>
              {cols.map(c => <td key={c} className="dash-td"><b>{cellFmt(totals.values?.[c] ?? 0)}</b></td>)}
              <td className="dash-td"><b>{cellFmt(totals.total ?? 0)}</b></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* Summary table with sortable headers */
function SummaryTable({ title, rows, columns, sort, sortKey, onSort, currency }) {
  const sorted = sortRows(rows, sort?.key || columns[0]?.key, sort?.dir || 'asc');
  return (
    <div className="glass dash-block">
      <div className="dash-block-title">{title}</div>
      <div className="dash-table-wrap">
        <table className="table dash-table">
          <thead><tr>{columns.map(c => <SortTh key={c.key} tableKey={sortKey} colKey={c.key} label={c.label} sort={sort} onSort={onSort} />)}</tr></thead>
          <tbody>{sorted.map((r, i) => (
            <tr key={i}>{columns.map(c => <td key={c.key} className="dash-td">{c.fmt ? c.fmt(r[c.key], currency) : String(r[c.key] ?? '')}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Technical-analysis: Strata-style diagonal-split matrix ────────────────
   Rows = FAC type, Columns = UW year. Each cell is split on the diagonal:
   top-left = the headline rate (Rate ‰, for proportional fac; ROL %, for XL
   fac), bottom-right = UW Margin (green ≥ 0, red < 0). A coloured left stripe
   marks the row's class. Reads the facType×year pivots the page query already
   returns — no new data shape. */

// Pivot → { rowKey: { values:{col:v}, total } } for O(1) cell lookup.
function indexPivot(pivot) {
  const out = { rows: {}, totals: pivot?.totals || { values: {}, total: null } };
  for (const r of pivot?.rows || []) out.rows[r.key ?? r.region ?? r.lob] = r;
  return out;
}

function TechCell({ kind, top, topUnit, margin }) {
  const topTxt = top == null ? '—' : (topUnit === 'RATE' ? fmtPerMille(top) : fmtPct(top));
  const mTxt = margin == null ? '—' : fmtPct(margin);
  const mClass = margin == null ? 'muted' : margin >= 0 ? 'dash-pos' : 'dash-neg';
  const cls = ['dash-tcell', kind === 'NP' ? 'dash-tcell--np' : kind === 'PROP' ? 'dash-tcell--prop' : 'dash-tcell--neutral']
    .concat(top == null && margin == null ? 'dash-tcell--empty' : []).join(' ');
  return (
    <td className={cls}>
      <span className="dash-tcell-tl">{topTxt}{top != null && topUnit && <span className="dash-tcell-kx"> {topUnit}</span>}</span>
      <span className={`dash-tcell-br ${mClass}`}>{mTxt}</span>
    </td>
  );
}

function TechMatrix({ data }) {
  const rateByT = indexPivot(data?.facTypeRateByYear);
  const rolByT = indexPivot(data?.facTypeRolByYear);
  const marginByT = indexPivot(data?.facTypeUwMarginByYear);
  const kindMap = data?.facKindByType || {};
  const byFacType = data?.byFacType || [];

  // Union of years across the rate pivots, numerically sorted.
  const cols = [...new Set([
    ...(data?.facTypeRateByYear?.columns || []),
    ...(data?.facTypeRolByYear?.columns || []),
    ...(data?.facTypeUwMarginByYear?.columns || []),
  ])].sort((a, b) => Number(a) - Number(b));

  // FAC types in the breakdown's premium order (falls back to pivot rows).
  const types = byFacType.length
    ? byFacType.map(t => t.facType)
    : Object.keys({ ...rateByT.rows, ...rolByT.rows });
  if (!cols.length || !types.length) {
    return <div className="glass dash-block"><div className="dash-block-title">Technical Matrix</div><div className="muted">No data.</div></div>;
  }

  const rate = (t, c) => {
    const np = kindMap[t] === 'NP';
    const src = np ? rolByT : rateByT;
    return { val: src.rows[t]?.values?.[c] ?? null, unit: np ? 'ROL' : 'RATE' };
  };
  const breakdown = Object.fromEntries(byFacType.map(t => [t.facType, t]));

  return (
    <div className="glass dash-block">
      <div className="dash-block-title">Technical Matrix — FAC Type × UW Year <span className="dash-tag">RATE · ROL · UW MARGIN</span></div>
      <div className="dash-table-wrap">
        <table className="table dash-table dash-tech">
          <thead><tr><th className="dash-th">FAC Type</th>{cols.map(c => <th key={c} className="dash-th">{c}</th>)}<th className="dash-th">Total</th></tr></thead>
          <tbody>
            {types.map(t => {
              const np = kindMap[t] === 'NP';
              const bd = breakdown[t];
              return (
                <tr key={t}>
                  <td className="dash-td dash-td--left">{t}</td>
                  {cols.map(c => { const r = rate(t, c); return <TechCell key={c} kind={kindMap[t]} top={r.val} topUnit={r.unit} margin={marginByT.rows[t]?.values?.[c] ?? null} />; })}
                  <TechCell kind={kindMap[t]} top={np ? bd?.rol ?? null : bd?.rate ?? null} topUnit={np ? 'ROL' : 'RATE'} margin={bd?.uwMargin ?? marginByT.rows[t]?.total ?? null} />
                </tr>
              );
            })}
            <tr className="dash-tr-total">
              <td className="dash-td dash-td--left"><b>Total</b></td>
              {cols.map(c => <TechCell key={c} kind="neutral" top={null} margin={marginByT.totals.values?.[c] ?? null} />)}
              <TechCell kind="neutral" top={null} margin={marginByT.totals.total ?? null} />
            </tr>
          </tbody>
        </table>
      </div>
      <TechLegend />
    </div>
  );
}

function TechLegend() {
  return (
    <div className="dash-tech-legend">
      <div className="dash-lz"><span className="dash-sq"><i className="a">1.2‰</i><i className="b">12%</i></span><span>Each cell split on the diagonal</span></div>
      <div className="dash-lz"><span className="dash-pill dash-pill--prop" /><b>Proportional FAC</b> — top-left = Rate (Premium ÷ Sum Insured, ‰)</div>
      <div className="dash-lz"><span className="dash-pill dash-pill--np" /><b>XL FAC</b> — top-left = ROL (Premium ÷ Limit, %)</div>
      <div className="dash-lz">Bottom-right (both) = <b>UW Margin</b> vs technical price (green ≥ 0, red &lt; 0)</div>
    </div>
  );
}

/* Strata-style band section: a table (Band | Risks | Premium-with-inline-bar
   | % Prem | UW Margin) with a Table/Chart toggle. Reads rolBands / rateBands
   verbatim. `rateKey`/`rateUnit` show the band's avg rate alongside. */
function BandSection({ title, rows, rateKey, rateUnit, view, onView, currency }) {
  const data = rows || [];
  const totalPrem = data.reduce((s, r) => s + (Number(r.premium) || 0), 0);
  const maxPrem = Math.max(0, ...data.map(r => Number(r.premium) || 0));
  const totMargin = (() => {
    let num = 0, den = 0;
    for (const r of data) { if (r.uwMargin != null) { num += r.uwMargin * (Number(r.premium) || 0); den += Number(r.premium) || 0; } }
    return den ? num / den : null;
  })();
  const totRisks = data.reduce((s, r) => s + (Number(r.risks) || 0), 0);
  const rateFmt = rateUnit === 'RATE' ? fmtPerMille : fmtPct;
  const chartData = data.map(r => ({ label: r.band, premium: Number(r.premium) || 0, margin: r.uwMargin ?? null }));

  return (
    <div className="glass dash-block">
      <div className="dash-block-title dash-block-title--split">
        <span>{title}</span>
        <span className="dash-seg">
          {['table', 'chart'].map(v => (
            <button key={v} className={`dash-seg-btn ${view === v ? 'dash-seg-btn--on' : ''}`} onClick={() => onView(v)}>{v === 'table' ? 'Table' : 'Chart'}</button>
          ))}
        </span>
      </div>
      {view === 'chart' ? (
        <>
          <ComboChart data={chartData} premiumFmt={(v) => fmtMoney(v)} />
          <div className="dash-chart-legend">
            <span className="dash-li"><span className="dash-sw dash-sw--premium" />Premium (left axis, bars)</span>
            <span className="dash-li"><span className="dash-sw dash-sw--margin" />UW Margin (right axis %, dots green/red by sign)</span>
          </div>
        </>
      ) : (
        <div className="dash-table-wrap">
          <table className="table dash-table">
            <thead><tr>
              <th className="dash-th">Band</th><th className="dash-th">Risks</th>
              <th className="dash-th">Avg {rateUnit === 'RATE' ? 'Rate ‰' : 'ROL'}</th>
              <th className="dash-th">Premium</th><th className="dash-th">% Prem</th><th className="dash-th">UW Margin</th>
            </tr></thead>
            <tbody>
              {data.map((r, i) => {
                const w = maxPrem > 0 ? Math.min(100, ((Number(r.premium) || 0) / maxPrem) * 100) : 0;
                const mClass = r.uwMargin == null ? 'muted' : r.uwMargin >= 0 ? 'dash-pos' : 'dash-neg';
                return (
                  <tr key={i}>
                    <td className="dash-td dash-td--left">{r.band}</td>
                    <td className="dash-td">{fmtNum(r.risks)}</td>
                    <td className="dash-td">{rateFmt(r[rateKey])}</td>
                    <td className="dash-td"><span className="dash-barcell"><span className="dash-bar" style={{ width: `${w}%` }} /><span className="dash-bar-v">{fmtMoney(r.premium, currency)}</span></span></td>
                    <td className="dash-td">{totalPrem > 0 ? fmtPct((Number(r.premium) || 0) / totalPrem) : '—'}</td>
                    <td className={`dash-td ${mClass}`}>{r.uwMargin == null ? '—' : fmtPct(r.uwMargin)}</td>
                  </tr>
                );
              })}
              <tr className="dash-tr-total">
                <td className="dash-td dash-td--left"><b>Total</b></td>
                <td className="dash-td"><b>{fmtNum(totRisks)}</b></td>
                <td className="dash-td">—</td>
                <td className="dash-td"><b>{fmtMoney(totalPrem, currency)}</b></td>
                <td className="dash-td"><b>100%</b></td>
                <td className={`dash-td ${totMargin == null ? 'muted' : totMargin >= 0 ? 'dash-pos' : 'dash-neg'}`}><b>{totMargin == null ? '—' : fmtPct(totMargin)}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function FacDashboardScreen() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('portfolio-overview');
  const [filters, setFilters] = useState({ uwYear: '', month: '', region: '', facType: '', yearsBack: '3', currency: 'USD' });
  const [filterOpts, setFilterOpts] = useState({ uwYears: [], months: [], regions: [], facTypes: [], currencies: ['USD','SAR','GBP'] });
  const [sort, setSort] = useState({ byRegion: { key: 'premium', dir: 'desc' }, byLob: { key: 'premium', dir: 'desc' }, byYear: { key: 'uwYear', dir: 'asc' }, byBand: { key: 'premium', dir: 'desc' }, byRateBand: { key: 'premium', dir: 'desc' }, byFacType: { key: 'premium', dir: 'desc' } });
  const [exporting, setExporting] = useState(false);
  const [bandView, setBandView] = useState({ rol: 'table', rate: 'table' });

  const currency = filters.currency || 'USD';
  const fm = useCallback((v) => fmtMoney(v), []);
  const fp = useCallback((v) => fmtPct(v), []);

  // The page payload for the active tab + filters. useResource gives uniform
  // loading/error state, aborts superseded requests when tab/filters change,
  // and reports failures through the shared errorReporter path.
  const page = useResource(
    () => {
      const qs = {};
      Object.entries(filters).forEach(([k, v]) => { if (v) qs[k] = v; });
      return api.facDashboardPage(tab, qs);
    },
    [tab, filters],
    { reportLabel: 'fac-dashboard' },
  );
  const data = page.data;
  const loading = page.loading;

  const handleSort = useCallback((tableKey, colKey) => {
    setSort(prev => {
      const s = prev[tableKey] || { key: colKey, dir: 'asc' };
      return { ...prev, [tableKey]: { key: colKey, dir: s.key === colKey ? (s.dir === 'asc' ? 'desc' : 'asc') : 'asc' } };
    });
  }, []);

  // Client-side Excel export of the data the active tab already loaded. The
  // shared exporter (+ exceljs) is dynamically imported on click to keep the
  // bundle lean; the fac manifest/labels ride in as parameters.
  const handleExport = useCallback(async () => {
    if (!data || loading) return;
    setExporting(true);
    try {
      const { exportDashboardTab } = await import('../dashboard/dashboardExport');
      await exportDashboardTab({
        tabId: tab, tabLabel: TABS.find(t => t.key === tab)?.label || tab, data, currency, filters,
        manifests: FAC_DASHBOARD_EXPORT_MANIFEST, label: 'FAC Dashboard', kpiRows: FAC_KPI_ROWS,
        notes: 'Raw numeric values; rate ‰ = premium ÷ sum insured × 1000; blank cells are N/A.',
      });
    } catch (e) { logger.warn('FAC dashboard export failed:', e); }
    finally { setExporting(false); }
  }, [data, loading, tab, currency, filters]);

  const loadFilters = useCallback(async () => {
    try {
      const res = await api.facDashboardFilters();
      setFilterOpts({ uwYears: res.uwYears || [], months: res.months || [], regions: res.regions || [], facTypes: res.facTypes || [], currencies: res.currencies || ['USD'] });
      if (!filters.uwYear && res.defaultUwYear) setFilters(p => ({ ...p, uwYear: String(res.defaultUwYear) }));
    } catch (e) { logger.warn('FAC dashboard filters:', e); }
  }, [filters.uwYear]);

  useEffect(() => { loadFilters(); }, [loadFilters]);

  // Size the row-label (first) column to the longest label once the tab's tables
  // have rendered. The font is read from a real first-column cell so it matches;
  // labelWidth.js keeps a high-water mark so the width is fixed across tabs.
  useEffect(() => {
    const fontEl = document.querySelector('.dash-table td:first-child') || document.querySelector('.dash-table');
    fitLabelColumn(gatherLabels(data, filterOpts), fontEl);
  }, [data, filterOpts]);

  const k = data?.kpis || {};
  const showRegion = tab === 'regional-analysis' || tab === 'regional-technical-analysis';
  const showFacType = !(tab === 'return-analysis-proportional' || tab === 'return-analysis-nonproportional');
  const showYearsBack = tab === 'portfolio-summary';
  const showMonth = !(tab === 'return-analysis-proportional' || tab === 'return-analysis-nonproportional');

  return (
    <div className="dashboard-screen app-shell grid-bg">
      <Topbar title="FAC Portfolio Dashboard" subtitle={`Facultative analytics & reporting · All amounts in ${currency}`}
        actions={
          <>
            <button className="topbar-pill" onClick={handleExport} disabled={exporting || loading || !data} title="Export this tab to Excel">{exporting ? 'Exporting…' : '↓ Export to Excel'}</button>
            <button className="topbar-pill" onClick={() => navigate('/fac')}>← FAC Home</button>
          </>
        } />
      <main className="workspace dashboard-workspace">
        <div className="container dashboard-container">
          <div className="crumb glass"><span className="dot" /><span className="crumb-text">FAC DASHBOARD</span><span className="muted dash-crumb-sep">/</span><span className="crumb-text dash-crumb-sep">{TABS.find(t => t.key === tab)?.label}</span></div>

          {/* Tab bar */}
          <div className="dash-tabs glass">
            {TABS.map(t => <button key={t.key} className={`dash-tab ${t.key === tab ? 'dash-tab--active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>)}
          </div>

          {/* Filters */}
          <section className="panel glass dash-mt12">
            <div className="dash-filterbar">
              <div className="dash-filter"><div className="dash-filter-label">UW Year</div>
                <select className="dash-select" value={filters.uwYear} onChange={e => setFilters(p => ({ ...p, uwYear: e.target.value }))}>
                  <option value="">All</option>{filterOpts.uwYears.map(y => <option key={y} value={y}>{y}</option>)}</select></div>
              {showMonth && <div className="dash-filter"><div className="dash-filter-label">Month</div>
                <select className="dash-select" value={filters.month} onChange={e => setFilters(p => ({ ...p, month: e.target.value }))}>
                  <option value="">All</option>{filterOpts.months.map(m => <option key={m} value={m}>{m}</option>)}</select></div>}
              {showYearsBack && <div className="dash-filter"><div className="dash-filter-label">Years</div>
                <select className="dash-select" value={filters.yearsBack} onChange={e => setFilters(p => ({ ...p, yearsBack: e.target.value }))}>
                  {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={n}>{n}</option>)}</select></div>}
              {showRegion && <div className="dash-filter"><div className="dash-filter-label">Region</div>
                <select className="dash-select" value={filters.region} onChange={e => setFilters(p => ({ ...p, region: e.target.value }))}>
                  <option value="">Choose</option>{filterOpts.regions.map(r => <option key={r} value={r}>{r}</option>)}</select></div>}
              {showFacType && <div className="dash-filter"><div className="dash-filter-label">FAC Type</div>
                <select className="dash-select" value={filters.facType} onChange={e => setFilters(p => ({ ...p, facType: e.target.value }))}>
                  <option value="">All</option>{filterOpts.facTypes.map(t => <option key={t} value={t}>{t}</option>)}</select></div>}
              <div className="dash-filter-actions">
                {/* Currency toggle */}
                <div className="dash-ccy">
                  {['USD','SAR','GBP'].map(ccy => (
                    <button key={ccy} className={`dash-ccy-btn ${currency === ccy ? 'dash-ccy-btn--on' : ''}`} onClick={() => setFilters(p => ({ ...p, currency: ccy }))}>{ccy}</button>
                  ))}
                </div>
                <button className="chip-btn" onClick={() => setFilters(p => ({ ...p, region: '', facType: '' }))}>Reset</button>
                <button className="primary-pill" onClick={page.refetch}>Apply</button>
              </div>
            </div>
          </section>

          <AsyncBoundary loading={loading} error={page.error} onRetry={page.refetch} label="fac-dashboard">
            <section className="dash-mt12">
              {/* KPI tiles */}
              <div className="dash-kpis">
                <Tile label="Risks" value={fmtNum(k.risks)} />
                <Tile label="Premium" value={fm(k.premium)} />
                <Tile label="Exposure" value={fm(k.exposure)} />
                <Tile label="Avg Rate (Prop)" value={fmtPerMille(k.rate)} />
                <Tile label="Avg ROL (XL)" value={fp(k.avgRol)} />
                <Tile label="Avg UW Margin" value={fp(k.avgUwMargin)} />
              </div>

              {/* Tab-specific content */}
              {tab === 'portfolio-overview' && <div className="dash-stack">
                {/* Sparkline */}
                {data?.series?.premiumByMonth?.length > 1 && <div className="glass dash-block">
                  <div className="dash-block-title">Premium Trend</div>
                  <div className="dash-spark">
                    <svg width="240" height="64" viewBox="0 0 240 64" preserveAspectRatio="xMidYMid meet" className="dash-spark-svg">
                      <path d={sparklinePath(data.series.premiumByMonth.map(p => p.value))} fill="none" stroke="rgba(0,255,153,0.95)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                    </svg>
                    <div className="dash-spark-meta"><div className="muted">Year {filters.uwYear || ''}</div><div className="dash-spark-big">{fm(k.premium)}</div></div>
                  </div>
                </div>}
                <SummaryTable title="Summary by Region" rows={data?.summaryByRegion || []} columns={regionCols} sort={sort.byRegion} sortKey="byRegion" onSort={handleSort} currency={currency} />
                <SummaryTable title="Summary by Class of Business" rows={data?.summaryByLob || []} columns={lobCols} sort={sort.byLob} sortKey="byLob" onSort={handleSort} currency={currency} />
                <PivotTable title="Premium (Region × FAC Type)" data={data?.premiumRegionFacType} cellFmt={fm} rowLabel="Region" />
                <PivotTable title="Exposure (Region × FAC Type)" data={data?.exposureRegionFacType} cellFmt={fm} rowLabel="Region" />
                <PivotTable title="UW Margin (Region × FAC Type)" data={data?.uwMarginRegionFacType} cellFmt={fp} rowLabel="Region" />
                <PivotTable title="Portfolio Composition (Region × FAC Type)" data={data?.compositionRegionFacType} cellFmt={fp} rowLabel="Region" />
                <PivotTable title="Premium (Class × FAC Type)" data={data?.premiumLobFacType} cellFmt={fm} rowLabel="Class of Business" />
                <PivotTable title="Exposure (Class × FAC Type)" data={data?.exposureLobFacType} cellFmt={fm} rowLabel="Class of Business" />
                <PivotTable title="Portfolio Mix (Class × FAC Type)" data={data?.compositionLobFacType} cellFmt={fp} rowLabel="Class of Business" />
                <PivotTable title="UW Margin (Class × FAC Type)" data={data?.uwMarginLobFacType} cellFmt={fp} rowLabel="Class of Business" />
                <PivotTable title="Premium by Class and Region" data={data?.premiumLobRegion} cellFmt={fm} rowLabel="Class of Business" />
                <PivotTable title="Underwriting Margins (Class × Region)" data={data?.uwMarginLobRegion} cellFmt={fp} rowLabel="Class of Business" />
              </div>}

              {tab === 'portfolio-summary' && <div className="dash-stack">
                <PivotTable title="Consolidated Figures — Premium by Region" data={data?.regionYear} cellFmt={fm} rowLabel="Region" />
                <SummaryTable title="Summary by Year" rows={data?.byYear || []} columns={byYearCols} sort={sort.byYear} sortKey="byYear" onSort={handleSort} currency={currency} />
              </div>}

              {tab === 'regional-analysis' && (!filters.region
                ? <div className="glass dash-block"><div className="dash-block-title">Regional Analysis</div><div className="muted">Select a region to view this page.</div></div>
                : <div className="dash-stack">
                    <SummaryTable title="Summary by Year" rows={data?.byYear || []} columns={byYearCols} sort={sort.byYear} sortKey="byYear" onSort={handleSort} currency={currency} />
                    <SummaryTable title="Summary by Class of Business" rows={data?.byLob || []} columns={lobCols} sort={sort.byLob} sortKey="byLob" onSort={handleSort} currency={currency} />
                    <PivotTable title="Premium (Class × FAC Type)" data={data?.lobFacTypePremium} cellFmt={fm} rowLabel="Class of Business" />
                    <PivotTable title="Exposure (Class × FAC Type)" data={data?.lobFacTypeExposure} cellFmt={fm} rowLabel="Class of Business" />
                    <PivotTable title="Composition (Class × FAC Type)" data={data?.lobFacTypeComposition} cellFmt={fp} rowLabel="Class of Business" />
                    <PivotTable title="UW Margin (Class × FAC Type)" data={data?.lobFacTypeUwMargin} cellFmt={fp} rowLabel="Class of Business" />
                  </div>)}

              {(tab === 'portfolio-technical-analysis' || tab === 'regional-technical-analysis') && (
                tab === 'regional-technical-analysis' && !filters.region
                  ? <div className="glass dash-block"><div className="dash-block-title">Regional Technical Analysis</div><div className="muted">Select a region to view this page.</div></div>
                  : <div className="dash-stack">
                      <TechMatrix data={data} />
                      <SummaryTable title="FAC Type Breakdown" rows={data?.byFacType || []} columns={facTypeCols} sort={sort.byFacType} sortKey="byFacType" onSort={handleSort} currency={currency} />
                      <BandSection title="XL FAC — ROL Bands" rows={data?.rolBands || []} rateKey="rol" rateUnit="ROL" view={bandView.rol} onView={(v) => setBandView(p => ({ ...p, rol: v }))} currency={currency} />
                      <BandSection title="Proportional FAC — Rate Bands" rows={data?.rateBands || []} rateKey="rate" rateUnit="RATE" view={bandView.rate} onView={(v) => setBandView(p => ({ ...p, rate: v }))} currency={currency} />
                      <PivotTable title="FAC Premium (by UW Year)" data={data?.facTypePremiumByYear} cellFmt={fm} rowLabel="FAC Type" />
                    </div>)}

              {tab === 'return-analysis-proportional' && <div className="dash-stack">
                <PivotTable title="Return per Unit Risk" data={data?.propReturnPerUnitRisk} cellFmt={fp} rowLabel="Region" />
                <PivotTable title="Portfolio Premium" data={data?.propPortfolioPremium} cellFmt={fm} rowLabel="Region" />
                <PivotTable title="Portfolio %" data={data?.propPortfolioPct} cellFmt={fp} rowLabel="Region" />
              </div>}

              {tab === 'return-analysis-nonproportional' && <div className="dash-stack">
                <PivotTable title="Return per Unit Risk" data={data?.npReturnPerUnitRisk} cellFmt={fp} rowLabel="Region" />
                <PivotTable title="Portfolio Premium" data={data?.npPortfolioPremium} cellFmt={fm} rowLabel="Region" />
                <PivotTable title="Portfolio %" data={data?.npPortfolioPct} cellFmt={fp} rowLabel="Region" />
              </div>}
            </section>
          </AsyncBoundary>
        </div>
      </main>
    </div>
  );
}
