import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { useGlobalToast } from '../../../hooks/useToast';
import { toInt, yearFromDate, parseFlexNum, numOrZero, fmtMoney, fmtPct, computeCumulative, resolveYearsFromServer, sameYears } from './formatters';

const ROUTE_KEY = 'NP_PREMIUMS_TABLE';

/* ═══════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════ */
export default function NpPremiumsTable() {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const quoteMode = !!appState.quoteMode;
  const npDetail = useMemo(() => appState.npTreatyDetail || {}, [appState.npTreatyDetail]);
  const showToast = useGlobalToast();

  const [uwRows, setUwRows] = useState([]);
  const [inflationRows, setInflationRows] = useState([]);
  const [inflationMode, setInflationMode] = useState('country');
  const [averageInflationPct, setAverageInflationPct] = useState('');
  const [loading, setLoading] = useState(false);
  // Rate changes (one per UW year). On-level adjusted premium for year y
  // = egnpi(y) × Π over i > y of (1 + r_i / 100). Modal-driven; persisted
  // alongside EGNPI rows via the existing egnpi-year endpoint.
  const [rateChangeRows, setRateChangeRows] = useState([]); // [{uwYear, rateChangePct}]
  const [showRateModal, setShowRateModal] = useState(false);

  // Country resolution is local state — not a render-time const off
  // appState.npTreatyDetail, which is not reliably hydrated on this screen in
  // NP/quote mode. Seeded from npDetail when present; the load effect overrides
  // it from the authoritative contract header. Keeping it as state means the
  // country-inflation effect re-runs once the id finally resolves.
  const npCountryId = npDetail.countryId || npDetail.country_id || null;
  const npCountryName = npDetail.country || npDetail.countryName || '';
  const [countryId, setCountryId] = useState(npCountryId ? String(npCountryId) : null);
  const [countryName, setCountryName] = useState(npCountryName || '');
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [countryOptions, setCountryOptions] = useState([]);

  // Fallback range from the loaded treaty when npDetail isn't hydrated here.
  const [serverYears, setServerYears] = useState(null);

  /* ── Build years from treaty detail (appState slice only) ── */
  const npYears = useMemo(() => {
    const start =
      toInt(npDetail.experienceStartYear) ?? toInt(npDetail.experience_start_year) ??
      toInt(npDetail.startYear) ?? toInt(npDetail.start_year) ?? toInt(npDetail.uwYear) ?? toInt(npDetail.uw_year) ?? null;
    const renewY =
      yearFromDate(npDetail.renewalDate) ?? yearFromDate(npDetail.renewal_date) ??
      toInt(npDetail.renewalYear) ?? toInt(npDetail.renewal_year) ?? null;
    if (!start) return [];
    const end = (renewY && renewY >= start) ? renewY : start;
    const yrs = [];
    for (let y = start; y <= end; y++) yrs.push(y);
    return yrs;
  }, [npDetail]);

  // Effective range: appState slice when hydrated, else the server fallback. The
  // main load effect keys off `npYears` (not this) so its own setServerYears
  // can't re-trigger it and wipe the freshly-loaded country curve on landing.
  const years = useMemo(() => (npYears.length ? npYears : (Array.isArray(serverYears) ? serverYears : [])), [npYears, serverYears]);

  const cedantName = npDetail.cedantName || npDetail.cedant_name || '';
  const treatyLabel = npDetail.treatyTypeName || npDetail.treaty_type_name || '';

  /* ── Rebuild rows when years change ── */
  const rebuildRows = useCallback((yrs, existingUw, existingInf, existingRate) => {
    const uwMap = new Map((existingUw || []).map(r => [String(r.uwYear), r]));
    const infMap = new Map((existingInf || []).map(r => [String(r.uwYear), r]));
    const rateMap = new Map((existingRate || []).map(r => [String(r.uwYear), r]));
    const newUw = yrs.map(y => {
      const cur = uwMap.get(String(y));
      return cur ? { ...cur, uwYear: y } : { uwYear: y, egnpi: '' };
    });
    const newInf = yrs.map(y => {
      const cur = infMap.get(String(y));
      return cur ? { ...cur, uwYear: y } : { uwYear: y, inflationPct: '', cumulativeFactor: 1.0 };
    });
    const newRate = yrs.map(y => {
      const cur = rateMap.get(String(y));
      return cur ? { ...cur, uwYear: y } : { uwYear: y, rateChangePct: '' };
    });
    return { uwRows: newUw, inflationRows: computeCumulative(newInf), rateChangeRows: newRate };
  }, []);

  /* ── Apply average inflation to all rows ── */
  const applyAverageInflation = useCallback((rows, avgPct) => {
    const safeRows = Array.isArray(rows) ? rows : [];
    // A blank average is applied as 0% (no inflation) rather than left blank —
    // blank would flow into computeCumulative as a non-number and surface NaN
    // in the cumulative column. parseFlexNum('') === null → 0.
    const parsed = parseFlexNum(avgPct);
    const formatted = fmtPct(parsed === null ? 0 : parsed);
    return computeCumulative(safeRows.map(r => ({ ...r, inflationPct: formatted })));
  }, []);

  /* ── Mean of the per-year inflation currently in the rows ──
     "Use average inflation" means a single rate — the average of the loaded
     country inflation — applied flat to every UW year (matches the loss-
     selection screen's `average` mode). This seeds that figure from whatever
     country curve is currently displayed. */
  const meanInflationPct = useCallback((rows) => {
    const vals = (Array.isArray(rows) ? rows : [])
      .map(r => parseFlexNum(r.inflationPct))
      .filter(n => n !== null);
    if (!vals.length) return 0;
    return vals.reduce((s, n) => s + n, 0) / vals.length;
  }, []);

  /* ── Load country inflation from API ── */
  const loadCountryInflation = useCallback(async (yrs, onlyIfEmpty, currentRows) => {
    const rows = Array.isArray(currentRows) ? currentRows : [];
    if (!countryId || !yrs.length) return rows;
    const hasAny = rows.some(r => String(r.inflationPct || '').trim() !== '');
    if (onlyIfEmpty && hasAny) return rows;
    try {
      const data = await api.getRefInflation(countryId, yrs[0], yrs[yrs.length - 1]);
      if (!Array.isArray(data) || !data.length) return rows;
      const byYear = new Map(data.map(r => [String(r.uwYear ?? r.uw_year ?? r.year), r]));
      const updated = rows.map(r => {
        const hit = byYear.get(String(r.uwYear));
        if (!hit) return r;
        const v = hit.inflationPct ?? hit.inflation_pct ?? hit.inflation_rate ?? null;
        const n = parseFlexNum(v);
        return { ...r, inflationPct: n === null ? '' : fmtPct(n) };
      });
      return computeCumulative(updated);
    } catch { return rows; }
  }, [countryId]);

  /* ── Load from server ── */
  useEffect(() => {
    // Fetch whenever a contract is present, even if `years` is still empty.
    if (!contractId) {
      const { uwRows: uw, inflationRows: inf, rateChangeRows: rate } = rebuildRows(npYears, [], [], []);
      setUwRows(uw); setInflationRows(inf); setRateChangeRows(rate);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const [egnpiData, npData, contractData] = await Promise.all([
          api.getNpEgnpiYear(contractId, quoteMode ? { quote: true } : undefined).catch(() => null),
          api.getNonPropTreaty(contractId, quoteMode ? { quote: true } : undefined).catch(() => null),
          api.getContract(contractId, quoteMode ? { quote: true } : undefined).catch(() => null),
        ]);

        // ── Resolve country from the loaded treaty ──
        // The contract header is the authoritative source for country (the
        // non-prop detail row carries no country column). Fall back to anything
        // the non-prop payload happens to expose, then to npDetail. Writing it
        // to state lets the country-inflation effect re-run once it resolves.
        const header = contractData?.header || {};
        const resolvedCountryId =
          header.country_id ?? header.countryId ?? npData?.contract_header?.country_id ??
          npData?.detail?.country_id ?? npData?.country_id ?? npData?.terms?.treaty_detail?.countryId ??
          npCountryId ?? null;
        const resolvedCountryName =
          header.country_name ?? header.countryName ?? npData?.contract_header?.country_name ??
          npData?.detail?.country_name ?? npData?.country ?? npData?.country_name ??
          npData?.terms?.treaty_detail?.country ?? npData?.terms?.treaty_detail?.countryName ??
          npCountryName ?? '';
        if (resolvedCountryId != null && String(resolvedCountryId) !== '') setCountryId(String(resolvedCountryId));
        if (resolvedCountryName) setCountryName(resolvedCountryName);

        const premData = npData?.terms?.premiums_table || npData?.premiumsTable || {};
        const savedMode = premData.inflationMode || premData.inflation_mode || 'country';
        const savedAvg = String(premData.averageInflationPct ?? premData.average_inflation_pct ?? '');
        setInflationMode(savedMode);
        setAverageInflationPct(savedAvg);

        // EGNPI rows: prefer relational table
        let savedUw = [];
        let savedRate = [];
        const egnpiRows = Array.isArray(egnpiData) ? egnpiData : (egnpiData?.rows || egnpiData?.years || []);
        if (egnpiRows.length) {
          savedUw = egnpiRows.map(r => ({
            uwYear: toInt(r.uwYear ?? r.uw_year) ?? null,
            egnpi: (() => { const raw = r.egnpi ?? ''; if (!String(raw).trim()) return ''; return fmtMoney(numOrZero(raw)); })(),
            inflationPct: r.inflation_pct != null ? String(r.inflation_pct) : '',
          })).filter(r => r.uwYear);
          savedRate = egnpiRows.map(r => ({
            uwYear: toInt(r.uwYear ?? r.uw_year),
            rateChangePct: (() => {
              const raw = r.rate_change_pct ?? r.rateChangePct;
              if (raw == null || String(raw).trim() === '') return '';
              return fmtPct(numOrZero(raw));
            })(),
          })).filter(r => r.uwYear);
        } else if (Array.isArray(premData.uwRows)) {
          savedUw = premData.uwRows.map(r => ({
            uwYear: toInt(r.uwYear ?? r.uw_year),
            egnpi: (() => { const raw = r.egnpi ?? ''; if (!String(raw).trim()) return ''; return fmtMoney(numOrZero(raw)); })(),
          })).filter(r => r.uwYear);
        }

        let savedInf = [];
        if (Array.isArray(premData.inflationRows)) {
          savedInf = premData.inflationRows.map(r => ({
            uwYear: toInt(r.uwYear ?? r.uw_year),
            inflationPct: (() => { const raw = r.inflationPct ?? r.inflation_pct ?? ''; if (!String(raw).trim()) return ''; return fmtPct(numOrZero(raw)); })(),
            cumulativeFactor: numOrZero(r.cumulativeFactor ?? r.cumulative_factor ?? 1) || 1,
          })).filter(r => r.uwYear);
        }
        // Fall back to the relational inflation_pct when JSONB has no
        // inflationRows (e.g. data migrated from before the JSONB key
        // existed, or an older save). This keeps the inflation column
        // visible even if the JSONB copy is missing.
        if (!savedInf.length && egnpiRows.length) {
          savedInf = egnpiRows
            .filter(r => r.inflation_pct != null && String(r.inflation_pct).trim() !== '')
            .map(r => ({
              uwYear: toInt(r.uwYear ?? r.uw_year),
              inflationPct: fmtPct(numOrZero(r.inflation_pct)),
              cumulativeFactor: 1,
            }))
            .filter(r => r.uwYear);
        }

        // When npDetail gave no range, resolve it from the loaded treaty.
        const effYears = npYears.length ? npYears : resolveYearsFromServer(header, npData, egnpiRows);
        if (!npYears.length && effYears.length) setServerYears(prev => (sameYears(prev, effYears) ? prev : effYears));

        const { uwRows: uw, inflationRows: inf, rateChangeRows: rate } = rebuildRows(effYears, savedUw, savedInf, savedRate);
        setUwRows(uw);
        setRateChangeRows(rate);

        // Country values are filled by the dedicated country-inflation effect
        // once the resolved countryId lands in state (its closure would be
        // stale here). Average mode is applied immediately so the cumulative
        // column is correct on first paint — falling back to the mean of the
        // saved curve if no explicit average was persisted.
        if (savedMode === 'average') {
          const effectiveAvg = parseFlexNum(savedAvg) !== null ? savedAvg : fmtPct(meanInflationPct(inf));
          if (parseFlexNum(savedAvg) === null) setAverageInflationPct(effectiveAvg);
          setInflationRows(applyAverageInflation(inf, effectiveAvg));
        } else {
          setInflationRows(inf);
        }
      } catch {
        const { uwRows: uw, inflationRows: inf, rateChangeRows: rate } = rebuildRows(npYears, [], [], []);
        setUwRows(uw);
        setRateChangeRows(rate);
        setInflationRows(inf);
      } finally { setLoading(false); }
    })();
    // inflationMode is intentionally NOT a dependency: mode toggles are owned by
    // handleModeChange (average) and the country-inflation effect (country) —
    // neither refetches; re-running this effect on every toggle used to reset the
    // mode to the server's saved value. loadCountryInflation is excluded — the
    // dedicated country effect owns country fetching.
  }, [applyAverageInflation, contractId, meanInflationPct, npCountryId, npCountryName, npYears, quoteMode, rebuildRows]);

  /* ── Live ref of inflationRows so the country-inflation effect can read the
        latest rows without taking them as a dependency (which would re-fire it). ── */
  const inflationRowsRef = useRef(inflationRows);
  useEffect(() => { inflationRowsRef.current = inflationRows; }, [inflationRows]);

  /* ── Previous inflation mode: lets the country-inflation effect tell an average
        → country toggle (force-reload) from the id / years merely resolving. ── */
  const prevInflationModeRef = useRef(inflationMode);

  /* ── Set by the country picker so the country-inflation effect can tell a
        user-driven country change from the header merely resolving on load.
        A user pick forces a fresh fetch in BOTH modes and, in average mode,
        re-seeds the flat average from the new country's curve. Header
        resolution must NOT do this — it would clobber a saved average. ── */
  const countryPickedRef = useRef(false);

  /* ── SINGLE owner of country loading. In COUNTRY mode it fills the per-year
        curve when the country resolves / years change, when the mode flips back
        from average, or when the user picks a country (handleModeChange no longer
        reloads — two owners used to race and could leave flat average values in
        the column). In AVERAGE mode it stays idle EXCEPT when the user picks a
        new country, where it refetches that country's curve and re-seeds the flat
        average from its mean — the "reload on new country" the user expects
        instead of having to leave and re-enter the screen.
        Force-reloads (onlyIfEmpty=false) only when coming straight from average
        or on a user pick (the displayed curve is for the OLD country); otherwise
        onlyIfEmpty=true so saved / hand-typed values survive initial mount, a
        late header resolve, or a years change. ── */
  useEffect(() => {
    if (!countryId || !years.length) {
      // Track the mode even while bailing so a later average → country toggle
      // (and the next country pick) is still detected.
      prevInflationModeRef.current = inflationMode;
      return;
    }
    const cameFromAverage = prevInflationModeRef.current === 'average';
    prevInflationModeRef.current = inflationMode;
    const userPicked = countryPickedRef.current;
    countryPickedRef.current = false;

    // Average mode is otherwise owned by the main load (initial seed) and
    // handleModeChange (toggle); only a user pick reloads it here.
    if (inflationMode === 'average' && !userPicked) return;

    let cancelled = false;
    (async () => {
      const base = Array.isArray(inflationRowsRef.current) ? inflationRowsRef.current : [];
      if (inflationMode === 'average') {
        // Re-seed the flat average from the freshly-fetched new-country curve.
        const curve = await loadCountryInflation(years, false, base);
        if (cancelled) return;
        const avg = fmtPct(meanInflationPct(curve));
        setAverageInflationPct(avg);
        setInflationRows(applyAverageInflation(curve, avg));
        return;
      }
      const updated = await loadCountryInflation(years, !(cameFromAverage || userPicked), base);
      if (!cancelled) setInflationRows(updated);
    })();
    return () => { cancelled = true; };
  }, [countryId, inflationMode, years, loadCountryInflation, meanInflationPct, applyAverageInflation]);

  /* ── UW row updates ── */
  const updateUwRow = useCallback((idx, value) => {
    setUwRows(prev => {
      const next = [...prev]; next[idx] = { ...next[idx], egnpi: value }; return next;
    });
  }, []);

  const handleUwBlur = useCallback((idx) => {
    setUwRows(prev => {
      const next = [...prev];
      const n = parseFlexNum(next[idx].egnpi);
      next[idx] = { ...next[idx], egnpi: n === null ? '' : fmtMoney(n) };
      return next;
    });
  }, []);

  /* ── Inflation row updates ── */
  const updateInflationRow = useCallback((idx, value) => {
    setInflationRows(prev => {
      const next = [...prev]; next[idx] = { ...next[idx], inflationPct: value };
      return computeCumulative(next);
    });
  }, []);

  const handleInflBlur = useCallback((idx) => {
    setInflationRows(prev => {
      const next = [...prev];
      const n = parseFlexNum(next[idx].inflationPct);
      next[idx] = { ...next[idx], inflationPct: n === null ? '' : fmtPct(n) };
      return computeCumulative(next);
    });
  }, []);

  /* ── Inflation mode change. Average: seed + apply the flat average here.
     Country: only flip the mode — the country-inflation effect owns the reload
     (it force-reloads because it sees the average → country toggle); reloading
     here too would race it and could leave average values in the column. ── */
  const handleModeChange = useCallback((newMode) => {
    setInflationMode(newMode);
    if (newMode === 'average') {
      const base = Array.isArray(inflationRows) ? inflationRows : [];
      // Default the flat average to the mean of the loaded country inflation so
      // the column shows a meaningful figure instead of 0%/blank. A value the
      // user already typed is respected.
      let avg = averageInflationPct;
      if (parseFlexNum(avg) === null) {
        avg = fmtPct(meanInflationPct(base));
        setAverageInflationPct(avg);
      }
      setInflationRows(applyAverageInflation(base, avg));
    }
  }, [averageInflationPct, inflationRows, applyAverageInflation, meanInflationPct]);

  const handleApplyAverage = useCallback(() => {
    setInflationRows(prev => applyAverageInflation(prev, averageInflationPct));
  }, [averageInflationPct, applyAverageInflation]);

  /* ── Country picker — fallback so the country path is never stuck when it
        can't be derived from the loaded treaty. Lazily loads the country list
        on first open. Picking a country sets local countryId/countryName, which
        re-runs the country-inflation effect. ── */
  const openCountryPicker = useCallback(async () => {
    setCountryPickerOpen(open => !open);
    if (countryOptions.length) return;
    try {
      const list = await api.getRefListItems('country');
      setCountryOptions(Array.isArray(list) ? list : []);
    } catch { setCountryOptions([]); }
  }, [countryOptions.length]);

  const pickCountry = useCallback((id) => {
    const next = id ? String(id) : null;
    const opt = (Array.isArray(countryOptions) ? countryOptions : []).find(c => String(c.id) === String(id));
    // Flag only a real change as user-driven so the country-inflation effect
    // force-reloads (and, in average mode, re-seeds the flat average from the new
    // country). Re-picking the same country is a no-op and must not leave a stale
    // flag that re-seeds on a later, unrelated effect run.
    if (next !== countryId) countryPickedRef.current = true;
    setCountryId(next);
    setCountryName(opt?.name || '');
    setCountryPickerOpen(false);
  }, [countryOptions, countryId]);

  /* ── Δ vs prev calculation ── */
  const uwNums = useMemo(() => (Array.isArray(uwRows) ? uwRows : []).map(r => parseFlexNum(r.egnpi)), [uwRows]);

  /* ── Paste handler for EGNPI ── */
  const handleUwPaste = useCallback((startIdx, e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text.includes('\n') && !text.includes('\t')) return;
    e.preventDefault();
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
    setUwRows(prev => {
      const next = [...prev];
      lines.forEach((line, r) => {
        const target = startIdx + r;
        if (!next[target]) return;
        const cell = line.split('\t')[0] || '';
        const n = parseFlexNum(cell);
        next[target] = { ...next[target], egnpi: n === null ? '' : fmtMoney(n) };
      });
      return next;
    });
  }, []);

  /* ── Paste handler for Inflation ── */
  const handleInflPaste = useCallback((startIdx, e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text.includes('\n') && !text.includes('\t')) return;
    e.preventDefault();
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
    setInflationRows(prev => {
      const next = [...prev];
      lines.forEach((line, r) => {
        const target = startIdx + r;
        if (!next[target]) return;
        const cell = line.split('\t')[0] || '';
        const n = parseFlexNum(cell);
        next[target] = { ...next[target], inflationPct: n === null ? '' : fmtPct(n) };
      });
      return computeCumulative(next);
    });
  }, []);

  /* ── Save ── */
  const save = useCallback(async () => {
    if (!contractId) return true;
    // User edits to the inflation column live in `inflationRows`, while
    // `uwRows.inflationPct` is only seeded from the relational column on
    // load and never updated by edits. Source the per-year inflation from
    // `inflationRows` so the relational `contract_np_egnpi_year.inflation_pct`
    // tracks user edits in lockstep with the JSONB backup below.
    const inflMap = new Map(
      (Array.isArray(inflationRows) ? inflationRows : [])
        .map(r => [String(r.uwYear), r.inflationPct]),
    );
    const rateMap = new Map(
      (Array.isArray(rateChangeRows) ? rateChangeRows : [])
        .map(r => [String(r.uwYear), r.rateChangePct]),
    );
    const egnpiPayload = uwRows.map(r => ({
      uw_year: r.uwYear,
      egnpi: parseFlexNum(r.egnpi),
      inflation_pct: parseFlexNum(inflMap.get(String(r.uwYear)) ?? r.inflationPct),
      rate_change_pct: parseFlexNum(rateMap.get(String(r.uwYear)) ?? ''),
    }));
    const payload = {
      terms: {
        premiums_table: {
          inflationMode,
          averageInflationPct: averageInflationPct ?? '',
          uwRows: egnpiPayload,
          inflationRows: (Array.isArray(inflationRows) ? inflationRows : []).map(r => ({
            uwYear: r.uwYear, inflationPct: parseFlexNum(r.inflationPct), cumulativeFactor: Number(r.cumulativeFactor) || 1,
          })),
        },
      },
    };
    try {
      // Relational write first: it's the source of truth for downstream
      // screens (loss tabs, NpStopLossPricing burning cost). If it fails
      // we bail before the JSONB write so the two stores can't drift —
      // an empty catch here used to swallow the relational failure and
      // let the JSONB save report success even though the relational
      // table was stale.
      await api.saveNpEgnpiYear(contractId, { rows: egnpiPayload }, quoteMode ? { quote: true } : undefined);
      await api.saveNonPropTreaty(contractId, payload, quoteMode ? { quote: true } : undefined);
      return true;
    } catch (e) {
      console.error('[NpPremiumsTable] save failed:', e);
      showToast('Premiums save failed: ' + (e?.message || 'Server error'));
      return false;
    }
  }, [contractId, uwRows, inflationRows, rateChangeRows, inflationMode, averageInflationPct, quoteMode, showToast]);

  const startYear = years[0] ?? '';
  const endYear = years[years.length - 1] ?? '';

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Premiums Table" headerPill={`${quoteMode ? "NP-QUOTE TREATY" : "NON-PROPORTIONAL TREATY"}: PREMIUMS & INFLATION`} onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className="NP_PREMIUMS_TABLE np-premiums-step">
          {loading ? <div className="df-card df-card--notice"><div className="df-note">Loading...</div></div> : (
            <>
              <div className="np-hero">
                <div className="np-hero-title">Premiums &amp; Inflation Cockpit</div>
                <div className="np-hero-subtitle">
                  Underwriting years <b>{startYear}</b> to <b>{endYear}</b>
                  {cedantName && <> · {cedantName}</>}
                  {treatyLabel && <> · {treatyLabel}</>}
                </div>
              </div>

              <div className="np-prem-grid">
                {/* ═══ LEFT: EGNPI BY UW YEAR ═══ */}
                <section className="np-struct-card glass np-prem-card">
                  <div className="np-struct-card-header">
                    <div className="np-struct-card-title">UNDERWRITING YEARS · PREMIUM</div>
                    <div className="np-struct-card-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button
                        type="button"
                        className="dock-btn dock-btn--ghost"
                        onClick={() => setShowRateModal(true)}
                        title="Capture rate changes year-over-year and view on-level adjusted premium"
                        style={{ fontSize: 11, fontWeight: 700, padding: '5px 12px', letterSpacing: '.05em' }}
                      >
                        ⚙ Rate Changes
                      </button>
                      <span className="np-tag">Portfolio movement</span>
                    </div>
                  </div>
                  <div className="np-table-wrap np-table-wrap--scroll">
                    <table className="np-prem-table">
                      <thead><tr><th className="np-table-sticky">UW</th><th>Premium</th><th className="cell-right">Δ vs prev</th></tr></thead>
                      <tbody>
                        {!Array.isArray(uwRows) || uwRows.length === 0 ? (
                          <tr><td colSpan={3} className="np-muted">Set Start Year / Renewal Date on Treaty Detail.</td></tr>
                        ) : uwRows.map((r, i) => {
                          const cur = uwNums[i]; const prev = i > 0 ? uwNums[i - 1] : null;
                          const chg = (prev !== null && prev !== 0 && cur !== null) ? ((cur - prev) / prev) * 100 : null;
                          const chgTxt = chg === null ? '—' : `${fmtPct(chg)}%`;
                          const chgCls = chg === null ? 'np-muted' : chg >= 0 ? 'np-pos' : 'np-neg';
                          return (
                            <tr key={r.uwYear}>
                              <td className="np-cell-year">{r.uwYear}</td>
                              <td>
                                <input className="np-inp np-inp-money" inputMode="decimal" placeholder="0"
                                  value={r.egnpi} onChange={e => updateUwRow(i, e.target.value)}
                                  onBlur={() => handleUwBlur(i)} onPaste={e => handleUwPaste(i, e)} />
                              </td>
                              <td className={`np-cell-right ${chgCls}`}>{chgTxt}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="np-prem-foot"><div className="np-muted">Tip: paste values directly from Excel. We auto-calc change vs previous year.</div></div>
                </section>

                {/* ═══ RIGHT: INFLATION ═══ */}
                <section className="np-struct-card glass np-prem-card">
                  <div className="np-struct-card-header">
                    <div className="np-struct-card-title">INFLATION ASSUMPTIONS</div>
                  </div>

                  {/* Inflation controls */}
                  <div className="np-inf-controls" style={{ padding: '8px 12px' }}>
                    <div className="np-inf-line" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span className="np-muted">Country:</span>
                      <b style={{ marginLeft: 6 }}>{countryName || '—'}</b>
                      <button
                        type="button"
                        className="dock-btn dock-btn--ghost"
                        onClick={openCountryPicker}
                        title="Pick or confirm the country used for inflation lookup"
                        style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: '3px 9px', letterSpacing: '.05em' }}
                      >
                        COUNTRY
                      </button>
                      {countryPickerOpen && (
                        <select
                          className="fi"
                          aria-label="Select country for inflation"
                          value={countryId || ''}
                          onChange={e => pickCountry(e.target.value)}
                          style={{ marginLeft: 4, maxWidth: 220 }}
                        >
                          <option value="">Select country…</option>
                          {(Array.isArray(countryOptions) ? countryOptions : []).map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      )}
                      <span className="np-tag" style={{ marginLeft: 10 }}>{inflationMode === 'country' ? 'Country' : 'Average'}</span>
                    </div>
                    <div style={{ marginTop: 8, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                      <label className="np-muted" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <input type="radio" name="npInfMode" value="country" checked={inflationMode === 'country'}
                          onChange={() => handleModeChange('country')} /> Use country inflation
                      </label>
                      <label className="np-muted" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <input type="radio" name="npInfMode" value="average" checked={inflationMode === 'average'}
                          onChange={() => handleModeChange('average')} /> Use average inflation
                      </label>
                    </div>
                    {inflationMode === 'average' && (
                      <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="np-muted">Average inflation %</span>
                        <PctInput className="np-inp np-inp-pct" value={averageInflationPct}
                          placeholder="0.00%" style={{ maxWidth: 120 }}
                          aria-label="Average inflation percent"
                          onChange={v => setAverageInflationPct(v)}
                          onBlur={() => {
                            const n = parseFlexNum(averageInflationPct);
                            setAverageInflationPct(n === null ? '' : fmtPct(n));
                          }} />
                        <button className="dock-btn dock-btn--ghost" type="button" onClick={handleApplyAverage}>Apply</button>
                      </div>
                    )}
                  </div>

                  <div className="np-table-wrap np-table-wrap--scroll">
                    <table className="np-prem-table">
                      <thead><tr><th className="np-table-sticky">Inflation UW</th><th>Inflation %</th><th className="cell-right">Cumulative</th></tr></thead>
                      <tbody>
                        {!Array.isArray(inflationRows) || inflationRows.length === 0 ? (
                          <tr><td colSpan={3} className="np-muted">Waiting for years.</td></tr>
                        ) : inflationRows.map((r, i) => (
                          <tr key={r.uwYear}>
                            <td className="np-cell-year">{r.uwYear}</td>
                            <td>
                              <PctInput className="np-inp np-inp-pct" placeholder="0.00%"
                                value={r.inflationPct} onChange={v => updateInflationRow(i, v)}
                                onBlur={() => handleInflBlur(i)} onPaste={e => handleInflPaste(i, e)}
                                disabled={inflationMode === 'average'} />
                            </td>
                            <td className="np-cell-right">{fmtPct(r.cumulativeFactor || 1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="np-prem-foot"><div className="np-muted">Cumulative factor applies sequentially year-on-year (base = 1.00).</div></div>
                </section>
              </div>
              {showRateModal && (
                <RateChangesModal
                  years={years}
                  uwRows={uwRows}
                  rateChangeRows={rateChangeRows}
                  onChange={setRateChangeRows}
                  onClose={() => setShowRateModal(false)}
                />
              )}
            </>
          )}
        </div>
      )}
    </WizardLayout>
  );
}

/**
 * Modal for capturing per-UW-year rate changes and showing the
 * resulting on-level adjusted EGNPI.
 *
 * On-level factor for year y = Π over i > y of (1 + r_i / 100).
 * The most recent year's factor is 1.0 (no adjustment); earlier years
 * scale up by the cumulative rate movement since then.
 */
function RateChangesModal({ years, uwRows, rateChangeRows, onChange, onClose }) {
  const egnpiByYear = useMemo(
    () => new Map(uwRows.map(r => [String(r.uwYear), parseFlexNum(r.egnpi)])),
    [uwRows],
  );
  const rateByYear = useMemo(
    () => new Map((rateChangeRows || []).map(r => [String(r.uwYear), parseFlexNum(r.rateChangePct)])),
    [rateChangeRows],
  );
  // Walk year-list from latest backward so the factor compounds the
  // rate changes that have happened SINCE year y. Most recent year's
  // factor = 1.0.
  const rows = useMemo(() => {
    const sortedYears = [...years].sort((a, b) => a - b);
    const result = [];
    let factor = 1.0;
    for (let i = sortedYears.length - 1; i >= 0; i--) {
      const y = sortedYears[i];
      const r = rateByYear.get(String(y));
      const onLevel = factor;
      const egnpi = egnpiByYear.get(String(y));
      const adjusted = Number.isFinite(egnpi) ? egnpi * onLevel : null;
      result.unshift({
        uwYear: y,
        egnpi,
        rateChangePct: rateChangeRows.find(rc => rc.uwYear === y)?.rateChangePct ?? '',
        onLevelFactor: onLevel,
        adjustedEgnpi: adjusted,
      });
      // Apply year y's rate change to compound the factor for the year before y.
      if (Number.isFinite(r)) factor *= 1 + r / 100;
    }
    return result;
  }, [years, egnpiByYear, rateByYear, rateChangeRows]);

  const updateRate = useCallback((year, value) => {
    onChange(prev => {
      const map = new Map((prev || []).map(r => [String(r.uwYear), { ...r }]));
      const next = years.map(y => {
        const cur = map.get(String(y)) || { uwYear: y, rateChangePct: '' };
        if (y === year) return { uwYear: y, rateChangePct: value };
        return { ...cur, uwYear: y };
      });
      return next;
    });
  }, [onChange, years]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="glass"
        role="dialog"
        aria-modal="true"
        style={{ background: '#0a1020', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 18, width: 820, maxWidth: '95vw', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ padding: '18px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'rgba(226,232,240,0.92)' }}>Rate Changes</div>
            <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
              Compound on-level adjustment. Latest year's factor = 1.00.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ appearance: 'none', border: 'none', background: 'transparent', color: 'rgba(148,163,184,0.60)', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
          <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720, tableLayout: 'fixed', fontVariantNumeric: 'tabular-nums' }}>
              <colgroup>
                <col style={{ width: '12%' }} />
                <col style={{ width: '24%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '26%' }} />
              </colgroup>
              <thead>
                <tr style={{ background: '#050810' }}>
                  <th style={{ padding: '10px 8px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.10)' }}>UW Year</th>
                  <th style={{ padding: '10px 8px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.10)', textAlign: 'right' }}>Premium</th>
                  <th style={{ padding: '10px 8px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: '#00d4ff', borderBottom: '1px solid rgba(255,255,255,0.10)' }}>Rate Change %</th>
                  <th style={{ padding: '10px 8px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.10)', textAlign: 'right' }}>On-Level Factor</th>
                  <th style={{ padding: '10px 8px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: '#4ade80', borderBottom: '1px solid rgba(255,255,255,0.10)', textAlign: 'right' }}>Adjusted Premium</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: 18, textAlign: 'center', color: 'rgba(148,163,184,0.55)' }}>Set Start Year / Renewal Date on Treaty Detail.</td></tr>
                ) : rows.map((r, i) => (
                  <tr key={r.uwYear} style={{ background: i % 2 === 0 ? '#080f23' : '#0a1125' }}>
                    <td style={{ padding: '8px 8px', fontWeight: 700, color: 'rgba(0,212,255,0.70)', fontSize: 12 }}>{r.uwYear}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: 'rgba(226,232,240,0.80)' }}>
                      {Number.isFinite(r.egnpi) ? fmtMoney(r.egnpi) : <span style={{ color: 'rgba(148,163,184,0.40)' }}>—</span>}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <PctInput
                        className="np-inp np-inp-pct"
                        placeholder="0.00%"
                        value={r.rateChangePct}
                        onChange={(v) => updateRate(r.uwYear, v)}
                        onBlur={() => {
                          const n = parseFlexNum(r.rateChangePct);
                          updateRate(r.uwYear, n === null ? '' : fmtPct(n));
                        }}
                      />
                    </td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: 'rgba(226,232,240,0.70)' }}>
                      {r.onLevelFactor.toFixed(4)}
                    </td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: '#4ade80', fontWeight: 700 }}>
                      {Number.isFinite(r.adjustedEgnpi) ? fmtMoney(r.adjustedEgnpi) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: 'rgba(148,163,184,0.55)', lineHeight: 1.5 }}>
            Rate change <em>r</em> for year <em>y</em> means premium that year sits <em>r</em>% above the prior year's rate level.
            The on-level factor compounds every change <em>since</em> year <em>y</em>, bringing the historical premium to today's level.
          </div>
        </div>
      </div>
    </div>
  );
}
