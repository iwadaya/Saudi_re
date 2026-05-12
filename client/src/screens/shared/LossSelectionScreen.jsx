import { useState, useEffect, useCallback, useMemo } from 'react';
import WizardLayout from '../../components/WizardLayout';
import PctInput from '../../components/PctInput';
import { useContractId } from '../../hooks/useContractId';
import { useAppState } from '../../context/AppContext';
import { api } from '../../api';
import { fmtOrEm as fmt, toN as cn } from '../../utils/format';

function fp(n, d = 1) { return n == null ? '—' : `${Number(n).toFixed(d)}%`; }

export default function LossSelectionScreen({ routeKey, title, headerPill, lossType = 'large', embedded = false }) {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const [losses, setLosses] = useState([]);
  const [threshold, setThreshold] = useState('');
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  // Inflation state
  const [showInflModal, setShowInflModal] = useState(false);
  const [inflData, setInflData] = useState([]); // from ref_country_inflation
  const [inflMode, setInflMode] = useState('table'); // 'table' | 'average' | 'manual' | 'growth' (cat only)
  const [manualInflPct, setManualInflPct] = useState('3.0');
  const [countryId, setCountryId] = useState(null);
  const [countryName, setCountryName] = useState('');
  const [contractUwYear, setContractUwYear] = useState(null);
  const [inceptionYear, setInceptionYear] = useState(null);

  // Growth in portfolio state (cat only)
  const [showGrowthModal, setShowGrowthModal] = useState(false);
  const [premiumByYear, setPremiumByYear] = useState([]); // [{year, premium}]
  const [growthMode, setGrowthMode] = useState('calculated'); // 'calculated' | 'manual'
  const [manualGrowthPct, setManualGrowthPct] = useState('5.0');

  // Loss-loading analysis modal — sum(losses)/premium per year
  const [showLoadingModal, setShowLoadingModal] = useState(false);
  const [premiumLoading, setPremiumLoading] = useState(false);

  // Additional loadings
  const [loadings, setLoadings] = useState([]);

  // Load contract info
  useEffect(() => {
    if (!contractId) return;
    api.getContract(contractId, appState.quoteMode ? { quote: true } : undefined).then(c => {
      setCountryId(c?.header?.country_id || c?.country_id);
      setCountryName(c?.header?.country_name || c?.country_name || '');
      const uy = c?.header?.uw_year || c?.uw_year || new Date().getFullYear();
      setContractUwYear(uy);
      // Derive inception year from inception_date, falling back to renewal_date, then UW year
      const incDate = c?.detail?.inception_date || c?.header?.inception_date;
      const renDate = c?.detail?.renewal_date || c?.header?.renewal_date;
      if (incDate) {
        setInceptionYear(new Date(incDate).getFullYear());
      } else if (renDate) {
        setInceptionYear(new Date(renDate).getFullYear());
      } else {
        setInceptionYear(Number(uy) || new Date().getFullYear());
      }
    }).catch(() => {});
  }, [appState.quoteMode, contractId]);

  // Auto-load inflation data for the contract's country as soon as countryId is known
  useEffect(() => {
    if (!countryId) return;
    api.getRefInflation(countryId).then(data => {
      setInflData(Array.isArray(data) ? data : []);
    }).catch(() => setInflData([]));
  }, [countryId]);

  // Load losses + snapshot in parallel, then merge inflation factors from snapshot items
  useEffect(() => {
    if (!contractId) { setLoading(false); setLosses([]); return; }
    setLoading(true);
    setLosses([]);
    setThreshold('');
    setLoadings([]);
    setInflMode('table');
    setDirty(false);

    const fetchFn = lossType === 'cat' ? api.getCatLosses : api.getLargeLosses;
    const qm = appState.quoteMode ? { quote: true } : undefined;

    Promise.all([
      fetchFn(contractId, qm).catch(() => ({ losses: [] })),
      api.getLossSelectionLatest(contractId, lossType, qm).catch(() => null),
    ]).then(([lossData, snapData]) => {
      // ── Restore assumptions from snapshot ──────────────────────
      const snap = snapData?.snapshot;
      const snapItems = Array.isArray(snapData?.items) ? snapData.items : [];

      if (snap) {
        if (snap.loadings && Array.isArray(snap.loadings) && snap.loadings.length > 0) {
          setLoadings(snap.loadings.map(l => ({ name: l.name || '', pct: l.pct != null ? String(l.pct) : '' })));
        }
        if (snap.threshold) setThreshold(String(snap.threshold));
        if (snap.inflation_mode) setInflMode(snap.inflation_mode);
        if (snap.inflation_rate_pct != null) {
          if (snap.inflation_mode === 'manual') setManualInflPct(String(snap.inflation_rate_pct));
          if (snap.inflation_mode === 'growth') setManualGrowthPct(String(snap.inflation_rate_pct));
        }
      }

      // ── Build snapshot item lookup: by loss_id first, then uw_year+incurred ──
      // Restores exact per-loss inflation factors from the last saved snapshot,
      // authoritative over whatever is in the raw loss table.
      const byLossId = {};
      const byYearInc = {};
      for (const item of snapItems) {
        if (item.source_loss_id) byLossId[item.source_loss_id] = item;
        const key = `${item.uw_year}|${Math.round(cn(item.incurred))}`;
        if (!byYearInc[key]) byYearInc[key] = item;
      }

      // ── Parse and merge raw losses with snapshot items ────────
      const list = lossData?.losses || lossData || [];
      const parsed = (Array.isArray(list) ? list : []).map(l => {
        const inc = cn(l.incurred) || (cn(l.paid) + cn(l.os));
        const dol = l.date_of_loss || l.dateOfLoss || '';
        let uwYear = null;
        if (dol) {
          const s = String(dol).trim();
          const ymd = s.match(/^(\d{4})-/);
          if (ymd) { uwYear = parseInt(ymd[1], 10); }
          else { const dmy = s.match(/(\d{4})$/); if (dmy) uwYear = parseInt(dmy[1], 10); }
        }
        if (!uwYear || isNaN(uwYear)) uwYear = l.uw_year || null;

        // Snapshot item wins over raw loss table for inflation assumptions
        // — but only when the underlying loss hasn't drifted since the
        // snapshot was taken. If someone edited the loss-list screen
        // afterwards (e.g. corrected an incurred figure), the snapshot's
        // inflation_factor was calibrated against the stale value and
        // would produce a wrong inflated_incurred. Compare the snapshot's
        // recorded incurred to the current loss's incurred; if they
        // diverge by >2% drop the snapshot for this loss and re-derive
        // from the raw row.
        let snapItem = byLossId[l.loss_id] || byYearInc[`${uwYear}|${Math.round(inc)}`];
        if (snapItem) {
          const snapIncurred = cn(snapItem.incurred);
          const denom = Math.max(Math.abs(snapIncurred), Math.abs(inc));
          if (denom > 0 && Math.abs(snapIncurred - inc) / denom > 0.02) {
            snapItem = null;
          }
        }
        const inflFactor = snapItem ? (cn(snapItem.inflation_factor) || 1) : (cn(l.inflation_factor) || 1);
        const inflatedInc = snapItem
          ? (cn(snapItem.inflated_incurred) || inc * inflFactor)
          : (cn(l.inflated_incurred) || inc * inflFactor);

        return {
          ...l, uw_year: uwYear, incurred: inc,
          inflation_factor: inflFactor,
          inflated_incurred: inflatedInc,
          is_selected: snapItem ? true : (l.is_selected !== false),
        };
      });

      setLosses(parsed);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [appState.quoteMode, contractId, lossType]);

  // Load premium by year for growth modal (cat only). Three data
  // sources in priority order — the right one depends on the
  // workflow the cat-loss screen is running under:
  //
  //   1. NP workflows (routeKey starts with NP_) — the NP Premiums
  //      Table screen writes contract_np_egnpi_year [{uw_year, egnpi,
  //      inflation_pct}]. EGNPI is the annual premium-equivalent
  //      for non-prop.
  //   2. Straight-stats (no-triangulation prop workflow) —
  //      /api/straight-stats/load/:id returns [{underwriting_year,
  //      premium, paid_claims, os_claims}].
  //   3. Premium triangle (triangulation prop workflow) — fallback
  //      via api.getTriangle(id, 'PREMIUM'); we take the highest
  //      cumulative value per origin_year.
  const loadPremiumGrowth = useCallback(async () => {
    if (!contractId) return;
    const qm = appState.quoteMode ? { quote: true } : undefined;
    const isNp = String(routeKey || '').startsWith('NP_');
    try {
      // 1. NP workflows → egnpi-year
      if (isNp) {
        const rows = await api.getNpEgnpiYear(contractId, qm).catch(() => []);
        const mapped = (Array.isArray(rows) ? rows : [])
          .map(r => ({ year: Number(r.uw_year ?? r.year), premium: cn(r.egnpi) }))
          .filter(r => Number.isFinite(r.year) && r.premium > 0)
          .sort((a, b) => a.year - b.year);
        if (mapped.length >= 2) { setPremiumByYear(mapped); return; }
      }

      // 2. Prop no-triangulation → straight-stats
      const straight = await api.getStraightStats(contractId).catch(() => null);
      const stats = Array.isArray(straight?.stats) ? straight.stats : [];
      if (stats.length >= 2) {
        const byYear = {};
        stats.forEach(r => {
          const y = Number(r.underwriting_year ?? r.year);
          const p = cn(r.premium);
          if (Number.isFinite(y) && p > 0) byYear[y] = p;
        });
        const arr = Object.entries(byYear)
          .map(([y, p]) => ({ year: Number(y), premium: p }))
          .sort((a, b) => a.year - b.year);
        if (arr.length >= 2) { setPremiumByYear(arr); return; }
      }

      // 3. Prop triangulation → premium triangle
      const premRes = await api.getTriangle(contractId, 'PREMIUM', qm).catch(() => ({ cells: [] }));
      const cells = Array.isArray(premRes) ? premRes : (premRes?.cells || []);
      const byYear = {};
      cells.forEach(c => {
        const y = Number(c.origin_year);
        const v = cn(c.cum_value);
        if (!byYear[y] || v > byYear[y]) byYear[y] = v;
      });
      const arr = Object.entries(byYear).map(([y, p]) => ({ year: Number(y), premium: p })).sort((a, b) => a.year - b.year);
      setPremiumByYear(arr);
    } catch { setPremiumByYear([]); }
  }, [contractId, routeKey, appState.quoteMode]);

  // Toggle
  const toggleSelection = i => { setLosses(prev => { const n = [...prev]; n[i] = { ...n[i], is_selected: !n[i].is_selected }; return n; }); setDirty(true); };
  const selectAll = () => { setLosses(l => l.map(r => ({ ...r, is_selected: true }))); setDirty(true); };
  const selectNone = () => { setLosses(l => l.map(r => ({ ...r, is_selected: false }))); setDirty(true); };
  // Threshold filters by inflated_incurred so curve fitting (which operates in
  // inflated/trended space) sees exactly the claims at or above the cutoff.
  const applyThreshold = () => {
    const t = cn(threshold);
    if (!t) return;
    setLosses(l => l.map(r => {
      const inc = cn(r.incurred);
      const factor = cn(r.inflation_factor) || 1;
      const inflated = inc * factor;
      return { ...r, is_selected: inflated >= t };
    }));
    setDirty(true);
  };

  // Apply inflation to losses based on mode
  // Factor compounds from the loss year to the inception year (the start of the new treaty period)
  const applyInflation = (mode, extraData) => {
    const targetYear = inceptionYear || contractUwYear || new Date().getFullYear();
    setLosses(prev => prev.map(l => {
      const lossYear = l.uw_year || targetYear;
      const years = Math.max(0, targetYear - lossYear);
      let factor = 1;
      if (mode === 'table') {
        // Compound year-by-year inflation from loss year to inception year using DB table
        for (let y = lossYear; y < targetYear; y++) {
          const row = inflData.find(r => (r.uwYear || r.uw_year) === y);
          const pct = row ? cn(row.inflationPct || row.inflation_pct) : 0;
          factor *= (1 + pct / 100);
        }
      } else if (mode === 'average') {
        const avg = inflData.length > 0 ? inflData.reduce((s, r) => s + cn(r.inflationPct || r.inflation_pct), 0) / inflData.length : 3;
        factor = Math.pow(1 + avg / 100, years);
      } else if (mode === 'manual') {
        const pct = cn(extraData || manualInflPct);
        factor = Math.pow(1 + pct / 100, years);
      } else if (mode === 'growth') {
        // Use premium growth as proxy for exposure growth to inflate cat losses
        const pct = cn(extraData || manualGrowthPct);
        factor = Math.pow(1 + pct / 100, years);
      }
      return { ...l, inflation_factor: Math.round(factor * 10000) / 10000 };
    }));
    setDirty(true);
    setShowInflModal(false);
    setShowGrowthModal(false);
  };

  // Loadings
  const addLoading = () => { setLoadings(prev => [...prev, { name: '', pct: '' }]); };
  const updateLoading = (i, field, val) => { setLoadings(prev => { const n = [...prev]; n[i] = { ...n[i], [field]: val }; return n; }); setDirty(true); };
  const removeLoading = i => { setLoadings(prev => prev.filter((_, j) => j !== i)); setDirty(true); };
  const totalLoadingPct = loadings.reduce((s, l) => s + cn(l.pct), 0);

  // Summary
  const selected = useMemo(() => losses.filter(l => l.is_selected), [losses]);
  const totalIncurred = useMemo(() => selected.reduce((s, l) => s + cn(l.incurred), 0), [selected]);
  const totalInflated = useMemo(() => selected.reduce((s, l) => s + cn(l.incurred) * cn(l.inflation_factor), 0), [selected]);
  const totalLoaded = totalInflated * (1 + totalLoadingPct / 100);
  const avgFactor = selected.length > 0 ? selected.reduce((s, l) => s + cn(l.inflation_factor), 0) / selected.length : 1;

  // Save
  const save = useCallback(async () => {
    if (!contractId) return true;
    try {
      const saveFn = lossType === 'cat' ? api.saveCatLosses : api.saveLargeLosses;
      const saveRes = await saveFn(contractId, {
        losses: losses.map(l => ({ ...l, is_selected: l.is_selected, inflation_factor: cn(l.inflation_factor) })),
      }, appState.quoteMode ? { quote: true } : undefined);
      // Update loss_ids from server response for audit traceability
      if (saveRes?.loss_ids && Array.isArray(saveRes.loss_ids)) {
        setLosses(prev => prev.map((l, i) => ({ ...l, loss_id: saveRes.loss_ids[i] || l.loss_id })));
      }
      // Also save selection metadata (loadings, inflation, threshold) as a snapshot
      const selSnapshot = {
        inflation_mode: inflMode || null,
        inflation_rate_pct: inflMode === 'manual' ? cn(manualInflPct) : inflMode === 'growth' ? cn(manualGrowthPct) : null,
        inflation_to_year: inceptionYear || contractUwYear || null,
        threshold: cn(threshold) || null,
        loadings: loadings.length > 0 ? loadings : null,
        total_loading_pct: totalLoadingPct || null,
        selected_count: selected.length,
        selected_losses: selected.map(l => ({
          loss_id: l.loss_id, uw_year: l.uw_year, insured_name: l.insured_name, loss_name: l.loss_name,
          date_of_loss: l.date_of_loss, class_of_business: l.class_of_business,
          paid: l.paid, os: l.os, incurred: l.incurred,
          inflation_factor: l.inflation_factor,
          inflated_incurred: cn(l.inflated_incurred) || cn(l.incurred) * cn(l.inflation_factor),
          inflated: cn(l.inflated_incurred) || cn(l.incurred) * cn(l.inflation_factor),
        })),
      };
      // The snapshot is sidecar metadata (selection state + inflation +
      // loadings) downstream screens read instead of recomputing. The
      // loss list itself is already persisted above, so a snapshot
      // failure isn't fatal — but it must not be silent either, since
      // the next screen will then load with stale or default values.
      // Surface a soft warning toast instead of swallowing the error.
      let snapshotOk = true;
      try {
        await api.saveLossSelectionSnapshot(contractId, lossType, selSnapshot, appState.quoteMode ? { quote: true } : undefined);
      } catch (e) {
        snapshotOk = false;
        console.warn('Snapshot save failed:', e);
      }
      setDirty(false);
      if (snapshotOk) {
        setSaveMsg({ type: 'ok', text: 'Saved' });
      } else {
        setSaveMsg({ type: 'warn', text: 'Saved (selection metadata not persisted — downstream screens may use defaults)' });
      }
      setTimeout(() => setSaveMsg(null), snapshotOk ? 2000 : 4000);
      return true;
    } catch (e) { setSaveMsg({ type: 'err', text: 'Save failed' }); setTimeout(() => setSaveMsg(null), 3000); return false; }
  }, [contractId, losses, lossType, loadings, totalLoadingPct, inflMode, manualInflPct, manualGrowthPct, threshold, inceptionYear, contractUwYear, selected, appState.quoteMode]);

  // ── Loss-loading analysis ────────────────────────────────────────────
  // For each year we have premium for, sum the *selected* losses in that
  // year (incurred + inflated). The yearly loading is losses/premium —
  // an estimate of how much premium needs to be loaded to cover this layer
  // of losses. The "all years" figure is the sum of selected losses across
  // matched years over the sum of premium for those same years (a weighted
  // average — single big year doesn't dominate via simple-average).
  const lossLoading = useMemo(() => {
    if (premiumByYear.length === 0) return { rows: [], totalLosses: 0, totalInflated: 0, totalPremium: 0, overallPct: null, overallInflatedPct: null, simpleAvgPct: null, simpleAvgInflatedPct: null };
    const byYearLoss = new Map();
    for (const l of selected) {
      const y = Number(l.uw_year);
      if (!Number.isFinite(y)) continue;
      const inc = cn(l.incurred);
      const infl = cn(l.incurred) * cn(l.inflation_factor);
      if (!byYearLoss.has(y)) byYearLoss.set(y, { count: 0, incurred: 0, inflated: 0 });
      const r = byYearLoss.get(y);
      r.count += 1; r.incurred += inc; r.inflated += infl;
    }
    const rows = premiumByYear.map(({ year, premium }) => {
      const l = byYearLoss.get(year) || { count: 0, incurred: 0, inflated: 0 };
      const pct = premium > 0 ? (l.incurred / premium) * 100 : null;
      const inflPct = premium > 0 ? (l.inflated / premium) * 100 : null;
      return { year, premium, count: l.count, incurred: l.incurred, inflated: l.inflated, pct, inflatedPct: inflPct };
    });
    // Trailing years with no premium would skew the totals; only matched years count.
    const matched = rows.filter(r => r.premium > 0);
    const totalLosses = matched.reduce((s, r) => s + r.incurred, 0);
    const totalInflated = matched.reduce((s, r) => s + r.inflated, 0);
    const totalPremium = matched.reduce((s, r) => s + r.premium, 0);
    const overallPct = totalPremium > 0 ? (totalLosses / totalPremium) * 100 : null;
    const overallInflatedPct = totalPremium > 0 ? (totalInflated / totalPremium) * 100 : null;
    const yearsWithLoss = matched.filter(r => r.pct != null && r.count > 0);
    const simpleAvgPct = yearsWithLoss.length > 0 ? yearsWithLoss.reduce((s, r) => s + r.pct, 0) / yearsWithLoss.length : null;
    const simpleAvgInflatedPct = yearsWithLoss.length > 0 ? yearsWithLoss.reduce((s, r) => s + r.inflatedPct, 0) / yearsWithLoss.length : null;
    return { rows, totalLosses, totalInflated, totalPremium, overallPct, overallInflatedPct, simpleAvgPct, simpleAvgInflatedPct };
  }, [selected, premiumByYear]);

  const openLoadingModal = useCallback(async () => {
    setShowLoadingModal(true);
    if (premiumByYear.length === 0) {
      setPremiumLoading(true);
      try { await loadPremiumGrowth(); } finally { setPremiumLoading(false); }
    }
  }, [premiumByYear.length, loadPremiumGrowth]);

  // Calculate growth rates from premium data
  const growthRates = useMemo(() => {
    if (premiumByYear.length < 2) return [];
    return premiumByYear.slice(1).map((curr, i) => {
      const prev = premiumByYear[i];
      const growth = prev.premium > 0 ? ((curr.premium - prev.premium) / prev.premium) * 100 : 0;
      return { year: curr.year, premium: curr.premium, prevPremium: prev.premium, growth };
    });
  }, [premiumByYear]);
  const avgGrowth = growthRates.length > 0 ? growthRates.reduce((s, r) => s + r.growth, 0) / growthRates.length : 0;

  const content = (
        <div className="LOSS_SELECTION_PAGE">
          {loading ? <div className="ls-loading">Loading...</div> : (
            <>
              {/* KPI Strip */}
              <div className="ls-kpis">
                <div className="ls-kpi"><div className="ls-kpi-label">Total</div><div className="ls-kpi-value">{losses.length}</div></div>
                <div className="ls-kpi ls-kpi--green"><div className="ls-kpi-label">Selected</div><div className="ls-kpi-value">{selected.length}</div></div>
                <div className="ls-kpi"><div className="ls-kpi-label">Incurred</div><div className="ls-kpi-value">{fmt(totalIncurred)}</div></div>
                <div className="ls-kpi ls-kpi--blue"><div className="ls-kpi-label">Inflation-Adj</div><div className="ls-kpi-value">{fmt(totalInflated)}</div></div>
                <div className="ls-kpi"><div className="ls-kpi-label">Avg Factor</div><div className="ls-kpi-value">{avgFactor.toFixed(3)}</div></div>
                <div className="ls-kpi"><div className="ls-kpi-label">Inception Yr</div><div className="ls-kpi-value">{inceptionYear || contractUwYear || '—'}</div></div>
                {totalLoadingPct > 0 && <div className="ls-kpi ls-kpi--amber"><div className="ls-kpi-label">Loaded Total</div><div className="ls-kpi-value">{fmt(totalLoaded)}</div></div>}
                {lossLoading.overallInflatedPct != null && (
                  <div className="ls-kpi ls-kpi--amber" title="Sum of selected (inflated) losses across matched years ÷ sum of premium for those years">
                    <div className="ls-kpi-label">Loss Loading</div>
                    <div className="ls-kpi-value">{fp(lossLoading.overallInflatedPct)}</div>
                  </div>
                )}
                {inflData.length > 0 && <div className="ls-kpi"><div className="ls-kpi-label">CPI Source</div><div className="ls-kpi-value" style={{fontSize:12}}>{countryName || '—'}</div></div>}
              </div>

              {/* Toolbar */}
              <div className="ls-toolbar">
                <div className="ls-toolbar-left">
                  <div className="ls-field" title="Losses with inflated incurred below this threshold are excluded from curve fitting.">
                    <span className="ls-flabel">Threshold</span>
                    <input className="ls-finput" type="text" value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="e.g. 500,000" style={{ width: 120 }} />
                    <button className="ls-btn" onClick={applyThreshold}>Apply</button>
                  </div>
                  <button className="ls-btn ls-btn--green" onClick={() => { setShowInflModal(true); }}>Inflation{inflData.length > 0 ? ` (${countryName || 'loaded'})` : ''}</button>
                  {lossType === 'cat' && <button className="ls-btn ls-btn--blue" onClick={() => { loadPremiumGrowth(); setShowGrowthModal(true); }}>Growth</button>}
                  <button className="ls-btn ls-btn--amber" onClick={openLoadingModal} title="Per-year losses ÷ premium = loading estimate">📈 Loss Loading</button>
                </div>
                <div className="ls-toolbar-right">
                  {saveMsg && <span className={`ls-msg ls-msg--${saveMsg.type}`}>{saveMsg.text}</span>}
                  <button className="ls-btn" onClick={selectAll}>All</button>
                  <button className="ls-btn" onClick={selectNone}>None</button>
                  <button className={`ls-btn ls-btn--save ${dirty ? 'ls-btn--dirty' : ''}`} onClick={save}>💾 Save</button>
                </div>
              </div>

              {/* Table */}
              <div className="ls-table-wrap">
                <table className="ls-table">
                  <thead><tr>
                    <th className="ls-th" style={{ width: 36 }}>✓</th>
                    <th className="ls-th">Year</th>
                    <th className="ls-th">Insured / Event</th>
                    <th className="ls-th">Loss Name</th>
                    <th className="ls-th">Date</th>
                    <th className="ls-th ls-th--r">Paid</th>
                    <th className="ls-th ls-th--r">OS</th>
                    <th className="ls-th ls-th--r">Incurred</th>
                    <th className="ls-th ls-th--c" style={{ width: 70 }}>Factor</th>
                    <th className="ls-th ls-th--r">Inflated</th>
                  </tr></thead>
                  <tbody>
                    {losses.map((l, i) => {
                      const inc = cn(l.incurred);
                      const dol = l.date_of_loss || l.dateOfLoss || '';
                      const dolDate = dol ? dol.slice(0, 10) : '—';
                      // uw_year already auto-calculated on load
                      const displayYear = l.uw_year || '—';
                      return (
                        <tr key={i} className={l.is_selected ? '' : 'ls-row--off'}>
                          <td className="ls-td ls-td--chk"><input type="checkbox" checked={l.is_selected} onChange={() => toggleSelection(i)} /></td>
                          <td className="ls-td ls-td--c ls-td--year">{displayYear}</td>
                          <td className="ls-td">{l.insured_name || '—'}</td>
                          <td className="ls-td">{l.loss_name || '—'}</td>
                          <td className="ls-td">{dolDate}</td>
                          <td className="ls-td ls-td--r">{fmt(cn(l.paid))}</td>
                          <td className="ls-td ls-td--r">{fmt(cn(l.os))}</td>
                          <td className="ls-td ls-td--r ls-td--bold">{fmt(inc)}</td>
                          <td className="ls-td ls-td--c">
                            <input className="ls-finput ls-finput--sm" type="number" step="0.001"
                              value={l.inflation_factor} onChange={e => {
                                setLosses(prev => { const n = [...prev]; n[i] = { ...n[i], inflation_factor: e.target.value }; return n; });
                                setDirty(true);
                              }} />
                          </td>
                          <td className="ls-td ls-td--r ls-td--inflated">{fmt(inc * cn(l.inflation_factor))}</td>
                        </tr>
                      );
                    })}
                    {!losses.length && <tr><td colSpan={10} className="ls-empty">No losses found. Enter data in the Loss List screen.</td></tr>}
                  </tbody>
                </table>
              </div>

              {/* Additional Loadings */}
              <div className="ls-loadings">
                <div className="ls-loadings-head">
                  <div className="ls-loadings-title">Additional Loadings</div>
                  <button className="ls-btn ls-btn--green ls-btn--sm" onClick={addLoading}>+ Add</button>
                </div>
                {loadings.length === 0 ? (
                  <div className="ls-loadings-empty">No additional loadings. Click + Add to include IBNR, trend, or other adjustments.</div>
                ) : (
                  <div className="ls-loadings-grid">
                    {loadings.map((ld, i) => (
                      <div key={i} className="ls-loading-row">
                        <input className="ls-finput" placeholder="Loading name (e.g. IBNR)" value={ld.name} onChange={e => updateLoading(i, 'name', e.target.value)} style={{ flex: 1 }} />
                        <div className="ls-field"><PctInput className="ls-finput ls-finput--sm" value={ld.pct} onChange={v => updateLoading(i, 'pct', v)} style={{ width: 70 }} /></div>
                        <button className="ls-btn ls-btn--x" onClick={() => removeLoading(i)}>✕</button>
                      </div>
                    ))}
                    <div className="ls-loading-total">Total loading: <strong>{fp(totalLoadingPct)}</strong> → Loaded total: <strong>{fmt(totalLoaded)}</strong></div>
                  </div>
                )}
              </div>

              {/* ── INFLATION MODAL ── */}
              {showInflModal && (
                <div className="ls-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowInflModal(false); }}>
                  <div className="ls-modal">
                    <div className="ls-modal-head"><div className="ls-modal-title">Inflation Adjustment{countryName ? ` — ${countryName}` : ''}</div><button className="ls-modal-x" onClick={() => setShowInflModal(false)}>✕</button></div>
                    <div className="ls-modal-body">
                      {inflData.length > 0 && (
                        <div style={{ fontSize: 11, color: '#4ade80', marginBottom: 8 }}>
                          ✓ {inflData.length} years of CPI data available for {countryName || 'this country'} ({inflData[0]?.uwYear || '?'}–{inflData[inflData.length - 1]?.uwYear || '?'})
                        </div>
                      )}
                      {/* Mode toggle */}
                      <div className="ls-mode-toggle">
                        <button className={`ls-mode-btn ${inflMode === 'table' ? 'active' : ''}`} onClick={() => setInflMode('table')}>Country Table</button>
                        <button className={`ls-mode-btn ${inflMode === 'average' ? 'active' : ''}`} onClick={() => setInflMode('average')}>Average</button>
                        <button className={`ls-mode-btn ${inflMode === 'manual' ? 'active' : ''}`} onClick={() => setInflMode('manual')}>Manual Rate</button>
                      </div>

                      {inflMode === 'table' && (
                        <div className="ls-modal-section">
                          <div className="ls-modal-sub">Year-by-year inflation from country reference table. Compounds from loss year to inception year ({inceptionYear || contractUwYear}).</div>
                          {inflData.length === 0 ? <div className="ls-modal-empty">No inflation data for this country. Use Average or Manual instead.</div> : (
                            <div className="ls-infl-table-wrap">
                              <table className="ls-infl-table">
                                <thead><tr><th>Year</th><th>Inflation %</th></tr></thead>
                                <tbody>{inflData.map((r, i) => <tr key={i}><td>{r.uwYear || r.uw_year}</td><td>{fp(cn(r.inflationPct || r.inflation_pct))}</td></tr>)}</tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )}

                      {inflMode === 'average' && (
                        <div className="ls-modal-section">
                          <div className="ls-modal-sub">Uses the average of all available inflation years ({inflData.length > 0 ? fp(inflData.reduce((s, r) => s + cn(r.inflationPct || r.inflation_pct), 0) / inflData.length) : '—'}) compounded from loss year to inception year.</div>
                          {inflData.length === 0 && <div className="ls-modal-empty">No inflation data available. Consider using Manual Rate.</div>}
                        </div>
                      )}

                      {inflMode === 'manual' && (
                        <div className="ls-modal-section">
                          <div className="ls-modal-sub">Apply a flat annual inflation rate compounded from each loss year to inception year ({inceptionYear || contractUwYear}).</div>
                          <div className="ls-field" style={{ marginTop: 12 }}>
                            <span className="ls-flabel">Annual Rate</span>
                            <PctInput className="ls-finput" value={manualInflPct} onChange={v => setManualInflPct(v)} style={{ width: 90 }} />
                          </div>
                        </div>
                      )}

                      <div className="ls-modal-actions">
                        <button className="ls-btn" onClick={() => setShowInflModal(false)}>Cancel</button>
                        <button className="ls-btn ls-btn--green" onClick={() => applyInflation(inflMode, inflMode === 'manual' ? manualInflPct : undefined)}>
                          Apply {inflMode === 'table' ? 'Country' : inflMode === 'average' ? 'Average' : 'Manual'} Inflation
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── LOSS LOADING MODAL ── */}
              {showLoadingModal && (
                <div className="ls-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowLoadingModal(false); }}>
                  <div className="ls-modal" style={{ maxWidth: 760 }}>
                    <div className="ls-modal-head">
                      <div className="ls-modal-title">
                        Loss Loading — {lossType === 'cat' ? 'Cat' : 'Large'} Losses ÷ Premium
                      </div>
                      <button className="ls-modal-x" onClick={() => setShowLoadingModal(false)}>✕</button>
                    </div>
                    <div className="ls-modal-body">
                      <div className="ls-modal-sub">
                        For each underwriting year: sum of selected {lossType === 'cat' ? 'cat' : 'large'} losses ÷ premium for that year. The "All Years" row is the sum of losses across matched years over the sum of premium — a premium-weighted loading estimate.
                      </div>

                      {premiumLoading ? (
                        <div className="ls-modal-empty">Loading premiums…</div>
                      ) : premiumByYear.length === 0 ? (
                        <div className="ls-modal-empty">No premium history found for this contract. Loss-loading needs premium per year (from the premium triangle, straight stats, or NP EGNPI).</div>
                      ) : (
                        <>
                          <div className="ls-infl-table-wrap">
                            <table className="ls-infl-table">
                              <thead>
                                <tr>
                                  <th>Year</th>
                                  <th style={{ textAlign: 'right' }}>Premium</th>
                                  <th style={{ textAlign: 'right' }}>Losses</th>
                                  <th style={{ textAlign: 'right' }}>Loading</th>
                                  <th style={{ textAlign: 'right' }}>Inflated Losses</th>
                                  <th style={{ textAlign: 'right' }}>Inflated Loading</th>
                                </tr>
                              </thead>
                              <tbody>
                                {lossLoading.rows.map(r => (
                                  <tr key={r.year}>
                                    <td>{r.year}</td>
                                    <td style={{ textAlign: 'right' }}>{fmt(r.premium)}</td>
                                    <td style={{ textAlign: 'right', color: r.count > 0 ? undefined : 'rgba(255,255,255,0.3)' }}>
                                      {r.count > 0 ? fmt(r.incurred) : '–'}
                                      {r.count > 0 && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginLeft: 4 }}>({r.count})</span>}
                                    </td>
                                    <td style={{ textAlign: 'right', fontWeight: r.pct > 0 ? 700 : 400 }}>{r.pct == null ? '—' : fp(r.pct)}</td>
                                    <td style={{ textAlign: 'right', color: r.count > 0 ? undefined : 'rgba(255,255,255,0.3)' }}>
                                      {r.count > 0 ? fmt(r.inflated) : '–'}
                                    </td>
                                    <td style={{ textAlign: 'right', fontWeight: r.inflatedPct > 0 ? 700 : 400, color: r.inflatedPct > 0 ? '#fbbf24' : undefined }}>
                                      {r.inflatedPct == null ? '—' : fp(r.inflatedPct)}
                                    </td>
                                  </tr>
                                ))}
                                <tr style={{ borderTop: '2px solid rgba(255,255,255,0.15)', fontWeight: 700 }}>
                                  <td>All Years</td>
                                  <td style={{ textAlign: 'right' }}>{fmt(lossLoading.totalPremium)}</td>
                                  <td style={{ textAlign: 'right' }}>{fmt(lossLoading.totalLosses)}</td>
                                  <td style={{ textAlign: 'right' }}>{lossLoading.overallPct == null ? '—' : fp(lossLoading.overallPct)}</td>
                                  <td style={{ textAlign: 'right' }}>{fmt(lossLoading.totalInflated)}</td>
                                  <td style={{ textAlign: 'right', color: '#fbbf24' }}>
                                    {lossLoading.overallInflatedPct == null ? '—' : fp(lossLoading.overallInflatedPct)}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>

                          <div style={{ display: 'flex', gap: 14, marginTop: 14, flexWrap: 'wrap' }}>
                            <div style={{ flex: 1, minWidth: 200, padding: '10px 14px', borderRadius: 8, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)' }}>
                              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                                Premium-weighted loading (inflated)
                              </div>
                              <div style={{ fontSize: 22, fontWeight: 800, color: '#fbbf24' }}>
                                {lossLoading.overallInflatedPct == null ? '—' : fp(lossLoading.overallInflatedPct, 2)}
                              </div>
                              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
                                {fmt(lossLoading.totalInflated)} ÷ {fmt(lossLoading.totalPremium)}
                              </div>
                            </div>
                            <div style={{ flex: 1, minWidth: 200, padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
                              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                                Simple-average yearly (inflated)
                              </div>
                              <div style={{ fontSize: 22, fontWeight: 800, color: '#fff' }}>
                                {lossLoading.simpleAvgInflatedPct == null ? '—' : fp(lossLoading.simpleAvgInflatedPct, 2)}
                              </div>
                              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
                                Average across years with losses (un-weighted)
                              </div>
                            </div>
                          </div>
                          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 10 }}>
                            Based on {selected.length} selected loss{selected.length !== 1 ? 'es' : ''} across {lossLoading.rows.filter(r => r.count > 0).length} year{lossLoading.rows.filter(r => r.count > 0).length !== 1 ? 's' : ''}, premium for {lossLoading.rows.filter(r => r.premium > 0).length} year{lossLoading.rows.filter(r => r.premium > 0).length !== 1 ? 's' : ''}.
                          </div>
                        </>
                      )}

                      <div className="ls-modal-actions">
                        <button className="ls-btn" onClick={() => setShowLoadingModal(false)}>Close</button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── GROWTH MODAL (Cat only) ── */}
              {showGrowthModal && lossType === 'cat' && (
                <div className="ls-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowGrowthModal(false); }}>
                  <div className="ls-modal">
                    <div className="ls-modal-head"><div className="ls-modal-title">Growth in Portfolio</div><button className="ls-modal-x" onClick={() => setShowGrowthModal(false)}>✕</button></div>
                    <div className="ls-modal-body">
                      <div className="ls-modal-sub">Use premium growth as a proxy for exposure growth to inflate cat losses, in place of CPI inflation.</div>

                      <div className="ls-mode-toggle">
                        <button className={`ls-mode-btn ${growthMode === 'calculated' ? 'active' : ''}`} onClick={() => setGrowthMode('calculated')}>From Premiums</button>
                        <button className={`ls-mode-btn ${growthMode === 'manual' ? 'active' : ''}`} onClick={() => setGrowthMode('manual')}>Manual Rate</button>
                      </div>

                      {growthMode === 'calculated' && (
                        <div className="ls-modal-section">
                          {premiumByYear.length < 2 ? <div className="ls-modal-empty">Need at least 2 years of premium data to calculate growth.</div> : (
                            <>
                              <div className="ls-infl-table-wrap">
                                <table className="ls-infl-table">
                                  <thead><tr><th>Year</th><th>Premium</th><th>Growth %</th></tr></thead>
                                  <tbody>
                                    {growthRates.map((r, i) => <tr key={i}><td>{r.year}</td><td>{fmt(r.premium)}</td><td className={r.growth < 0 ? 'ls-neg' : ''}>{fp(r.growth)}</td></tr>)}
                                  </tbody>
                                </table>
                              </div>
                              <div className="ls-modal-avg">Average growth: <strong>{fp(avgGrowth)}</strong></div>
                            </>
                          )}
                        </div>
                      )}

                      {growthMode === 'manual' && (
                        <div className="ls-modal-section">
                          <div className="ls-field" style={{ marginTop: 8 }}>
                            <span className="ls-flabel">Annual Growth Rate</span>
                            <PctInput className="ls-finput" value={manualGrowthPct} onChange={v => setManualGrowthPct(v)} style={{ width: 90 }} />
                          </div>
                        </div>
                      )}

                      <div className="ls-modal-actions">
                        <button className="ls-btn" onClick={() => setShowGrowthModal(false)}>Cancel</button>
                        <button className="ls-btn ls-btn--blue" onClick={() => applyInflation('growth', growthMode === 'calculated' ? String(avgGrowth) : manualGrowthPct)}>
                          Apply {growthMode === 'calculated' ? `${fp(avgGrowth)} Growth` : 'Manual Growth'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
  );

  if (embedded) return content;

  return (
    <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill} onBeforeNext={save} onBeforeBack={save}>
      {() => content}
    </WizardLayout>
  );
}
