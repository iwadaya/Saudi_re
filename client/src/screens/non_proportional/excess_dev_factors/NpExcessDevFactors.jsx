import { useState, useEffect, useCallback, useId, useMemo, useRef } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import { logger } from '../../../utils/logger';
import {
  buildMatrixFromCells,
  calculateAgeToAgeFactors,
  calculatePattern,
  calculateCdfs,
  fitExponentialCdfs,
  deriveLdfsFromCdfs,
} from '../../../logic/chainLadder';
import { calculateBF } from '../../../logic/bornhuetterFerguson';
import '../../../styles/proportional/dev_factors.css';
import { FactorTable, BFProjectionsTable, LinkRatioView, UltimateSummaryTable } from './NpExcessDevFactorsTables';

const ROUTE_KEY = 'NP_EXCESS_DEV_FACTORS';

// ── Helpers ──────────────────────────────────────────────

function sameNumberArray(a = [], b = []) {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

function serializeChosenSource(source) {
  return source === 'LINK_RATIO' ? 'SELECTED' : source;
}

function toInt(v) {
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function yearFromDate(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Factor Table (read-only or editable) ─────────────────
export default function NpExcessDevFactors() {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const quoteMode = !!appState.quoteMode;
  const apiOpts = useMemo(() => (quoteMode ? { quote: true } : undefined), [quoteMode]);
  const pfx = quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';

  // ── Derive year range from NP detail (same as NpPremiumsTable) ──
  const npDetail = useMemo(() => appState.npTreatyDetail || {}, [appState.npTreatyDetail]);
  const { startYear, numDevYears, years, premiums } = useMemo(() => {
    const expStart =
      toInt(npDetail.experienceStartYear) ?? toInt(npDetail.experience_start_year) ??
      toInt(npDetail.startYear) ?? toInt(npDetail.start_year) ?? 2015;
    const renewalYear =
      yearFromDate(npDetail.renewalDate) ?? yearFromDate(npDetail.renewal_date) ??
      toInt(npDetail.renewalYear) ?? toInt(npDetail.renewal_year) ??
      new Date().getFullYear();
    const nYears = Math.max(1, Math.min(40, renewalYear - expStart));
    const yrs = Array.from({ length: nYears }, (_, i) => expStart + i);
    // default premiums from appState if available
    const prems = yrs.map(() => 0);
    return { startYear: expStart, numDevYears: nYears, years: yrs, premiums: prems };
  }, [npDetail]);

  // ── State ─────────────────────────────────────────────
  const [dataMode, setDataMode] = useState('DIRECT');   // DIRECT | TRIANGLE
  const [view, setView]         = useState('FACTORS');  // FACTORS | LINK_RATIOS | SUMMARY
  const [avgMethod, setAvgMethod]     = useState('weighted');
  const [projMethod, setProjMethod]   = useState('CHAIN');
  const [chosenBase, setChosenBase]   = useState('ACTUAL');
  const [tailFactor, setTailFactor]   = useState('1.0');
  const [ielr, setIelr]               = useState('0.65');
  const ielrInputId = useId();
  const [chosenLdfs, setChosenLdfs]   = useState([]);
  const [chosenCdfs, setChosenCdfs]   = useState([]);
  const [excluded, setExcluded]       = useState(new Set());

  // Clear position-keyed exclusions when the year window shifts. Excluded
  // ratios are stored as "row:col" strings; once startYear or numDevYears
  // changes the same key reinterprets to a different cell, leaving stale
  // strikethroughs on cells the user never clicked.
  const yearWindowKeyRef = useRef(null);
  useEffect(() => {
    const key = `${startYear}:${numDevYears}`;
    if (yearWindowKeyRef.current === null) { yearWindowKeyRef.current = key; return; }
    if (yearWindowKeyRef.current !== key) {
      yearWindowKeyRef.current = key;
      setExcluded(new Set());
    }
  }, [startYear, numDevYears]);

  // DIRECT mode: one reported excess loss per accident year
  const [manualLosses, setManualLosses] = useState(() => Array(years.length).fill(''));
  // DIRECT mode: manual LDF inputs (one per dev period — user defines how many)
  const [manualLdfCount, setManualLdfCount] = useState(5);
  const [manualLdfs, setManualLdfs]   = useState(Array(10).fill(''));

  // TRIANGLE mode
  const [triCells, setTriCells]       = useState([]);
  const [loading, setLoading]         = useState(false);
  const [dirty, setDirty]             = useState(false);
  const [saveMsg, setSaveMsg]         = useState(null);

  // Load guard
  const loaded = useRef(false);

  // ── Load saved data ────────────────────────────────────
  useEffect(() => {
    if (!contractId) return;
    loaded.current = false;
    setLoading(true);

    Promise.all([
      // Saved excess LDF factors
      api.getDevFactors(contractId, 'NP_EXCESS', apiOpts).catch(() => []),
      // Saved triangle cells (for TRIANGLE mode)
      api.getTriangle(contractId, 'NP_EXCESS', apiOpts).catch(() => ({ cells: [] })),
      // NP terms (stores manualLosses + manualLdfs in JSONB)
      api.getNonPropTreaty(contractId, apiOpts).catch(() => null),
    ]).then(([factors, triData, npData]) => {
      // Restore triangle cells
      const cells = triData?.cells || (Array.isArray(triData) ? triData : []);
      setTriCells(cells);

      // Restore manual losses + LDFs from JSONB terms
      const xd = npData?.terms?.excess_dev_factors;
      if (xd) {
        if (Array.isArray(xd.manualLosses)) setManualLosses(xd.manualLosses.map(v => v != null ? String(v) : ''));
        if (Array.isArray(xd.manualLdfs))   setManualLdfs(xd.manualLdfs.map(v => v != null ? String(v) : ''));
        if (xd.manualLdfCount)               setManualLdfCount(Number(xd.manualLdfCount) || 5);
        if (xd.dataMode)                     setDataMode(xd.dataMode);
        if (xd.projMethod)                   setProjMethod(xd.projMethod);
        if (xd.avgMethod)                    setAvgMethod(xd.avgMethod);
        if (xd.tailFactor != null)           setTailFactor(String(xd.tailFactor));
        if (xd.ielr != null)                 setIelr(String(xd.ielr));
        // Intentionally do not restore xd.chosenBase — the toggle always
        // re-defaults to ACTUAL on page land. Saved chosenLdfs still load.
        if (Array.isArray(xd.excluded)) {
          // Position-keyed ("r:c") exclusions are only valid for the year
          // window they were saved under — drop them if the window has
          // shifted to avoid striking through cells the user never clicked.
          const currentKey = `${startYear}:${numDevYears}`;
          if (!xd.excludedForYearWindow || xd.excludedForYearWindow === currentKey) {
            setExcluded(new Set(xd.excluded));
          }
        }
      }

      // Restore chosen factors
      if (Array.isArray(factors) && factors.length > 0) {
        setChosenLdfs(factors.map(f => f.chosen_ldf ?? f.selected_ldf ?? null));
        setChosenCdfs(factors.map(f => f.chosen_cdf ?? f.selected_cdf ?? null));
      }

      loaded.current = true;
      setLoading(false);
    }).catch(() => { loaded.current = true; setLoading(false); });
  }, [apiOpts, contractId, numDevYears, startYear]);

  // ── Build chain-ladder calcs from TRIANGLE mode cells ──
  const triCalcs = useMemo(() => {
    if (dataMode !== 'TRIANGLE' || !triCells.length) return null;
    const d = buildMatrixFromCells(triCells, startYear, numDevYears);
    if (!d) return null;
    const { matrix } = d;
    const factors = calculateAgeToAgeFactors(matrix);
    const { pattern, warnings: patternWarnings } = calculatePattern(matrix, factors, avgMethod);
    const tail = Number(tailFactor) || 1.0;
    const cdfs = calculateCdfs(pattern, tail);
    const paramCdfs = fitExponentialCdfs(cdfs);
    const paramLdfs = deriveLdfsFromCdfs(paramCdfs);
    return { matrix, factors, pattern, patternWarnings, cdfs, paramLdfs, paramCdfs };
  }, [dataMode, triCells, startYear, numDevYears, avgMethod, tailFactor]);

  // ── Build calc from DIRECT mode manual LDFs ──────────
  const directCalcs = useMemo(() => {
    if (dataMode !== 'DIRECT') return null;
    const N = manualLdfCount;
    const ldfs = manualLdfs.slice(0, N).map(v => Number(v) || 1.0);
    const tail = Number(tailFactor) || 1.0;
    const cdfs = calculateCdfs(ldfs, tail);
    const paramCdfs = fitExponentialCdfs(cdfs);
    const paramLdfs = deriveLdfsFromCdfs(paramCdfs);
    return { pattern: ldfs, cdfs, paramLdfs, paramCdfs };
  }, [dataMode, manualLdfs, manualLdfCount, tailFactor]);

  const activeCalcs = dataMode === 'TRIANGLE' ? triCalcs : directCalcs;

  // ── BF blend (TRIANGLE mode with actual matrix) ───────
  const bfResults = useMemo(() => {
    if (projMethod !== 'BF' || !triCalcs?.matrix) return null;
    const egnpiRows = years.map((yr) => {
      const r = (appState.npTreatyDetail?.egnpiRows || []).find(e => String(e.uwYear || e.uw_year) === String(yr));
      return r ? Number(r.egnpi) || 0 : 0;
    });
    const clProjs = years.map((yr, r) => {
      let latestVal = 0, latestCol = -1;
      const row = triCalcs.matrix[r] || [];
      for (let c = row.length - 1; c >= 0; c--) if (row[c] != null) { latestVal = row[c]; latestCol = c; break; }
      const cdf = latestCol >= 0 ? (triCalcs.cdfs[latestCol] || 1) : 1;
      return { year: yr, latest: latestVal, cdf, ultimate: latestVal * cdf, ibnr: latestVal * cdf - latestVal };
    });
    return calculateBF(clProjs, egnpiRows, Number(ielr) || 0);
  }, [projMethod, triCalcs, years, ielr, appState.npTreatyDetail?.egnpiRows]);

  // ── Sync chosen factors when base changes ────────────
  useEffect(() => {
    if (!activeCalcs || !loaded.current) return;
    const src = chosenBase === 'PARAM'
      ? { ldfs: activeCalcs.paramLdfs, cdfs: activeCalcs.paramCdfs }
      : { ldfs: activeCalcs.pattern, cdfs: activeCalcs.cdfs };
    if (!src.ldfs?.length) return;
    if (chosenLdfs.length !== src.ldfs.length) {
      setChosenLdfs(src.ldfs.map(v => v));
      setChosenCdfs((src.cdfs || []).slice(0, src.ldfs.length).map(v => v));
    }
  }, [activeCalcs, chosenBase, chosenLdfs.length]);

  const handleChosenChange = (type, idx, val) => {
    const n = val === '' ? null : Number(val);
    if (type === 'ldf') setChosenLdfs(prev => { const a = [...prev]; a[idx] = Number.isFinite(n) ? n : prev[idx]; return a; });
    else setChosenCdfs(prev => { const a = [...prev]; a[idx] = Number.isFinite(n) ? n : prev[idx]; return a; });
    setDirty(true);
  };

  const switchBase = (base) => {
    if (!activeCalcs) return;
    setChosenBase(base);
    const src = base === 'PARAM'
      ? { ldfs: activeCalcs.paramLdfs, cdfs: activeCalcs.paramCdfs }
      : { ldfs: activeCalcs.pattern, cdfs: activeCalcs.cdfs };
    setChosenLdfs((src.ldfs || []).map(v => v));
    setChosenCdfs((src.cdfs || []).slice(0, src.ldfs?.length || 0).map(v => v));
    setDirty(true);
  };

  const handleLinkRatioExcludedChange = useCallback((value) => {
    setExcluded(value);
    setDirty(true);
  }, []);

  const applyLinkRatioPattern = useCallback((filteredLdfs, filteredCdfs) => {
    setChosenLdfs(prev => sameNumberArray(prev, filteredLdfs) ? prev : filteredLdfs.map(v => v));
    setChosenCdfs(prev => sameNumberArray(prev, filteredCdfs) ? prev : filteredCdfs.map(v => v));
    setChosenBase(prev => prev === 'LINK_RATIO' ? prev : 'LINK_RATIO');
    setDirty(true);
  }, []);

  // ── Triangle cell edit (TRIANGLE mode) ───────────────
  const setTriCell = useCallback((originYear, devMonth, value) => {
    setTriCells(prev => {
      const idx = prev.findIndex(c => c.origin_year === originYear && c.dev_months === devMonth);
      const updated = [...prev];
      if (idx >= 0) updated[idx] = { ...updated[idx], cum_value: value };
      else updated.push({ origin_year: originYear, dev_months: devMonth, cum_value: value });
      return updated;
    });
    setDirty(true);
  }, []);

  // ── Save ─────────────────────────────────────────────
  const save = useCallback(async (quiet = false) => {
    if (!contractId || !loaded.current) return true;
    try {
      // 1. Save triangle cells (TRIANGLE mode)
      if (dataMode === 'TRIANGLE') {
        // Strip cells that fall outside the upper triangle. The UI gates
        // input by row, but legacy data or accidental writes elsewhere
        // can leave cells where (origin_year - startYear) + (dev_months/12 - 1)
        // ≥ numDevYears — those have no actuarial meaning and bias the
        // link-ratio averages if left in place.
        const triangleCells = triCells.filter(c => {
          const r = Number(c.origin_year) - startYear;
          const col = Math.round(Number(c.dev_months) / 12) - 1;
          if (!Number.isFinite(r) || !Number.isFinite(col) || r < 0 || col < 0) return false;
          return col <= numDevYears - r - 1;
        });
        await api.saveTriangle(contractId, 'NP_EXCESS', { cells: triangleCells }, apiOpts);
      }

      // 2. Save chosen LDF factors
      const N = chosenLdfs.length;
      if (N > 0) {
        const factors = Array.from({ length: N }, (_, i) => ({
          dev_month: (i + 1) * 12,
          chosen_source: serializeChosenSource(chosenBase),
          chosen_ldf: chosenLdfs[i] ?? null,
          chosen_cdf: chosenCdfs[i] ?? null,
          selected_ldf: chosenLdfs[i] ?? null,
          selected_cdf: chosenCdfs[i] ?? null,
          actual_ldf: activeCalcs?.pattern?.[i] ?? null,
          actual_cdf: activeCalcs?.cdfs?.[i] ?? null,
          parametrized_ldf: activeCalcs?.paramLdfs?.[i] ?? null,
          parametrized_cdf: activeCalcs?.paramCdfs?.[i] ?? null,
        }));
        await api.saveDevFactors(contractId, 'NP_EXCESS', { factors, method: avgMethod, tail_factor: Number(tailFactor) || 1.0 }, apiOpts);
      }

      // 3. Save manual inputs + settings to JSONB terms
      await api.saveNonPropTreaty(contractId, {
        terms: {
          excess_dev_factors: {
            dataMode, projMethod, avgMethod, tailFactor: Number(tailFactor) || 1.0,
            ielr: Number(ielr) || 0, chosenBase,
            manualLosses: manualLosses.map(v => Number(v) || 0),
            manualLdfs: manualLdfs.map(v => Number(v) || 0),
            manualLdfCount,
            excluded: [...excluded],
            // Stamp the year window the position-keyed exclusions are
            // valid for; load gates restoration on this matching.
            excludedForYearWindow: `${startYear}:${numDevYears}`,
            updatedAt: new Date().toISOString(),
          }
        }
      }, apiOpts);

      setDirty(false);
      if (!quiet) {
        setSaveMsg({ type: 'ok', text: 'Saved' });
        setTimeout(() => setSaveMsg(null), 2000);
      }
      return true;
    } catch (e) {
      logger.error('NpExcessDevFactors save:', e);
      setSaveMsg({ type: 'err', text: 'Save failed' });
      setTimeout(() => setSaveMsg(null), 3000);
      return false;
    }
  }, [contractId, dataMode, chosenLdfs, projMethod, avgMethod, tailFactor, ielr, chosenBase, manualLosses, manualLdfs, manualLdfCount, excluded, startYear, numDevYears, apiOpts, triCells, chosenCdfs, activeCalcs?.pattern, activeCalcs?.cdfs, activeCalcs?.paramLdfs, activeCalcs?.paramCdfs]);

  // ── Render triangle input grid ────────────────────────
  const renderTriangleInput = () => {
    const devPeriods = Array.from({ length: numDevYears }, (_, i) => (i + 1) * 12);
    return (
      <div className="df-section">
        <div className="df-section-head">
          <div className="df-section-title">Excess Loss Triangle</div>
          <div className="df-section-sub">Enter cumulative excess losses (XS retention) per accident year × development period</div>
        </div>
        <div className="df-card"><div className="df-scrollX">
          <table className="df-table">
            <thead><tr>
              <th className="df-h df-h--sticky">Year</th>
              {devPeriods.map(d => <th key={d} className="df-h">{d}m</th>)}
            </tr></thead>
            <tbody>
              {years.map((yr, r) => {
                const maxDev = devPeriods.length - r; // upper triangle only
                return (
                  <tr key={yr}>
                    <td className="df-r df-r--sticky">{yr}</td>
                    {devPeriods.map((dm, c) => {
                      const cell = triCells.find(tc => tc.origin_year === yr && tc.dev_months === dm);
                      const isActive = c < maxDev;
                      return (
                        <td key={dm} className="df-c" style={{ opacity: isActive ? 1 : 0.2 }}>
                          {isActive
                            ? <input
                                className="df-input"
                                value={cell?.cum_value != null ? String(cell.cum_value) : ''}
                                onChange={e => setTriCell(yr, dm, e.target.value === '' ? null : Number(e.target.value) || 0)}
                                style={{ width: 120, textAlign: 'right' }}
                              />
                            : <div className="df-val" style={{ background: 'rgba(8,16,40,0.05)' }} />
                          }
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div></div>
      </div>
    );
  };

  // ── Render direct entry ───────────────────────────────
  const renderDirectEntry = () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {/* Reported excess losses */}
      <div className="df-section">
        <div className="df-section-head">
          <div className="df-section-title">Reported Excess Losses</div>
          <div className="df-section-sub">Cumulative reported losses above the retention, per accident year</div>
        </div>
        <div className="df-card"><div className="df-scrollX">
          <table className="df-table">
            <thead><tr>
              <th className="df-h df-h--sticky">Year</th>
              <th className="df-h">Reported XS Loss</th>
            </tr></thead>
            <tbody>
              {years.map((yr, i) => (
                <tr key={yr}>
                  <td className="df-r df-r--sticky">{yr}</td>
                  <td className="df-c">
                    <input
                      className="df-input"
                      value={manualLosses[i] ?? ''}
                      onChange={e => { const a = [...manualLosses]; a[i] = e.target.value; setManualLosses(a); setDirty(true); }}
                      style={{ width: 140, textAlign: 'right' }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      </div>

      {/* Manual LDFs */}
      <div className="df-section">
        <div className="df-section-head">
          <div className="df-section-title">Input Development Factors</div>
          <div className="df-section-sub">
            Enter LDFs from benchmark or market data
            <span style={{ marginLeft: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'rgba(var(--text-rgb),0.7)' }}>Dev periods:</span>
              <input type="number" min={1} max={15} value={manualLdfCount}
                onChange={e => { setManualLdfCount(Math.max(1, Math.min(15, Number(e.target.value) || 1))); setDirty(true); }}
                style={{ width: 52, textAlign: 'center', background: 'var(--control-bg)', border: '1px solid var(--stroke-soft)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '2px 4px' }} />
            </span>
          </div>
        </div>
        <div className="df-card"><div className="df-scrollX">
          <table className="df-table">
            <thead><tr>
              <th className="df-h df-h--sticky">Period</th>
              <th className="df-h">LDF</th>
            </tr></thead>
            <tbody>
              {Array.from({ length: manualLdfCount }, (_, i) => (
                <tr key={i}>
                  <td className="df-r df-r--sticky">{i + 1}–{i + 2}</td>
                  <td className="df-c">
                    <input
                      className="df-input"
                      value={manualLdfs[i] ?? ''}
                      onChange={e => { const a = [...manualLdfs]; a[i] = e.target.value; setManualLdfs(a); setDirty(true); }}
                      style={{ width: 120, textAlign: 'center' }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      </div>
    </div>
  );

  const hasCalcs = !!(activeCalcs?.pattern?.length);

  return (
    <WizardLayout
      routeKey={ROUTE_KEY}
      title="Excess LDFs"
      headerPill={`${pfx}: EXCESS DEVELOPMENT FACTORS`}
      onBeforeNext={() => save(true)}
      onBeforeBack={() => save(true)}
    >
      {({ showToast }) => (
        <div className="DEV_FACTORS_PAGE">

          {/* ── Top meta bar ── */}
          <div className="df-toprow">
            <div className="df-controls">
              <div className="df-mini">
                <div className="df-mini-label">Start Year</div>
                <div className="df-mini-value">{startYear}</div>
              </div>
              <div className="df-mini">
                <div className="df-mini-label">Dev Years</div>
                <div className="df-mini-value">{numDevYears}</div>
              </div>
              <div className="df-mini">
                <div className="df-mini-label">Tail Factor</div>
                <input
                  type="number" step="0.01" min="1"
                  value={tailFactor}
                  onChange={e => { setTailFactor(e.target.value); setDirty(true); }}
                  style={{ width: 72, textAlign: 'center', background: 'var(--control-bg)', border: '1px solid var(--stroke-soft)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '2px 6px' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Data mode toggle */}
              <div className="df-method">
                <div className="df-method-label">Data Mode</div>
                <div className="toggle-group df-method-toggle">
                  <button type="button" className={`toggle-option${dataMode === 'DIRECT' ? ' active' : ''}`} onClick={() => setDataMode('DIRECT')}>Direct Entry</button>
                  <button type="button" className={`toggle-option${dataMode === 'TRIANGLE' ? ' active' : ''}`} onClick={() => setDataMode('TRIANGLE')}>Triangle</button>
                </div>
              </div>
              {/* Projection method (TRIANGLE mode only) */}
              {dataMode === 'TRIANGLE' && (
                <div className="df-method">
                  <div className="df-method-label">Projection</div>
                  <div className="toggle-group df-method-toggle">
                    <button type="button" className={`toggle-option${projMethod === 'CHAIN' ? ' active' : ''}`} onClick={() => setProjMethod('CHAIN')}>Chain Ladder</button>
                    <button type="button" className={`toggle-option${projMethod === 'BF' ? ' active' : ''}`} onClick={() => setProjMethod('BF')}>BF</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* BF IELR */}
          {dataMode === 'TRIANGLE' && projMethod === 'BF' && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', margin: '12px 0', padding: '10px 16px', borderRadius: 14, background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.2)' }}>
              <label htmlFor={ielrInputId} style={{ fontSize: 12, color: 'var(--accent-amber)', fontWeight: 600 }}>Initial Expected XS Loss Ratio (IELR)</label>
              <input id={ielrInputId} type="number" min="0" max="2" step="0.01" value={ielr}
                onChange={e => setIelr(e.target.value)}
                style={{ width: 100, textAlign: 'center', background: 'var(--control-bg)', border: '1px solid rgba(249,115,22,0.4)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '4px 8px' }} />
              <span style={{ fontSize: 11, color: 'rgba(var(--text-rgb),0.7)' }}>{(Number(ielr) * 100 || 0).toFixed(0)}%</span>
            </div>
          )}

          {/* ── View toggle ── */}
          <div style={{ margin: '12px 0 10px' }}>
            <div className="toggle-group" style={{ display: 'inline-flex' }}>
              {[
                ['FACTORS',     '📊 Development Factors'],
                ['LINK_RATIOS', '🔗 Link Ratios'],
                ['SUMMARY',     '📋 Ultimate Summary'],
              ].map(([key, label]) => (
                <button type="button" key={key} className={`toggle-option${view === key ? ' active' : ''}`}
                  onClick={() => setView(key)} style={{ fontSize: 12, padding: '8px 16px' }}>
                  {label}
                </button>
              ))}
            </div>
            {/* Save button + status */}
            <span style={{ float: 'right', display: 'flex', alignItems: 'center', gap: 10 }}>
              {saveMsg && (
                <span style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6,
                  background: saveMsg.type === 'ok' ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)',
                  color: saveMsg.type === 'ok' ? 'var(--accent)' : 'var(--accent-rose)',
                  border: `1px solid ${saveMsg.type === 'ok' ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}` }}>
                  {saveMsg.text}
                </span>
              )}
              {dirty && <span className="muted">Unsaved changes</span>}
              <button className="orange-gloss-btn" onClick={async () => { const ok = await save(); showToast?.(ok ? 'Excess LDFs saved' : 'Save failed'); }}>
                💾 Save
              </button>
            </span>
          </div>

          {loading ? (
            <div className="muted" style={{ padding: 16 }}>Loading…</div>
          ) : (<>

            {/* Thin-column LDF warnings — surfaced from calculatePattern.
                A column whose LDF derives from fewer than 3 origin years
                is one or two observations dressed up as a portfolio
                average. Show before the user picks a base. */}
            {Array.isArray(activeCalcs?.patternWarnings) && activeCalcs.patternWarnings.length > 0 && (
              <div
                role="alert"
                style={{
                  marginTop: 14,
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: 'rgba(251,146,60,0.08)',
                  border: '1px solid rgba(251,146,60,0.30)',
                  color: 'var(--accent-amber)',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  ⚠ Thin LDF columns ({activeCalcs.patternWarnings.length})
                </div>
                {activeCalcs.patternWarnings.map((w) => (
                  <div key={w.column} style={{ opacity: 0.9 }}>
                    {w.devPeriod} — {w.contributingRows} origin year{w.contributingRows === 1 ? '' : 's'} (recommended ≥ 3)
                  </div>
                ))}
              </div>
            )}

            {/* ══ FACTORS VIEW ══ */}
            {view === 'FACTORS' && (<>

              {/* Data entry area */}
              {dataMode === 'DIRECT' ? renderDirectEntry() : renderTriangleInput()}

              {/* TRIANGLE: avg method */}
              {dataMode === 'TRIANGLE' && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '12px 0' }}>
                  <span style={{ fontSize: 11, color: 'rgba(var(--text-rgb),0.7)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Average</span>
                  <div className="toggle-group">
                    {['weighted', 'simple', 'last3', 'last5'].map(m => (
                      <button type="button" key={m} className={`toggle-option${avgMethod === m ? ' active' : ''}`}
                        onClick={() => setAvgMethod(m)}>
                        {m === 'weighted' ? 'Weighted' : m === 'simple' ? 'Simple' : m === 'last3' ? 'Last 3' : 'Last 5'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {hasCalcs && (<>
                {/* Actual / Direct LDFs */}
                <div className="df-section">
                  <div className="df-section-head">
                    <div className="df-section-title">{dataMode === 'DIRECT' ? 'Input' : 'Actual'} Development Factors</div>
                    <div className="df-section-sub">
                      {dataMode === 'DIRECT' ? 'From manual LDF inputs above' : `Derived from excess triangle (${avgMethod})`}
                    </div>
                  </div>
                  <FactorTable pattern={activeCalcs.pattern} cdfs={activeCalcs.cdfs} />
                </div>

                {/* Parametrized */}
                <div className="df-section df-section--parametrized">
                  <div className="df-section-head">
                    <div className="df-section-title">Parametrized Development Factors</div>
                    <div className="df-section-sub">Exponential fit to cumulative development</div>
                  </div>
                  <FactorTable pattern={activeCalcs.paramLdfs} cdfs={activeCalcs.paramCdfs} sectionClass="df-card--param" />
                </div>

                {/* BF results */}
                {projMethod === 'BF' && bfResults && <BFProjectionsTable bfResults={bfResults} />}

                {/* Underwriter chosen */}
                <div className="df-section df-section--underwriter">
                  <div className="df-section-head">
                    <div className="df-section-title">Underwriter Chosen Factors</div>
                  </div>
                  <div className="df-chosen-controls">
                    <div className="df-chosen-left">
                      <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.7)', marginBottom: 4 }}>Base</div>
                      <div className="toggle-group df-chosen-toggle">
                        <button type="button" className={`toggle-option${chosenBase === 'ACTUAL' ? ' active' : ''}`} onClick={() => switchBase('ACTUAL')}>
                          {dataMode === 'DIRECT' ? 'INPUT' : 'ACTUAL'}
                        </button>
                        <button type="button" className={`toggle-option${chosenBase === 'PARAM' ? ' active' : ''}`} onClick={() => switchBase('PARAM')}>PARAM</button>
                        <span className={`toggle-option${chosenBase === 'LINK_RATIO' ? ' active' : ''}`}
                          style={chosenBase === 'LINK_RATIO' ? {} : { opacity: 0.35 }}>LINK RATIOS</span>
                      </div>
                    </div>
                  </div>
                  {chosenLdfs.length > 0
                    ? <FactorTable pattern={chosenLdfs} cdfs={chosenCdfs} editable onChange={handleChosenChange} sectionClass="df-card--chosen" />
                    : <div className="muted" style={{ padding: 12 }}>
                        <button style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: 'var(--accent)', cursor: 'pointer' }}
                          onClick={() => switchBase(chosenBase)}>
                          ↳ Load factors from {chosenBase === 'PARAM' ? 'parametrized' : dataMode === 'DIRECT' ? 'input' : 'actual'} set
                        </button>
                      </div>
                  }
                </div>
              </>)}

              {!hasCalcs && dataMode === 'DIRECT' && (
                <div className="df-card df-card--notice" style={{ marginTop: 14 }}>
                  <div className="df-note">Enter LDFs above to compute development factors.</div>
                </div>
              )}
              {!hasCalcs && dataMode === 'TRIANGLE' && (
                <div className="df-card df-card--notice" style={{ marginTop: 14 }}>
                  <div className="df-note">Enter excess triangle data above to compute development factors.</div>
                </div>
              )}
            </>)}

            {/* ══ LINK RATIOS VIEW (TRIANGLE mode only) ══ */}
            {view === 'LINK_RATIOS' && (<>
              {dataMode !== 'TRIANGLE' ? (
                <div className="df-card df-card--notice" style={{ marginTop: 14 }}>
                  <div className="df-note">Switch to Triangle mode to use the link ratio view.</div>
                </div>
              ) : !triCalcs?.matrix ? (
                <div className="df-card df-card--notice" style={{ marginTop: 14 }}>
                  <div className="df-note">Enter excess triangle data first.</div>
                </div>
              ) : (<>
                <LinkRatioView
                  matrix={triCalcs.matrix}
                  years={years}
                  numDevYears={numDevYears}
                  excluded={excluded}
                  setExcluded={handleLinkRatioExcludedChange}
                  onPatternChange={applyLinkRatioPattern}
                />
                {excluded.size > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(var(--accent-rose-rgb),0.9)' }}>
                    {excluded.size} ratio(s) excluded
                  </div>
                )}
              </>)}
            </>)}

            {/* ══ ULTIMATE SUMMARY VIEW ══ */}
            {view === 'SUMMARY' && (
              chosenLdfs.length === 0 ? (
                <div className="df-card df-card--notice" style={{ marginTop: 14 }}>
                  <div className="df-note">Load development factors first (in the Development Factors tab).</div>
                </div>
              ) : (
                <UltimateSummaryTable
                  years={years}
                  chosenCdfs={chosenCdfs}
                  manualLosses={manualLosses}
                  premiums={premiums}
                />
              )
            )}

          </>)}
        </div>
      )}
    </WizardLayout>
  );
}
