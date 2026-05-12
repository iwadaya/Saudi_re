import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { useGlobalToast } from '../../../hooks/useToast';

const ROUTE_KEY = 'NP_PREMIUMS_TABLE';

/* ─── helpers (matching prototype) ─── */
function toInt(v) { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; }
function yearFromDate(v) { if (!v) return null; const m = String(v).match(/(\d{4})/); return m ? parseInt(m[1], 10) : null; }

function parseFlexNum(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  s = s.replace(/[\u2212]/g, '-');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[%$£€¥]|\b(SAR|USD|EUR|GBP|AED|ZAR)\b/gi, '').replace(/[\s\u00A0]/g, '');
  const lastDot = s.lastIndexOf('.'); const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) { s = s.replace(/\./g, '').replace(/,/g, '.'); }
    else { s = s.replace(/,/g, ''); }
  } else if (lastComma !== -1) {
    const tail = s.split(',').pop();
    if (tail.length <= 2) { s = s.replace(/,/g, '.'); } else { s = s.replace(/,/g, ''); }
  } else {
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  }
  s = s.replace(/[^0-9.-]/g, '');
  if (!s || s === '-' || s === '.' || s === '-.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

function numOrZero(v) { return parseFlexNum(v) ?? 0; }
function fmtMoney(n) { const x = Number(n); if (!Number.isFinite(x)) return ''; return x.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtPct(n) { const x = Number(n); if (!Number.isFinite(x)) return ''; return x.toLocaleString('en-US', { maximumFractionDigits: 2 }); }

function computeCumulative(rows) {
  let f = 1.0;
  return rows.map((r, idx) => {
    const pct = numOrZero(r.inflationPct);
    if (idx > 0) f *= (1 + pct / 100);
    return { ...r, cumulativeFactor: f };
  });
}

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

  /* ── Build years from treaty detail ── */
  const years = useMemo(() => {
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

  const cedantName = npDetail.cedantName || npDetail.cedant_name || '';
  const treatyLabel = npDetail.treatyTypeName || npDetail.treaty_type_name || '';
  const countryName = npDetail.country || npDetail.countryName || '';
  const countryId = npDetail.countryId || npDetail.country_id || null;

  /* ── Rebuild rows when years change ── */
  const rebuildRows = useCallback((yrs, existingUw, existingInf) => {
    const uwMap = new Map((existingUw || []).map(r => [String(r.uwYear), r]));
    const infMap = new Map((existingInf || []).map(r => [String(r.uwYear), r]));
    const newUw = yrs.map(y => {
      const cur = uwMap.get(String(y));
      return cur ? { ...cur, uwYear: y } : { uwYear: y, egnpi: '' };
    });
    const newInf = yrs.map(y => {
      const cur = infMap.get(String(y));
      return cur ? { ...cur, uwYear: y } : { uwYear: y, inflationPct: '', cumulativeFactor: 1.0 };
    });
    return { uwRows: newUw, inflationRows: computeCumulative(newInf) };
  }, []);

  /* ── Apply average inflation to all rows ── */
  const applyAverageInflation = useCallback((rows, avgPct) => {
    const n = parseFlexNum(avgPct);
    const formatted = n === null ? '' : fmtPct(n);
    return computeCumulative(rows.map(r => ({ ...r, inflationPct: formatted })));
  }, []);

  /* ── Load country inflation from API ── */
  const loadCountryInflation = useCallback(async (yrs, onlyIfEmpty, currentRows) => {
    if (!countryId || !yrs.length) return currentRows;
    const hasAny = currentRows.some(r => String(r.inflationPct || '').trim() !== '');
    if (onlyIfEmpty && hasAny) return currentRows;
    try {
      const data = await api.getRefInflation(countryId, yrs[0], yrs[yrs.length - 1]);
      if (!Array.isArray(data) || !data.length) return currentRows;
      const byYear = new Map(data.map(r => [String(r.uwYear ?? r.uw_year ?? r.year), r]));
      const updated = currentRows.map(r => {
        const hit = byYear.get(String(r.uwYear));
        if (!hit) return r;
        const v = hit.inflationPct ?? hit.inflation_pct ?? hit.inflation_rate ?? null;
        const n = parseFlexNum(v);
        return { ...r, inflationPct: n === null ? '' : fmtPct(n) };
      });
      return computeCumulative(updated);
    } catch { return currentRows; }
  }, [countryId]);

  /* ── Load from server ── */
  useEffect(() => {
    if (!contractId || !years.length) {
      const { uwRows: uw, inflationRows: inf } = rebuildRows(years, [], []);
      setUwRows(uw); setInflationRows(inf);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const [egnpiData, npData] = await Promise.all([
          api.getNpEgnpiYear(contractId, quoteMode ? { quote: true } : undefined).catch(() => null),
          api.getNonPropTreaty(contractId, quoteMode ? { quote: true } : undefined).catch(() => null),
        ]);

        const premData = npData?.terms?.premiums_table || npData?.premiumsTable || {};
        const savedMode = premData.inflationMode || premData.inflation_mode || 'country';
        const savedAvg = String(premData.averageInflationPct ?? premData.average_inflation_pct ?? '');
        setInflationMode(savedMode);
        setAverageInflationPct(savedAvg);

        // EGNPI rows: prefer relational table
        let savedUw = [];
        const egnpiRows = Array.isArray(egnpiData) ? egnpiData : (egnpiData?.rows || egnpiData?.years || []);
        if (egnpiRows.length) {
          savedUw = egnpiRows.map(r => ({
            uwYear: toInt(r.uwYear ?? r.uw_year) ?? null,
            egnpi: (() => { const raw = r.egnpi ?? ''; if (!String(raw).trim()) return ''; return fmtMoney(numOrZero(raw)); })(),
            inflationPct: r.inflation_pct != null ? String(r.inflation_pct) : '',
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

        const { uwRows: uw, inflationRows: inf } = rebuildRows(years, savedUw, savedInf);
        setUwRows(uw);

        if (savedMode === 'country') {
          const withCountry = await loadCountryInflation(years, true, inf);
          setInflationRows(withCountry);
        } else if (savedMode === 'average' && savedAvg) {
          setInflationRows(applyAverageInflation(inf, savedAvg));
        } else {
          setInflationRows(inf);
        }
      } catch {
        const { uwRows: uw, inflationRows: inf } = rebuildRows(years, [], []);
        setUwRows(uw);
        if (inflationMode === 'country') {
          const withCountry = await loadCountryInflation(years, true, inf);
          setInflationRows(withCountry);
        } else {
          setInflationRows(inf);
        }
      } finally { setLoading(false); }
    })();
  }, [applyAverageInflation, contractId, inflationMode, loadCountryInflation, quoteMode, rebuildRows, years]); // intentionally exclude loadCountryInflation/applyAverageInflation — they are called within the effect body using current closure values

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

  /* ── Inflation mode change ── */
  const handleModeChange = useCallback(async (newMode) => {
    setInflationMode(newMode);
    if (newMode === 'average') {
      setInflationRows(prev => applyAverageInflation(prev, averageInflationPct));
    } else {
      const updated = await loadCountryInflation(years, false, inflationRows);
      setInflationRows(updated);
    }
  }, [years, averageInflationPct, inflationRows, loadCountryInflation, applyAverageInflation]);

  const handleApplyAverage = useCallback(() => {
    setInflationRows(prev => applyAverageInflation(prev, averageInflationPct));
  }, [averageInflationPct, applyAverageInflation]);

  /* ── Δ vs prev calculation ── */
  const uwNums = useMemo(() => uwRows.map(r => parseFlexNum(r.egnpi)), [uwRows]);

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
    const egnpiPayload = uwRows.map(r => ({
      uw_year: r.uwYear,
      egnpi: parseFlexNum(r.egnpi),
      inflation_pct: parseFlexNum(inflMap.get(String(r.uwYear)) ?? r.inflationPct),
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
      try { await api.saveNpEgnpiYear(contractId, { rows: egnpiPayload }, quoteMode ? { quote: true } : undefined); } catch {}
      await api.saveNonPropTreaty(contractId, payload, quoteMode ? { quote: true } : undefined);
      return true;
    } catch (e) {
      console.error('[NpPremiumsTable] save failed:', e);
      showToast('Premiums save failed: ' + (e?.message || 'Server error'));
      return false;
    }
  }, [contractId, uwRows, inflationRows, inflationMode, averageInflationPct, quoteMode, showToast]);

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
                    <div className="np-struct-card-title">UNDERWRITING YEARS · EGNPI</div>
                    <div className="np-struct-card-actions"><span className="np-tag">Portfolio movement</span></div>
                  </div>
                  <div className="np-table-wrap np-table-wrap--scroll">
                    <table className="np-prem-table">
                      <thead><tr><th className="np-table-sticky">UW</th><th>EGNPI</th><th className="cell-right">Δ vs prev</th></tr></thead>
                      <tbody>
                        {uwRows.length === 0 ? (
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
                    <div className="np-inf-line" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="np-muted">Country:</span>
                      <b style={{ marginLeft: 6 }}>{countryName || '—'}</b>
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
            </>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
