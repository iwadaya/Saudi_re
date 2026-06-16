import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import { fmtNum, fmtPct, fmtMoney, fmtBal } from '../../utils/format';
import { REGION_COLS, LOB_COLS, BY_YEAR_COLS, ROL_BAND_COLS, BALANCE_BAND_COLS, TREATY_TYPE_COLS } from './dashboardColumns';

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
// the two never drift. (fmtBal renders a null balance as "—", not 0.00×.)
const KIND_FMT = {
  money: fmtMoney,
  pct: fmtPct,
  mult: fmtBal,
  int: (v) => fmtNum(v),
  text: (v) => (v == null ? '' : String(v)),
};
const withFmt = (cols) => cols.map((c) => ({ ...c, fmt: KIND_FMT[c.kind] }));

const regionCols = withFmt(REGION_COLS);
const lobCols = withFmt(LOB_COLS);
const byYearCols = withFmt(BY_YEAR_COLS);
const rolBandCols = withFmt(ROL_BAND_COLS);
const balanceBandCols = withFmt(BALANCE_BAND_COLS);
const treatyTypeCols = withFmt(TREATY_TYPE_COLS);

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
  return <th className="dash-th" style={{ cursor: 'pointer' }} onClick={() => onSort(tableKey, colKey)}>{label} <span className="dash-sort">{arrow}</span></th>;
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

