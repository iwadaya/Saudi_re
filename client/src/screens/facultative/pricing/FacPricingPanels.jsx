// src/screens/facultative/pricing/FacPricingPanels.jsx
// The two big panels of the fac pricing screen — UwFactorsPanel (the underwriting
// factor scorer) and EngineReadout (the computed-output table) — plus the pctChip
// helper, extracted to keep FacPricing under the 800-line budget. Props unchanged;
// no behaviour change.
import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../../../api';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { computeScoreAndDecision } from '../../../logic/facPropertyPricing';
import { logger } from '../../../utils/logger';

function pctChip(decimal) {
  // discount_loading is stored as a decimal (e.g. -0.10 = -10%).
  const n = Number(decimal);
  if (!Number.isFinite(n) || n === 0) return '0%';
  const sign = n > 0 ? '+' : '−';
  return `${sign}${Math.abs(n * 100).toFixed(2)}%`;
}

export function UwFactorsPanel({ riskId, risk, onScoreChange, onSelectionsChange }) {
  const [collapsed, setCollapsed] = useState(false);
  const [factors, setFactors]       = useState([]);
  const [weights, setWeights]       = useState(null);
  const [scoring, setScoring]       = useState(null);
  const [occupancies, setOccupancies] = useState([]);
  const [selections, setSelections] = useState({});
  const [notes, setNotes]           = useState('');

  // Load reference data + the risk's saved selections. Factor master,
  // weights, scoring tables and occupancies are cached client-side so
  // navigating between screens does not refetch.
  useEffect(() => {
    if (!riskId) return;
    Promise.all([
      api.facGetFactors(),
      api.facGetFactorWeights(),
      api.facGetScoringTables(),
      api.facGetOccupancies(),
    ]).then(([fac, fw, st, occ]) => {
      setFactors(fac?.factors || []);
      setWeights(fw?.schemes || null);
      setScoring(st || null);
      setOccupancies(occ?.occupancies || []);
    }).catch(logger.error);
  }, [riskId]);

  // Hydrate selections separately so reloading the saved blob does not
  // race the reference-data fetch.
  const hydrateSelections = useCallback((data) => {
    setSelections(data?.selections || {});
    setNotes(data?.notes || '');
  }, []);

  const saveSelections = useCallback(
    (id, state) => api.facSaveUwFactors(id, { selections: state.selections, notes: state.notes || null }),
    [],
  );

  const { save: saveUwFactors, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetUwFactors,
    save: saveSelections,
    currentState: () => ({ selections, notes }),
    onLoaded: hydrateSelections,
    errorLabel: 'UW Factors',
  });

  const setSelection = useCallback((code, label) => {
    setSelections((prev) => ({ ...prev, [code]: label }));
    markDirty();
  }, [markDirty]);

  // Filter the master list down to the 18 qualitative factors — those
  // with at least one option in fac_factor_option. HAZARD_GRADE and
  // FREQUENCY_GRADE come from the occupancy + dedicated score tables,
  // not from a user-picked option.
  const qualitativeFactors = useMemo(
    () => factors.filter((f) => Array.isArray(f.options) && f.options.length > 0),
    [factors],
  );

  // BI is included when bi_sum_insured > 0 OR pd_sum_insured is 0 with
  // BI > 0; in practice the existing risk model treats any positive BI
  // SI as BI-included. Falls through to WITHOUT_BI when there is no
  // BI exposure.
  const biIncluded = useMemo(() => {
    const bi = Number(risk?.bi_sum_insured) || 0;
    return bi > 0;
  }, [risk]);

  // Live score — pure client-side compute, no network call.
  const liveScore = useMemo(() => {
    if (!risk || !factors.length || !weights || !scoring) return null;
    try {
      return computeScoreAndDecision(
        {
          occupancy_code: risk.occupancy_code,
          factor_selections: selections,
          bi_included: biIncluded,
          market_rate_pm: 0,
        },
        {
          occupancies,
          factors,
          factorWeights: weights,
          hazardGradeScore: scoring.hazard_grade,
          frequencyScore: scoring.frequency,
          capacityBands: scoring.capacity_bands,
          territorialCapacity: scoring.territorial_capacity,
        },
        { final_net_rate_pm: 0 },
      );
    } catch {
      return null;
    }
  }, [risk, factors, weights, scoring, occupancies, selections, biIncluded]);

  // Surface the score upwards if the parent wants to compose it with the
  // pricing screen's other readouts.
  useEffect(() => {
    if (onScoreChange) onScoreChange(liveScore);
  }, [liveScore, onScoreChange]);

  // Mirror selections to the parent so the engine in FacPricing
  // recomputes in real time as the underwriter ticks options here.
  useEffect(() => {
    if (onSelectionsChange) onSelectionsChange(selections);
  }, [selections, onSelectionsChange]);

  // Lift the save() handle on the parent so WizardLayout's onBeforeNext
  // can flush both this panel and the pricing screen on navigation.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__facUwFactorsSave = saveUwFactors;
    return () => { delete window.__facUwFactorsSave; };
  }, [saveUwFactors]);

  const scheme = biIncluded ? 'WITH_BI' : 'WITHOUT_BI';

  return (
    <div style={{ marginBottom: 20, padding: '14px 18px',
                  background: 'rgba(168,85,247,0.04)',
                  border: '1px solid rgba(168,85,247,0.25)', borderRadius: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: collapsed ? 0 : 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
             role="button" tabIndex={0} aria-expanded={!collapsed}
             onClick={() => setCollapsed((c) => !c)}
             onKeyDown={(e) => {
               if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed((c) => !c); }
             }}>
          <span style={{ fontSize: 13, color: 'rgba(168,85,247,0.80)' }}>{collapsed ? '▶' : '▼'}</span>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em',
                         textTransform: 'uppercase', color: 'rgba(168,85,247,0.80)' }}>
            Underwriting Factors — Drivers of Rate &amp; Score
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em',
                          textTransform: 'uppercase', color: 'var(--muted)' }}>Scheme</div>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'color-mix(in srgb, #a855f7 75%, var(--text))', fontVariantNumeric: 'tabular-nums', lineHeight: '22px' }}>{scheme.replace(/_/g, ' ')}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em',
                          textTransform: 'uppercase', color: 'var(--muted)' }}>Score</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>
              {liveScore ? liveScore.underwriting_score.toFixed(2) : '—'}
              {liveScore?.capacity_grade && (
                <span style={{ marginLeft: 8, fontSize: 10, color: 'rgba(var(--accent-rgb),0.85)' }}>
                  {liveScore.capacity_grade} · {liveScore.uw_action}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {!collapsed && (
        <>
          {qualitativeFactors.length === 0 ? (
            <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.7)', padding: '8px 0' }}>
              Loading factor catalogue…
            </div>
          ) : (
            (() => {
              // One grid template shared by the header row and every
              // factor row, so the columns stay perfectly aligned even
              // as the panel resizes. The dropdown column is bounded —
              // otherwise it stretches to the right edge and the score
              // / loading chips end up orphaned far from the field.
              const ROW_COLS = '240px minmax(260px, 560px) 90px 110px';
              return (
                <div>
                  {/* Column headers */}
                  <div style={{ display: 'grid', gridTemplateColumns: ROW_COLS,
                                 gap: 16, alignItems: 'center',
                                 padding: '0 0 8px',
                                 borderBottom: '1px solid var(--hairline)',
                                 marginBottom: 8 }}>
                    <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                                   textTransform: 'uppercase', color: 'var(--muted)' }}>
                      Factor
                    </div>
                    <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                                   textTransform: 'uppercase', color: 'var(--muted)' }}>
                      Option
                    </div>
                    <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                                   textTransform: 'uppercase', color: 'var(--muted)',
                                   textAlign: 'right' }}>
                      Score
                    </div>
                    <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                                   textTransform: 'uppercase', color: 'var(--muted)',
                                   textAlign: 'right' }}>
                      Loading
                    </div>
                  </div>

                  {qualitativeFactors.map((factor) => {
                    const selectedLabel = selections[factor.factor_code] || '';
                    const selectedOpt = factor.options.find((o) => o.option_label === selectedLabel);
                    return (
                      <div key={factor.factor_code} style={{ display: 'grid',
                           gridTemplateColumns: ROW_COLS, gap: 16, alignItems: 'center',
                           padding: '8px 0',
                           borderBottom: '1px solid var(--hairline)' }}>
                        <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.85)' }}>
                          {factor.factor_name}
                        </div>
                        <select className="fi" value={selectedLabel}
                                onChange={(e) => setSelection(factor.factor_code, e.target.value)}
                                style={{ fontSize: 12, width: '100%' }}>
                          <option value="">— Select —</option>
                          {factor.options.map((o) => (
                            <option key={o.option_id || o.option_label} value={o.option_label}>
                              {o.option_label}
                            </option>
                          ))}
                        </select>
                        <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                      fontSize: 11, fontWeight: 700,
                                      color: selectedOpt ? 'var(--accent)' : 'rgba(var(--text-rgb),0.4)' }}>
                          {selectedOpt ? `score ${selectedOpt.score}` : '—'}
                        </div>
                        <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                      fontSize: 11, fontWeight: 700,
                                      color: factor.affects_rate
                                        ? (selectedOpt ? 'var(--accent-amber)' : 'rgba(var(--text-rgb),0.4)')
                                        : 'rgba(var(--text-rgb),0.45)' }}>
                          {factor.affects_rate
                            ? (selectedOpt ? pctChip(selectedOpt.discount_loading || 0) : '—')
                            : 'score only'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()
          )}

          <div style={{ marginTop: 12 }}>
            <textarea className="fi" rows={2} value={notes}
                      onChange={(e) => { setNotes(e.target.value); markDirty(); }}
                      placeholder="Underwriter notes on these factor selections…"
                      style={{ width: '100%', resize: 'vertical', fontSize: 12 }} />
          </div>
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Engine readout — pure display of computeFacQuote's result. Kept side-by-
// side with the legacy dual-engine sections; once underwriters trust this
// path we can retire the manual market/blend inputs.
// ───────────────────────────────────────────────────────────────────────────
export function EngineReadout({ output, premiums, totalLocSar }) {
  if (!output) {
    return (
      <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.7)', padding: '12px 0' }}>
        Engine waiting for reference data… (occupancies, factors and locations must load first).
      </div>
    );
  }
  if (output._error) {
    return (
      <div style={{ fontSize: 12, color: 'var(--accent-rose)', padding: '12px 0' }}>
        {(output.warnings || []).join(' / ') || 'Engine error.'}
      </div>
    );
  }
  const pm = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(4) : '—');
  const money = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)).toLocaleString('en-US') : '—');
  const pct = (v) => (Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(2)}%` : '—');

  const rows = [
    ['Flexa Base Rate (‰)',           pm(output.flexa_base_rate_pm)],
    ['Technical Rate — no NatCat (‰)', pm(output.technical_rate_no_natcat_pm)],
    ['Flood / Storm Loaded (‰)',       pm(output.flood_storm_rate_loaded_pm)],
    ['Earthquake Loaded (‰)',          pm(output.earthquake_rate_loaded_pm)],
    ['Total Rate (‰)',                 pm(output.total_rate_pm)],
    ['BI Rate (‰)',                    pm(output.bi_rate_pm)],
    ['Net Rate (‰)',                   pm(output.net_rate_pm)],
    ['Final Net Rate (‰)',             pm(output.final_net_rate_pm)],
    ['Final Gross Rate (‰)',           pm(output.final_gross_rate_pm)],
    ['Technical Premium (SAR)',        money(premiums?.technical)],
    ['Expected Premium (SAR)',         money(premiums?.expected)],
    ['Underwriting Score',
      Number.isFinite(Number(output.underwriting_score))
        ? Number(output.underwriting_score).toFixed(2) : '—'],
    ['Capacity Grade',                 output.capacity_grade || '—'],
    ['UW Action',                      output.uw_action || '—'],
    ['Max Capacity %',                 pct(output.max_capacity_pct)],
    ['Max Capacity (SAR)',             money(output.max_capacity_sar)],
    ['Market vs Tech %',               pct(output.market_vs_tech_pct)],
    ['Market vs Tech Band',            output.market_vs_tech_band || '—'],
  ];
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between',
               padding: '6px 12px', background: 'var(--control-bg)',
               border: '1px solid var(--hairline)', borderRadius: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(var(--text-rgb),0.90)',
                           fontVariantNumeric: 'tabular-nums' }}>{value}</span>
          </div>
        ))}
      </div>
      {Number.isFinite(totalLocSar) && totalLocSar > 0 && (
        <div style={{ marginTop: 8, fontSize: 10, color: 'rgba(var(--text-rgb),0.7)' }}>
          Premium computed against total location SAR SI = {money(totalLocSar)}.
        </div>
      )}
      {(output.warnings || []).length > 0 && (
        <div style={{ marginTop: 10, padding: '8px 12px',
                       background: 'rgba(var(--accent-amber-rgb),0.05)',
                       border: '1px solid rgba(var(--accent-amber-rgb),0.25)', borderRadius: 8 }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                        color: 'rgba(var(--accent-amber-rgb),0.85)', marginBottom: 4 }}>WARNINGS</div>
          {output.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: 'rgba(var(--accent-amber-rgb),0.9)' }}>{w}</div>
          ))}
        </div>
      )}
    </div>
  );
}
