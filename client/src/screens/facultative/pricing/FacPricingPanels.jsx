// src/screens/facultative/pricing/FacPricingPanels.jsx
// The panels of the fac pricing screen — the underwriting-factor scorer, the
// rate build-up, the engine detail table, and the two notes that explain what
// the engine is doing (or why it is not doing anything). Extracted to keep
// FacPricing under the 800-line budget.
import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../../../api';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { computeScoreAndDecision, SCORE_COMPLETENESS_MIN, RATING_BASIS_LABEL } from '../../../../../shared/fac/index.js';
import { logger } from '../../../utils/logger';
import './FacPricing.css';

function pctChip(decimal) {
  // discount_loading is stored as a decimal (e.g. -0.10 = -10%).
  const n = Number(decimal);
  if (!Number.isFinite(n) || n === 0) return '0%';
  const sign = n > 0 ? '+' : '−';
  return `${sign}${Math.abs(n * 100).toFixed(2)}%`;
}

// Number(null) is 0 and Number('') is 0, both finite — so a bare
// Number.isFinite guard renders a missing figure as "0", which is a very
// different statement from "not computed". Screen every blank out first.
const blank = (v) => v == null || v === '';
const pm = (v) => (!blank(v) && Number.isFinite(Number(v)) ? Number(v).toFixed(4) : '—');
const money = (v) => (!blank(v) && Number.isFinite(Number(v)) ? Math.round(Number(v)).toLocaleString('en-US') : '—');
const pctOf = (v) => (!blank(v) && Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(2)}%` : '—');

const EXPOSURE_BASIS_LABEL = {
  LOCATIONS:   'the location schedule',
  SECTIONS:    'the section sums insured',
  RISK_HEADER: 'the risk header sums insured',
  NONE:        'no exposure entered yet',
};

// ───────────────────────────────────────────────────────────────────────────
// Which exposure the price is being computed against, and which reference set
// produced it. Both used to be invisible: the premium basis silently switched
// between the location total and the risk header depending on whether any
// location happened to exist (F11), and a row re-opened after a rate revision
// recomputed against the new rates with nothing to say so (F12).
// ───────────────────────────────────────────────────────────────────────────
export function ExposureBasisNote({ exposure, rateVersion, family }) {
  if (!exposure) return null;
  const basis = EXPOSURE_BASIS_LABEL[exposure.basis] || 'no exposure entered yet';
  return (
    <div className="facpx-basis">
      <span>
        Priced on <strong>{basis}</strong>
        {exposure.total_si > 0 && (
          <> — <span className="facpx-basis-si">{money(exposure.total_si)}</span>
            {exposure.bi_included && <> ({pctOf(exposure.pd_si_share)} material damage)</>}
          </>
        )}
      </span>
      {family && <span>Family: <strong>{family.label}</strong></span>}
      {rateVersion && <span>Rates: <strong>{rateVersion}</strong></span>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// A class whose engine is not built yet, or a property risk missing an input
// the engine needs. Both used to surface as an exception message rendered in
// red — the property engine threw `Unknown occupancy_code` at every marine,
// casualty and cyber risk that reached it (F1). Neither is an error; both are
// states with a next action.
// ───────────────────────────────────────────────────────────────────────────
export function FamilyBlocker({ blocker, family }) {
  if (!blocker) return null;
  const notBuilt = blocker.reason === 'NOT_IMPLEMENTED';
  const accent = notBuilt ? 'var(--accent-blue-rgb)' : 'var(--accent-amber-rgb)';
  return (
    <div className="facpx-blocker" style={{ '--fac-accent': accent }}>
      <div className="facpx-blocker-kicker">
        {notBuilt ? 'No engine for this class yet' : 'Missing input'}
      </div>
      <div className="facpx-blocker-body">
        {blocker.message}
      </div>
      {family && (
        <div className="facpx-blocker-meta">
          {family.label} · {RATING_BASIS_LABEL[family.ratingBasis] || family.ratingBasis}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Underwriting factors
// ───────────────────────────────────────────────────────────────────────────
export function UwFactorsPanel({ riskId, risk, exposure, onScoreChange, onSelectionsChange }) {
  const [collapsed, setCollapsed] = useState(false);
  const [factors, setFactors]       = useState([]);
  const [weights, setWeights]       = useState(null);
  const [scoring, setScoring]       = useState(null);
  const [occupancies, setOccupancies] = useState([]);
  const [selections, setSelections] = useState({});
  const [notes, setNotes]           = useState('');

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

  const qualitativeFactors = useMemo(
    () => factors.filter((f) => Array.isArray(f.options) && f.options.length > 0),
    [factors],
  );

  // Live score — pure client-side compute, no network call. The exposure
  // profile decides the weight scheme, so the panel and the engine below it
  // can never disagree about whether this risk has BI.
  const liveScore = useMemo(() => {
    if (!risk || !factors.length || !weights || !scoring) return null;
    try {
      return computeScoreAndDecision(
        {
          occupancy_code: risk.occupancy_code,
          factor_selections: selections,
          exposure,
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
  }, [risk, factors, weights, scoring, occupancies, selections, exposure]);

  useEffect(() => {
    if (onScoreChange) onScoreChange(liveScore);
  }, [liveScore, onScoreChange]);

  useEffect(() => {
    if (onSelectionsChange) onSelectionsChange(selections);
  }, [selections, onSelectionsChange]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__facUwFactorsSave = saveUwFactors;
    return () => { delete window.__facUwFactorsSave; };
  }, [saveUwFactors]);

  const scheme = exposure?.bi_included ? 'WITH_BI' : 'WITHOUT_BI';
  const completeness = liveScore?.score_completeness ?? 0;
  const complete = completeness >= SCORE_COMPLETENESS_MIN;

  return (
    <div className="facpx-uw">
      <div className={`facpx-uw-head${collapsed ? '' : ' facpx-uw-head--open'}`}>
        <div className="facpx-uw-toggle"
             role="button" tabIndex={0} aria-expanded={!collapsed}
             onClick={() => setCollapsed((c) => !c)}
             onKeyDown={(e) => {
               if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed((c) => !c); }
             }}>
          <span className="facpx-uw-caret">{collapsed ? '▶' : '▼'}</span>
          <span className="facpx-uw-title">
            Underwriting Factors — Drivers of Rate &amp; Score
          </span>
        </div>
        <div className="facpx-uw-stats">
          <div className="facpx-uw-stat">
            <div className="facpx-kicker">Scheme</div>
            <div className="facpx-uw-scheme">{scheme.replace(/_/g, ' ')}</div>
          </div>
          <div className="facpx-uw-stat">
            <div className="facpx-kicker">Score</div>
            <div className={`facpx-uw-score${complete ? '' : ' facpx-uw-score--provisional'}`}>
              {liveScore ? liveScore.underwriting_score.toFixed(2) : '—'}
              {liveScore && (
                <span className={`facpx-uw-grade${complete ? '' : ' facpx-uw-grade--provisional'}`}>
                  {complete
                    ? `${liveScore.capacity_grade} · ${liveScore.uw_action}`
                    : 'PROVISIONAL'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Completeness. An unselected factor is UNSCORED, not zero — a
          half-filled form used to converge on a score near 0, which is the
          bottom grade, which reads as DECLINE (F5). */}
      {liveScore && (
        <div className="facpx-meter">
          <div className="facpx-meter-labels">
            <span>{(completeness * 100).toFixed(0)}% of the scoring weight selected</span>
            {!complete && (
              <span className="facpx-meter-floor">
                {(SCORE_COMPLETENESS_MIN * 100).toFixed(0)}% needed before a grade is issued
              </span>
            )}
          </div>
          <div className="facpx-meter-track">
            <div className={`facpx-meter-fill${complete ? '' : ' facpx-meter-fill--provisional'}`}
                 style={{ '--fac-fill': `${Math.min(100, completeness * 100)}%` }} />
          </div>
        </div>
      )}

      {!collapsed && (
        <>
          {qualitativeFactors.length === 0 ? (
            <div className="facpx-factors-loading">
              Loading factor catalogue…
            </div>
          ) : (
            (() => {
              const unscored = new Set(liveScore?.unscored_factors || []);
              return (
                <div>
                  <div className="facpx-factor-head">
                    <div className="facpx-col-head">Factor</div>
                    <div className="facpx-col-head">Option</div>
                    <div className="facpx-col-head facpx-col-head--num">Score</div>
                    <div className="facpx-col-head facpx-col-head--num">Loading</div>
                  </div>

                  {qualitativeFactors.map((factor) => {
                    const selectedLabel = selections[factor.factor_code] || '';
                    const selectedOpt = factor.options.find((o) => o.option_label === selectedLabel);
                    const isUnscored = unscored.has(factor.factor_code);
                    return (
                      <div key={factor.factor_code} className="facpx-factor-row">
                        <div className="facpx-factor-name">
                          {factor.factor_name}
                        </div>
                        <select className="fi facpx-factor-select" value={selectedLabel}
                                onChange={(e) => setSelection(factor.factor_code, e.target.value)}>
                          <option value="">— Select —</option>
                          {factor.options.map((o) => (
                            <option key={o.option_id || o.option_label} value={o.option_label}>
                              {o.option_label}
                            </option>
                          ))}
                        </select>
                        <div className={`facpx-factor-num${selectedOpt ? ' facpx-factor-num--scored'
                          : (isUnscored ? ' facpx-factor-num--unscored' : '')}`}>
                          {selectedOpt ? `score ${selectedOpt.score}` : (isUnscored ? 'unscored' : '—')}
                        </div>
                        <div className={`facpx-factor-num${factor.affects_rate
                          ? (selectedOpt ? ' facpx-factor-num--loading' : '')
                          : ' facpx-factor-num--inert'}`}>
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

          <div className="facpx-uw-notes">
            <textarea className="fi" rows={2} value={notes}
                      onChange={(e) => { setNotes(e.target.value); markDirty(); }}
                      placeholder="Underwriter notes on these factor selections…" />
          </div>
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Rate build-up — the whole price, top to bottom, in the order it is derived.
//
// The screen used to show four disconnected loading mechanisms and a final
// figure that came from a manual blend rather than any of them (F9). Every
// line here feeds the next, and the last line is what gets quoted.
// ───────────────────────────────────────────────────────────────────────────
function WaterfallRow({ label, detail, value, emphasis, indent }) {
  return (
    <div className={`facpx-wf-row${emphasis ? ' facpx-wf-row--rule' : ''}`}>
      <div className={indent ? 'facpx-wf-cell--indent' : undefined}>
        <span className="facpx-wf-label">{label}</span>
        {detail && <span className="facpx-wf-detail">{detail}</span>}
      </div>
      <div className="facpx-wf-value">
        {value}
      </div>
    </div>
  );
}

export function PricingWaterfall({
  output, exposure, extensionsLoadingPct, coverLoadings,
  adjustmentPct, adjustmentReason, quotedRate, quotedPremium,
}) {
  if (!output) {
    return (
      <div className="facpx-wf-empty">
        Waiting for reference data — occupancies, factors and the location schedule load first.
      </div>
    );
  }
  if (output._error) {
    return (
      <div className="facpx-wf-error">
        {(output.warnings || []).join(' / ') || 'Engine error.'}
      </div>
    );
  }

  const natcat = Number(output.flood_storm_rate_loaded_pm || 0) + Number(output.earthquake_rate_loaded_pm || 0);
  const grossUp = output.final_net_rate_pm > 0 && output.final_gross_rate_pm > 0
    ? output.final_gross_rate_pm / output.final_net_rate_pm
    : null;

  return (
    <section aria-label="Rate build-up">
      <WaterfallRow label="FLEXA base rate" detail="occupancy" value={pm(output.flexa_base_rate_pm)} />
      <WaterfallRow label="Technical rate" detail="× (1 + factor discounts / loadings)" value={pm(output.technical_rate_no_natcat_pm)} emphasis />
      <WaterfallRow label="Flood / storm" indent value={pm(output.flood_storm_rate_loaded_pm)} />
      <WaterfallRow label="Earthquake" indent value={pm(output.earthquake_rate_loaded_pm)} />
      <WaterfallRow label="+ NatCat load" detail="zone rates, factor-loaded" value={pm(natcat)} />
      <WaterfallRow label="= Total rate" value={pm(output.total_rate_pm)} emphasis />
      {exposure?.bi_included && (
        <>
          <WaterfallRow label="BI rate" detail="indemnity loading × total × BI plan" indent value={pm(output.bi_rate_pm)} />
          <WaterfallRow label="= Net rate" detail={`${pctOf(exposure.pd_si_share)} MD / ${pctOf(1 - exposure.pd_si_share)} BI`} value={pm(output.net_rate_pm)} emphasis />
        </>
      )}
      {coverLoadings?.length > 0 && (
        <WaterfallRow
          label="+ Extensions"
          detail={`${coverLoadings.length} applied, +${extensionsLoadingPct.toFixed(0)}%`}
          value={pm(output.final_net_rate_pm)}
        />
      )}
      <WaterfallRow label="= Technical net" value={pm(output.final_net_rate_pm)} emphasis />
      <WaterfallRow
        label="÷ (1 − commission − margin − expenses)"
        detail={grossUp ? `gross-up ×${grossUp.toFixed(3)}` : null}
        value={pm(output.final_gross_rate_pm)}
      />
      <WaterfallRow label="= TECHNICAL GROSS" value={pm(output.final_gross_rate_pm)} emphasis />
      {adjustmentPct !== 0 && (
        <WaterfallRow
          label="UW adjustment"
          detail={adjustmentReason?.trim() || '⚠ no reason given'}
          value={`${adjustmentPct > 0 ? '+' : '−'}${Math.abs(adjustmentPct * 100).toFixed(1)}%`}
        />
      )}
      <WaterfallRow label="QUOTED RATE (‰)" value={quotedRate == null ? '—' : quotedRate.toFixed(4)} emphasis />
      <WaterfallRow
        label="Quoted premium"
        detail={exposure?.total_si > 0 ? `on ${money(exposure.total_si)}` : 'no exposure entered'}
        value={money(quotedPremium)}
      />

      {(output.warnings || []).length > 0 && (
        <div className="facpx-warnings">
          <div className="facpx-warnings-kicker">WARNINGS</div>
          {output.warnings.map((w, i) => (
            <div key={i} className="facpx-warning">{w}</div>
          ))}
        </div>
      )}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Engine detail — the score and capacity half, plus the raw rate figures for
// anyone reconciling against the workbook.
// ───────────────────────────────────────────────────────────────────────────
export function EngineReadout({ output, exposure }) {
  if (!output || output._error) return null;

  const complete = (output.score_completeness ?? 0) >= SCORE_COMPLETENESS_MIN;
  const rows = [
    ['Underwriting Score',
      Number.isFinite(Number(output.underwriting_score))
        ? Number(output.underwriting_score).toFixed(2) : '—'],
    ['Scoring Completeness', pctOf(output.score_completeness)],
    ['Capacity Grade', complete ? (output.capacity_grade || '—') : 'not issued'],
    ['UW Action', output.uw_action || '—'],
    ['Max Capacity %', complete ? pctOf(output.max_capacity_pct) : '—'],
    ['Max Capacity (SAR)', money(output.max_capacity_sar)],
    ['Market vs Tech %', pctOf(output.market_vs_tech_pct)],
    ['Market vs Tech Band', output.market_vs_tech_band || 'not scored — no benchmark rate'],
    ['Technical Premium', money(output.premiums?.technical)],
    ['Expected Premium', money(output.premiums?.expected)],
    // The exposure basis itself is stated once, at the top of the screen.
    ['Total Sum Insured', money(exposure?.total_si)],
  ];

  return (
    <div>
      <div className="facpx-detail-grid">
        {rows.map(([label, value]) => (
          <div key={label} className="facpx-detail-cell">
            <span className="facpx-detail-label">{label}</span>
            <span className="facpx-detail-value">{value}</span>
          </div>
        ))}
      </div>
      {(output.unscored_factors || []).length > 0 && (
        <div className="facpx-unscored">
          Unscored: {output.unscored_factors.join(', ')}
        </div>
      )}
    </div>
  );
}