export default function DashboardScreen() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('portfolio-overview');
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ uwYear: '', month: '', region: '', treatyType: '', yearsBack: '3', currency: 'USD' });
  const [filterOpts, setFilterOpts] = useState({ uwYears: [], months: [], regions: [], treatyTypes: [], currencies: ['USD','SAR','GBP'] });
  const [data, setData] = useState(null);
  const [sort, setSort] = useState({ byRegion: { key: 'premium', dir: 'desc' }, byLob: { key: 'premium', dir: 'desc' }, byYear: { key: 'uwYear', dir: 'asc' }, byBand: { key: 'premium', dir: 'desc' }, byBalanceBand: { key: 'premium', dir: 'desc' }, byTreaty: { key: 'premium', dir: 'desc' } });
  const [exporting, setExporting] = useState(false);

  const currency = filters.currency || 'USD';
  const fm = useCallback((v) => fmtMoney(v), []);
  const fp = useCallback((v) => fmtPct(v), []);

  const handleSort = useCallback((tableKey, colKey) => {
    setSort(prev => {
      const s = prev[tableKey] || { key: colKey, dir: 'asc' };
      return { ...prev, [tableKey]: { key: colKey, dir: s.key === colKey ? (s.dir === 'asc' ? 'desc' : 'asc') : 'asc' } };
    });
  }, []);

  // Client-side Excel export of the data the active tab already loaded. exceljs
  // + the exporter are dynamically imported on click to keep the bundle lean.
  const handleExport = useCallback(async () => {
    if (!data || loading) return;
    setExporting(true);
    try {
      const { exportDashboardTab } = await import('./dashboardExport');
      await exportDashboardTab({ tabId: tab, tabLabel: TABS.find(t => t.key === tab)?.label || tab, data, currency, filters });
    } catch (e) { console.warn('Dashboard export failed:', e); }
    finally { setExporting(false); }
  }, [data, loading, tab, currency, filters]);

  const loadFilters = useCallback(async () => {
    try {
      const res = await api.dashboardFilters();
      setFilterOpts({ uwYears: res.uwYears || [], months: res.months || [], regions: res.regions || [], treatyTypes: res.treatyTypes || [], currencies: res.currencies || ['ZAR'] });
      if (!filters.uwYear && res.defaultUwYear) setFilters(p => ({ ...p, uwYear: String(res.defaultUwYear) }));
    } catch (e) { console.warn('Dashboard filters:', e); }
  }, [filters.uwYear]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const qs = {};
      Object.entries(filters).forEach(([k, v]) => { if (v) qs[k] = v; });
      const d = await api.dashboardPage(tab, qs);
      setData(d);
    } catch (e) { console.warn('Dashboard data:', e); setData(null); }
    setLoading(false);
  }, [tab, filters]);

  useEffect(() => { loadFilters(); }, [loadFilters]);
  useEffect(() => { loadData(); }, [loadData]);

  const k = data?.kpis || {};
  const showRegion = tab === 'regional-analysis' || tab === 'regional-technical-analysis';
  const showTreaty = !(tab === 'return-analysis-proportional' || tab === 'return-analysis-nonproportional');
  const showYearsBack = tab === 'portfolio-summary';
  const showMonth = !(tab === 'return-analysis-proportional' || tab === 'return-analysis-nonproportional');

  return (
    <div className="dashboard-screen app-shell grid-bg">
      <Topbar title="Portfolio Dashboard" subtitle={`Analytics & reporting · All amounts in ${currency}`}
        actions={
          <>
            <button className="topbar-pill" onClick={handleExport} disabled={exporting || loading || !data} title="Export this tab to Excel">{exporting ? 'Exporting…' : '↓ Export to Excel'}</button>
            <button className="topbar-pill" onClick={() => navigate('/')}>← Home</button>
          </>
        } />
      <main className="workspace dashboard-workspace">
        <div className="container dashboard-container">
          <div className="crumb glass"><span className="dot" /><span className="crumb-text">DASHBOARD</span><span className="muted" style={{ marginLeft: 10 }}>/</span><span className="crumb-text" style={{ marginLeft: 10 }}>{TABS.find(t => t.key === tab)?.label}</span></div>

          {/* Tab bar */}
          <div className="dash-tabs glass">
            {TABS.map(t => <button key={t.key} className={`dash-tab ${t.key === tab ? 'dash-tab--active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>)}
          </div>

          {/* Filters */}
          <section className="panel glass" style={{ marginTop: 12 }}>
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
              {showTreaty && <div className="dash-filter"><div className="dash-filter-label">Treaty Type</div>
                <select className="dash-select" value={filters.treatyType} onChange={e => setFilters(p => ({ ...p, treatyType: e.target.value }))}>
                  <option value="">All</option>{filterOpts.treatyTypes.map(t => <option key={t} value={t}>{t}</option>)}</select></div>}
              <div className="dash-filter-actions">
                {/* Currency toggle */}
                <div style={{ display:'flex', gap:2, background:'rgba(255,255,255,0.05)', borderRadius:8, padding:3, marginRight:6 }}>
                  {['USD','SAR','GBP'].map(ccy => (
                    <button key={ccy} onClick={() => setFilters(p => ({ ...p, currency: ccy }))} style={{
                      padding:'4px 12px', borderRadius:6, border:'none', cursor:'pointer',
                      fontSize:11, fontWeight:700, letterSpacing:'.06em',
                      background: currency === ccy ? 'rgba(0,212,255,0.18)' : 'transparent',
                      color: currency === ccy ? '#00d4ff' : 'rgba(255,255,255,0.40)',
                      transition:'all .15s',
                    }}>{ccy}</button>
                  ))}
                </div>
                <button className="chip-btn" onClick={() => setFilters(p => ({ ...p, region: '', treatyType: '' }))}>Reset</button>
                <button className="primary-pill" onClick={loadData}>Apply</button>
              </div>
            </div>
          </section>

          {loading ? <div className="glass dash-block" style={{ marginTop: 12 }}><div className="muted">Loading…</div></div> : (
            <section style={{ marginTop: 12 }}>
              {/* KPI tiles */}
              <div className="dash-kpis">
                <Tile label="Contracts" value={fmtNum(k.contracts)} />
                <Tile label="Premium" value={fm(k.premium)} />
                <Tile label="Exposure" value={fm(k.exposure)} />
                <Tile label="Treaty Balance" value={fmtBal(k.balance)} />
                <Tile label="Avg ROL" value={fp(k.avgRol)} />
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
                <SummaryTable title="Summary by Line of Business" rows={data?.summaryByLob || []} columns={lobCols} sort={sort.byLob} sortKey="byLob" onSort={handleSort} currency={currency} />
                <PivotTable title="Premium (Region × Treaty Type)" data={data?.premiumRegionTreaty} cellFmt={fm} rowLabel="Region" />
                <PivotTable title="Exposure (Region × Treaty Type)" data={data?.exposureRegionTreaty} cellFmt={fm} rowLabel="Region" />
                <PivotTable title="UW Margin (Region × Treaty Type)" data={data?.uwMarginRegionTreaty} cellFmt={fp} rowLabel="Region" />
                <PivotTable title="Portfolio Composition (Region × Treaty Type)" data={data?.compositionRegionTreaty || data?.matrix} cellFmt={fp} rowLabel="Region" />
                <PivotTable title="Premium (LOB × Treaty Type)" data={data?.premiumLobTreaty} cellFmt={fm} rowLabel="Line of Business" />
                <PivotTable title="Exposure (LOB × Treaty Type)" data={data?.exposureLobTreaty} cellFmt={fm} rowLabel="Line of Business" />
                <PivotTable title="Portfolio Mix (LOB × Treaty Type)" data={data?.compositionLobTreaty} cellFmt={fp} rowLabel="Line of Business" />
                <PivotTable title="UW Margin (LOB × Treaty Type)" data={data?.uwMarginLobTreaty} cellFmt={fp} rowLabel="Line of Business" />
                <PivotTable title="Premium by LOB and Region" data={data?.premiumLobRegion} cellFmt={fm} rowLabel="Line of Business" />
                <PivotTable title="Underwriting Margins (LOB × Region)" data={data?.uwMarginLobRegion} cellFmt={fp} rowLabel="Line of Business" />
              </div>}

              {tab === 'portfolio-summary' && <div className="dash-stack">
                <PivotTable title="Consolidated Figures — Premium by Region" data={data?.regionYear} cellFmt={fm} rowLabel="Region" />
                <SummaryTable title="Summary by Year" rows={data?.byYear || []} columns={byYearCols} sort={sort.byYear} sortKey="byYear" onSort={handleSort} currency={currency} />
              </div>}

              {tab === 'regional-analysis' && (!filters.region
                ? <div className="glass dash-block"><div className="dash-block-title">Regional Analysis</div><div className="muted">Select a region to view this page.</div></div>
                : <div className="dash-stack">
                    <SummaryTable title="Summary by Year" rows={data?.byYear || []} columns={byYearCols} sort={sort.byYear} sortKey="byYear" onSort={handleSort} currency={currency} />
                    <SummaryTable title="Summary by Line of Business" rows={data?.byLob || []} columns={lobCols} sort={sort.byLob} sortKey="byLob" onSort={handleSort} currency={currency} />
                    <PivotTable title="Premium (LOB × Treaty Type)" data={data?.lobTreatyPremium} cellFmt={fm} rowLabel="Line of Business" />
                    <PivotTable title="Exposure (LOB × Treaty Type)" data={data?.lobTreatyExposure} cellFmt={fm} rowLabel="Line of Business" />
                    <PivotTable title="Composition (LOB × Treaty Type)" data={data?.lobTreatyComposition} cellFmt={fp} rowLabel="Line of Business" />
                    <PivotTable title="UW Margin (LOB × Treaty Type)" data={data?.lobTreatyUwMargin} cellFmt={fp} rowLabel="Line of Business" />
                  </div>)}

              {(tab === 'portfolio-technical-analysis' || tab === 'regional-technical-analysis') && (
                tab === 'regional-technical-analysis' && !filters.region
                  ? <div className="glass dash-block"><div className="dash-block-title">Regional Technical Analysis</div><div className="muted">Select a region to view this page.</div></div>
                  : <div className="dash-stack">
                      <SummaryTable title="NP Premiums by ROL Band" rows={data?.rolBands || []} columns={rolBandCols} sort={sort.byBand} sortKey="byBand" onSort={handleSort} currency={currency} />
                      <SummaryTable title="Proportional Premiums by Balance Band" rows={data?.balanceBands || []} columns={balanceBandCols} sort={sort.byBalanceBand} sortKey="byBalanceBand" onSort={handleSort} currency={currency} />
                      <SummaryTable title="Treaty Type Breakdown" rows={data?.byTreatyType || []} columns={treatyTypeCols} sort={sort.byTreaty} sortKey="byTreaty" onSort={handleSort} currency={currency} />
                      <PivotTable title="Treaty Premium (by UW Year)" data={data?.treatyPremiumByYear} cellFmt={fm} rowLabel="Treaty Type" />
                      <PivotTable title="Treaty Balance (by UW Year)" data={data?.treatyBalanceByYear} cellFmt={fmtBal} rowLabel="Treaty Type" />
                      <PivotTable title="Treaty ROL (by UW Year)" data={data?.treatyRolByYear} cellFmt={fp} rowLabel="Treaty Type" />
                      <PivotTable title="Treaty UW Margin (by UW Year)" data={data?.treatyUwMarginByYear} cellFmt={fp} rowLabel="Treaty Type" />
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

              {/* Fallback: raw table for any data with rows */}
              {!['portfolio-overview','portfolio-summary','regional-analysis','portfolio-technical-analysis','regional-technical-analysis','return-analysis-proportional','return-analysis-nonproportional'].includes(tab) && data?.rows && (
                <div className="panel glass" style={{ marginTop: 16 }}>
                  <div className="panel-head"><div className="panel-title">{TABS.find(t => t.key === tab)?.label}</div></div>
                  <div className="panel-body" style={{ overflowX: 'auto' }}>
                    <table className="data-table"><thead><tr>{Object.keys(data.rows[0] || {}).map(k => <th key={k}>{k.replace(/_/g, ' ')}</th>)}</tr></thead>
                      <tbody>{data.rows.map((row, i) => <tr key={i}>{Object.values(row).map((v, j) => <td key={j}>{typeof v === 'number' ? fmtNum(v, { decimals: 2 }) : String(v ?? '')}</td>)}</tr>)}</tbody></table>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
