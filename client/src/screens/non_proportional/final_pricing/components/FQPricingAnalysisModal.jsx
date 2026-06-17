// components/FQPricingAnalysisModal.jsx — 3-tab pricing workbench.
//
// Tab 1 "Pricing Analysis": per-peril sections (Risk above Cat) stacked
// vertically, each with a weight Blender bar, a metrics table, and a notes
// box; below them a combined per-layer Total Section (risk + cat fused) shows
// whenever any component is active.
// Tabs 2/3 ("Pareto Simulation", "Inflation & Loss") are placeholders.
import { useState, useEffect, useMemo, useRef } from 'react';
import { formatWithCommas } from '../../../../utils/format';
import { toN, capPct2 } from '../formatters.js';
import { QUOTE_COMPONENT_SCOPES, quoteComponentDerived, layerCombinedPricing } from '../fqQuoteMath.js';
import { fqPriceLayerOnCurve, fqFitPowerLaw, fqPeerToXY, fqGeomean } from '../fqHelpers.js';
import { REINSTATEMENT_OPTIONS } from '../../reinstatementOptions';
import { api } from '../../../../api';
import { FQPctCell, FQReadCell } from './FQCells.jsx';
import FQFinalPriceModal from './FQFinalPriceModal.jsx';
import SeverityFitPanel from './SeverityFitPanel.jsx';
import FrequencySimPanel from './FrequencySimPanel.jsx';

const TOP_TABS = [
  { k: 'pricing', label: 'Pricing Analysis' },
  { k: 'pareto', label: 'Pareto Simulation' },
  { k: 'loss', label: 'Inflation & Loss' },
];

// Editable weight cell: shows the value with a "%" suffix while idle (capped at
// 2 dp), bare full-precision digits while editing. Entry keeps full precision
// and strips any "%" (onChange passes the raw number); only the idle display is
// capped and suffixed — the stored weight stays a bare number, so the Σ=100
// blend math reads it unchanged.
function WtInput({ value, disabled, ariaLabel, onChange }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const idle = capPct2(value);
  return (
    <input
      type="text"
      inputMode="decimal"
      className="bm-cell bm-cell--sm"
      aria-label={ariaLabel}
      value={editing ? raw : (idle === '' ? '' : `${idle}%`)}
      disabled={disabled}
      onFocus={() => { setEditing(true); setRaw(String(value ?? '').replace(/%/g, '')); }}
      onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ''); setRaw(v); onChange(v); }}
      onBlur={() => setEditing(false)}
      style={{ width: '100%', boxSizing: 'border-box', opacity: disabled ? 0.5 : 1 }}
    />
  );
}

// Per-component colours for the modelled block. Each component (Pure Burn /
// Pareto / Exposure) gets a distinct line + faint tint, and its matching weight
// column (Wt Burn / Wt Pareto / Wt Exp) reuses the SAME colour so the blend
// weights read visually paired with the component they weight.
const COMP = {
  pureBurn: { line: 'var(--accent)',       tint: 'rgba(var(--accent-rgb),0.10)' },        // green
  pareto:   { line: 'var(--accent-amber)', tint: 'rgba(var(--accent-amber-rgb),0.10)' },  // amber
  exposure: { line: 'var(--accent-rose)',  tint: 'rgba(var(--accent-rose-rgb),0.10)' },   // violet → rose (no violet token)
};

// Subtle background tints that band the table into Modelled / Implied-Expiring /
// Implied-Market / UW groups.
const G = {
  modelled: 'rgba(var(--accent-rgb),0.06)',
  exp: 'rgba(var(--accent-amber-rgb),0.08)',
  country: 'rgba(var(--accent-blue-rgb),0.08)',
  region: 'rgba(var(--accent-rose-rgb),0.08)',   // violet → rose (no violet token)
  global: 'rgba(var(--accent-rgb),0.08)',
  uw: 'rgba(var(--accent-blue-rgb),0.08)',
  note: 'var(--surface-hover)',
};

/**
 * @param {{
 *   pricingAnalysisModal: { open: boolean, structureIndex: number | null },
 *   clientStructures: Array<object>,
 *   isQuote: boolean,
 *   riskDisabled: boolean,
 *   catDisabled: boolean,
 *   quoteCurve: object,
 *   contractId?: string,   // reserved for the Implied · Country/Region/Global columns (next prompt)
 *   cobIds?: string[],     // reserved (peer fetch) for the implied-market columns
 *   runQuoteCalcEngine?: (structureIndex?: number | null) => void,
 *   runQuoteCalcStructure?: (structureIndex: number) => Promise<{ ran: boolean, risk?: { layerCount: number, burn: boolean, pareto: boolean, exposure: boolean }, cat?: { layerCount: number, burn: boolean, pareto: boolean, exposure: boolean }, error?: string }>,
 *   calcEngineRunning?: boolean,
 *   runningStructures?: Record<string, boolean>,
 *   calcEngineError?: string,
 *   updateClientStructureLayer: (sIdx: number, lIdx: number, field: string, value: unknown) => void,
 *   updateClientStructure: (sIdx: number, field: string, value: unknown) => void,
 *   onClose: () => void,
 * }} props
 */
export default function FQPricingAnalysisModal({
  pricingAnalysisModal,
  clientStructures,
  isQuote,
  riskDisabled,
  catDisabled,
  quoteCurve,
  contractId,
  cobIds,
  runQuoteCalcEngine,
  runQuoteCalcStructure,
  calcEngineRunning,
  runningStructures,
  calcEngineError,
  updateClientStructureLayer,
  updateClientStructure,
  save,
  doSubmitForApproval,
  onClose,
}) {
  const [tab, setTab] = useState('pricing');
  // Per-scope "Final Price" modal (null = closed, else 'risk' | 'cat').
  const [finalPriceScope, setFinalPriceScope] = useState(null);
  // CALCULATE state — one tab-level run covering BOTH scopes. `calculating` is the
  // single in-flight flag; `scopeNotes` ({ risk?, cat? }) flags components the
  // engine couldn't price (missing inputs) per scope. Driven only by the Calculate
  // button — the underwriter controls when the engine overwrites the locked
  // component cells (weight / Final Price edits never trigger it).
  const [calculating, setCalculating] = useState(false);
  const [scopeNotes, setScopeNotes] = useState({});
  // Published severity fits (one per scope) so the FrequencySimPanel can run
  // the Monte-Carlo off the same losses / threshold / family the fit shows.
  const [riskSevFit, setRiskSevFit] = useState(null);
  const [catSevFit, setCatSevFit] = useState(null);
  // ── Peer pools per scope → power-law fits for the Implied · Country/Region/
  //    Global columns (same fits the benchmark modal uses). Fetched on open and
  //    whenever contractId/cobIds change; failures degrade to an empty pool. ──
  const [peerPools, setPeerPools] = useState({});
  const cobIdsKey = useMemo(() => (Array.isArray(cobIds) ? cobIds.slice().sort().join(',') : ''), [cobIds]);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    if (!pricingAnalysisModal.open || !contractId) return undefined;
    let cancelled = false;
    const cobIdList = cobIdsKey ? cobIdsKey.split(',').filter(Boolean) : [];
    setPeerPools({});
    ['country', 'region', 'global'].forEach((scope) => {
      api.getPeerStructures(contractId, { scope, cobIds: cobIdList })
        .then((data) => {
          if (cancelled || !mountedRef.current) return;
          setPeerPools((prev) => ({ ...prev, [scope]: Array.isArray(data?.peers) ? data.peers : [] }));
        })
        .catch(() => {
          if (cancelled || !mountedRef.current) return;
          setPeerPools((prev) => ({ ...prev, [scope]: [] }));
        });
    });
    return () => { cancelled = true; };
  }, [pricingAnalysisModal.open, contractId, cobIdsKey]);
  const scopeFits = useMemo(() => {
    const fit = (peers) => fqFitPowerLaw((peers || []).map(fqPeerToXY).filter(Boolean));
    return { country: fit(peerPools.country), region: fit(peerPools.region), global: fit(peerPools.global) };
  }, [peerPools]);
  const sIdx = pricingAnalysisModal.structureIndex;
  const structure = Number.isInteger(sIdx) ? clientStructures[sIdx] : null;

  // ── Auto-run the shared actuarial engine on open ─────────────────────────
  // The pricing-analysis component cells (pure burn / Pareto / exposure ROL%)
  // are MODEL values — computed by the SAME calcLayerPricing the NP assessment /
  // loss-selection screens use, never free-typed. Seed them from the engine on
  // every open for a quote structure, so they reflect the latest SELECTED
  // losses, saved Pareto params and layer terms (re-fetched each run) — and so a
  // stale/raw saved value (e.g. Pareto "82.822") can't linger. The merge
  // protects any underwriter override (a component edit is marked manual), so
  // re-seeding never clobbers a hand-entered value. Guards:
  //   • only quote mode, only when an engine fn is wired in
  //   • skip if a calc for this structure is already in flight
  //   • one shot per open (autoRunKeyRef), reset when the modal closes
  // If the run finds no saved inputs the cells stay "—" and an inline hint
  // points the user at the earlier NP steps. We never auto-run on keystrokes.
  const modalOpen = !!pricingAnalysisModal.open;
  const calcRunningForStructure = !!calcEngineRunning
    || !!(runningStructures && Number.isInteger(sIdx) && runningStructures[sIdx]);
  const hasEngineResults = useMemo(() => (structure?.layers || []).some((l) => (
    toN(l.riskPureBurn) > 0 || toN(l.catPureBurn) > 0
    || toN(l.riskExposure) > 0 || toN(l.catExposure) > 0
    || toN(l.riskPareto) > 0 || toN(l.catPareto) > 0
  )), [structure]);
  const autoRunKeyRef = useRef(null);
  const [autoRan, setAutoRan] = useState(false);
  // Reset the one-shot guard when the modal closes so the next open re-evaluates.
  useEffect(() => {
    if (!modalOpen) { autoRunKeyRef.current = null; setAutoRan(false); setCalculating(false); setScopeNotes({}); }
  }, [modalOpen]);
  useEffect(() => {
    if (!modalOpen || !isQuote || typeof runQuoteCalcEngine !== 'function') return;
    if (!Number.isInteger(sIdx) || !structure) return;
    const key = String(sIdx);
    if (autoRunKeyRef.current === key) return;       // already seeded this open/target
    if (calcRunningForStructure) return;             // a calc is in flight — let it finish
    autoRunKeyRef.current = key;
    setAutoRan(true);
    runQuoteCalcEngine(sIdx);
  }, [modalOpen, isQuote, runQuoteCalcEngine, sIdx, structure, calcRunningForStructure]);
  // "Calculating…" while the engine runs; the stale hint only after our own
  // auto-run came back empty (i.e. no saved losses / profile to price from).
  const showCalculating = isQuote && calcRunningForStructure;
  const showStaleHint = isQuote && autoRan && !calcRunningForStructure && !hasEngineResults;

  if (!pricingAnalysisModal.open) return null;

  // Resolve layers straight from the LIVE list (clientStructures[sIdx].layers),
  // never a modal-payload copy. A null structure means the modal was opened for
  // an index that no longer exists (structure removed/reordered while open) —
  // show a dismissable note rather than a blank shell.
  if (!structure) {
    return (
      <div className="bm-modal-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="bm-modal" style={{ width: 'min(420px, 92vw)', display: 'grid', gridTemplateRows: 'auto auto' }}>
          <div className="bm-modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>Pricing Analysis</div>
            <button className="bm-pill" onClick={() => onClose()}>Close</button>
          </div>
          <div data-testid="fq-analysis-no-structure" style={{ padding: '24px 20px', fontSize: 12, color: 'rgba(148,163,184,0.8)' }}>
            No structure selected.
          </div>
        </div>
      </div>
    );
  }

  const layers = structure.layers || [];
  // Table numbers show bare (no currency code): "10,000,000", not "USD 10,000,000".
  const fmtMoney = (value) => {
    const n = toN(value);
    return n > 0 ? formatWithCommas(String(Math.round(n))) : '—';
  };
  const fmtPct = (n) => (n > 0 ? `${n.toFixed(2)}%` : '—');
  // Curve-predicted ROL% for a layer under a peer-scope fit: a·x^b·100, where
  // x = geomean(limit, attachment) / egnpi. "—" when uncalibrated or x ≤ 0.
  const impliedScopeRol = (layer, fit) => {
    if (!fit || !fit.calibrated) return null;
    const egnpi = toN(layer.egnpi);
    const x = egnpi > 0 ? fqGeomean(toN(layer.limit), toN(layer.attachment)) / egnpi : 0;
    if (!(x > 0)) return null;
    const rol = fit.a * Math.pow(x, fit.b) * 100;
    return Number.isFinite(rol) && rol > 0 ? rol : null;
  };

  // ── Peril activity: active = not disabled by mode AND ≥1 layer flagged.
  //    If both allowed but none flagged, show both. ──
  const riskFlagged = layers.some((l) => !!l.risk);
  const catFlagged = layers.some((l) => !!l.cat);
  const bothAllowedNoneFlagged = !riskDisabled && !catDisabled && !riskFlagged && !catFlagged;
  const showRisk = (!riskDisabled && riskFlagged) || bothAllowedNoneFlagged;
  const showCat = (!catDisabled && catFlagged) || bothAllowedNoneFlagged;

  // ── Per-section Wtd ROL (used in each section header) ──
  const componentTotals = (scopeKey) => {
    const activeLayers = layers.filter((layer) => !!layer[scopeKey]);
    const totalLimit = activeLayers.reduce((s, layer) => s + toN(layer.limit), 0);
    const premium = activeLayers.reduce((s, layer) => {
      const limit = toN(layer.limit);
      const rol = quoteComponentDerived(layer, scopeKey).totalRol;
      return s + (limit > 0 && rol > 0 ? limit * rol / 100 : 0);
    }, 0);
    return { activeCount: activeLayers.length, totalLimit, premium, wtdRol: totalLimit > 0 ? (premium / totalLimit) * 100 : 0 };
  };
  // Combined per-layer pricing (risk + cat fused) for the Total Section —
  // shared with the Send-for-Approval review via layerCombinedPricing.
  const layerCombined = layerCombinedPricing;

  const th = { padding: '8px 10px', textAlign: 'right', fontSize: 9, fontWeight: 850, letterSpacing: '.11em', color: 'rgba(148,163,184,0.68)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap' };
  const td = { padding: '7px 8px', textAlign: 'right', verticalAlign: 'middle' };
  const groupTh = (bg, underline) => ({ ...th, background: bg, borderBottom: `2px solid ${underline}` });
  const tabBtn = (active) => ({ padding: '10px 16px', background: active ? 'rgba(var(--accent-blue-rgb),0.08)' : 'transparent', border: 'none', borderBottom: active ? '2px solid var(--accent-blue)' : '2px solid transparent', color: active ? 'var(--accent-blue)' : 'rgba(226,232,240,0.65)', fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', cursor: 'pointer' });

  // Per-scope missing-input note from a Calculate run's summary. A scope with no
  // active layers gets no note; otherwise list the components the engine couldn't
  // price (so the cell keeps its prior value rather than showing a silent 0).
  const noteFromScope = (s) => {
    if (!s || !s.layerCount) return '';
    const missing = [];
    if (!s.burn) missing.push('no loss data — pure burn not calculated');
    if (!s.pareto) missing.push('no Pareto fit — Pareto not calculated');
    if (!s.exposure) missing.push('no exposure data — exposure not calculated');
    return missing.join('; ');
  };

  // ONE tab-level CALCULATE: run the canonical engine for BOTH scopes' active
  // layers in a single action and write the resulting pure burn / Pareto /
  // exposure ROL% into the locked cells (the merge re-blends, so both Wtd ROL
  // readouts update). The components change ONLY here (or on the on-open auto-run)
  // — never on a weight / Final Price edit. Missing inputs for a scope surface an
  // inline note on that scope; the other scope still calculates.
  const handleCalculateAll = async () => {
    if (typeof runQuoteCalcStructure !== 'function' || !Number.isInteger(sIdx)) return;
    setCalculating(true);
    setScopeNotes({});
    try {
      const r = await runQuoteCalcStructure(sIdx);
      if (!r || r.ran === false) {
        const msg = r && r.error ? `Calculation failed: ${r.error}` : '';
        setScopeNotes({ risk: msg, cat: msg });
      } else {
        setScopeNotes({ risk: noteFromScope(r.risk), cat: noteFromScope(r.cat) });
      }
    } finally {
      setCalculating(false);
    }
  };

  const renderScopeSection = (scopeKey) => {
    const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
    const f = scope.fields;
    // Engine-written probability fields + the per-layer note field live
    // outside scope.fields (rendered as their own columns right of UW Price).
    const prAttachField  = scopeKey === 'risk' ? 'riskPrAttach'  : 'catPrAttach';
    const prExhaustField = scopeKey === 'risk' ? 'riskPrExhaust' : 'catPrExhaust';
    const noteField      = `${scopeKey}LayerNote`;
    // Fixed column widths (table-layout: fixed) so the 22 columns don't crush;
    // the table scrolls horizontally inside its own wrapper when narrower.
    // Order: Layer, Active, Limit, Deductible, EGNPI, Reinst., % Reinst.,
    //   Pure Burn, Pareto, Exposure, Wt Burn, Wt Pareto, Wt Exp, Blend,
    //   Implied·Expiring/Country/Region/Global, UW Price, P(Attach), P(Exhaust), Note.
    // The data-entry component columns (% Reinst., Pure Burn, Pareto, Exposure,
    // Wt Burn/Pareto/Exp, UW Price) are ~10% wider than the rest so a value like
    // "56.56%" isn't clipped; the table keeps its horizontal scroll.
    const COLW = [52, 56, 110, 110, 120, 80, 101, 97, 88, 97, 86, 92, 86, 84, 96, 96, 96, 96, 114, 88, 92, 180];
    const TABLE_MIN_W = COLW.reduce((s, w) => s + w, 0);
    const disabledByMode = scopeKey === 'risk' ? riskDisabled : catDisabled;
    const scopeNote = scopeNotes[scopeKey];
    // Blend uses THIS row's own weights (Wt Burn/Pareto/Exp columns), divided
    // by the actual weight sum so it stays valid even if they don't total 100.
    const blendOf = (layer) => {
      const wB = toN(layer[f.wtBurn]);
      const wP = toN(layer[f.wtPareto]);
      const wE = toN(layer[f.wtExp]);
      const denom = wB + wP + wE;
      return denom > 0 ? (wB * toN(layer[f.pureBurn]) + wP * toN(layer[f.pareto]) + wE * toN(layer[f.exposure])) / denom : 0;
    };
    const impliedExpOf = (layer) => {
      const priced = fqPriceLayerOnCurve(layer, quoteCurve?.fit, quoteCurve?.baseEgnpi);
      return priced ? priced.y * 100 : null;
    };
    // Per-section totals: amount columns sum; rate columns are LIMIT-weighted
    // averages over the scope's active layers (so every numeric column gets a
    // value). getVal returns null to exclude a layer (e.g. uncalibrated implied).
    const activeLayers = layers.filter((l) => !!l[scopeKey]);
    const sumLimit = activeLayers.reduce((s, l) => s + toN(l.limit), 0);
    const sumEgnpi = activeLayers.reduce((s, l) => s + toN(l.egnpi), 0);
    const lwAvg = (getVal) => {
      let wSum = 0; let acc = 0;
      for (const l of activeLayers) {
        const lim = toN(l.limit);
        const v = getVal(l);
        if (lim > 0 && v != null && Number.isFinite(v)) { wSum += lim; acc += lim * v; }
      }
      return wSum > 0 ? acc / wSum : 0;
    };
    // Small editable numeric cell for the per-row weight columns (2 dp display).
    const wtCell = (lIdx, field, layer) => (
      <WtInput
        ariaLabel={`${scope.label} Structure ${sIdx + 1} Layer ${lIdx + 1} ${field}`}
        value={layer[field]}
        disabled={disabledByMode}
        onChange={(v) => updateClientStructureLayer(sIdx, lIdx, field, v)}
      />
    );
    return (
      <section key={scopeKey} style={{ background: 'rgba(8,14,30,0.72)', border: `1px solid ${scope.color}35`, borderRadius: 12 }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: scope.color }}>{scope.label} Pricing Analysis</div>
            <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>Edit component metrics here; the main structure table updates from these totals.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 11, color: 'rgba(226,232,240,0.75)', fontWeight: 750 }}>Wtd ROL {fmtPct(componentTotals(scopeKey).wtdRol)}</div>
            <button
              type="button"
              data-testid={`fq-final-price-open-${scopeKey}`}
              onClick={() => setFinalPriceScope(scopeKey)}
              style={{ padding: '5px 12px', borderRadius: 8, border: `1px solid ${scope.color}66`, background: `${scope.color}1f`, color: scope.color, fontSize: 10, fontWeight: 850, letterSpacing: '.08em', textTransform: 'uppercase', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              Final Price
            </button>
          </div>
        </div>
        {/* Missing-input note from the last Calculate — flags components the engine
            couldn't price (no selected losses / no profiles) instead of writing 0. */}
        {scopeNote && (
          <div data-testid={`fq-calc-note-${scopeKey}`} style={{ padding: '6px 14px', fontSize: 10, lineHeight: 1.5, color: 'rgba(251,191,36,0.95)', background: 'rgba(245,158,11,0.08)', borderBottom: '1px solid rgba(245,158,11,0.2)' }}>
            {scopeNote}
          </div>
        )}
        {/* Weights are now per-row columns (Wt Burn/Pareto/Exp) — no top blender.
            ONLY the table scrolls horizontally; the section header sits above
            (full-width), the notes textarea below. */}
        <div style={{ overflowX: 'auto', overflowY: 'visible', width: '100%' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: TABLE_MIN_W, tableLayout: 'fixed', fontSize: 11 }}>
            <colgroup>{COLW.map((w, ci) => (<col key={`col-${ci}`} style={{ width: w }} />))}</colgroup>
            <thead style={{ background: '#050810' }}>
              {/* Two-tier header: group banners (WEIGHTING colSpan=3 over Wt Burn/
                  Pareto/Exp, IMPLIED colSpan=4 over Expiring/Country/Region/Global)
                  sit above their short sub-labels so each reads on one line. Every
                  other column uses rowSpan=2 to span both header rows, bottom-aligned
                  so its label lines up with the sub-labels. The column COUNT is
                  unchanged (22), so tbody/tfoot cells stay aligned — and the row-2
                  sub-labels run in column order: WEIGHTING's three, then IMPLIED's four. */}
              <tr>
                <th rowSpan={2} style={{ ...th, textAlign: 'center', verticalAlign: 'bottom' }}>Layer</th>
                <th rowSpan={2} style={{ ...th, textAlign: 'center', verticalAlign: 'bottom' }}>Active</th>
                <th rowSpan={2} style={{ ...th, verticalAlign: 'bottom' }}>Limit</th>
                <th rowSpan={2} style={{ ...th, verticalAlign: 'bottom' }}>Deductible</th>
                <th rowSpan={2} style={{ ...th, verticalAlign: 'bottom' }}>EGNPI</th>
                <th rowSpan={2} style={{ ...groupTh(G.note, 'var(--stroke)'), verticalAlign: 'bottom' }}>Reinst.</th>
                <th rowSpan={2} style={{ ...groupTh(G.note, 'var(--stroke)'), verticalAlign: 'bottom' }}>% Reinst.</th>
                <th rowSpan={2} style={{ ...groupTh(COMP.pureBurn.tint, COMP.pureBurn.line), verticalAlign: 'bottom' }}>Pure Burn</th>
                <th rowSpan={2} style={{ ...groupTh(COMP.pareto.tint, COMP.pareto.line), verticalAlign: 'bottom' }}>Pareto</th>
                <th rowSpan={2} style={{ ...groupTh(COMP.exposure.tint, COMP.exposure.line), verticalAlign: 'bottom' }}>Exposure</th>
                {/* WEIGHTING group banner — spans the Wt Burn/Pareto/Exp columns,
                    mirroring the IMPLIED two-tier treatment. */}
                <th colSpan={3} style={{ ...groupTh(G.modelled, 'var(--accent)'), textAlign: 'center' }}>Weighting</th>
                <th rowSpan={2} style={{ ...groupTh(G.modelled, 'var(--accent)'), verticalAlign: 'bottom' }}>Blend</th>
                {/* IMPLIED group banner — spans the Expiring/Country/Region/Global peer columns. */}
                <th colSpan={4} style={{ ...groupTh(G.exp, 'var(--accent-amber)'), textAlign: 'center' }}>Implied</th>
                <th rowSpan={2} style={{ ...groupTh(G.uw, 'var(--accent-blue)'), verticalAlign: 'bottom' }}>UW Price</th>
                <th rowSpan={2} style={{ ...groupTh(G.modelled, 'var(--accent)'), verticalAlign: 'bottom' }}>P(Attach)</th>
                <th rowSpan={2} style={{ ...groupTh(G.modelled, 'var(--accent)'), verticalAlign: 'bottom' }}>P(Exhaust)</th>
                <th rowSpan={2} style={{ ...groupTh(G.note, 'var(--stroke)'), textAlign: 'left', verticalAlign: 'bottom' }}>Note</th>
              </tr>
              <tr>
                {/* WEIGHTING sub-labels — component-matched tints (Burn/Pareto/Exp),
                    sitting at the Wt columns (left of Blend, before the IMPLIED group). */}
                <th style={groupTh(COMP.pureBurn.tint, COMP.pureBurn.line)}>Burn</th>
                <th style={groupTh(COMP.pareto.tint, COMP.pareto.line)}>Pareto</th>
                <th style={groupTh(COMP.exposure.tint, COMP.exposure.line)}>Exp</th>
                {/* Short IMPLIED sub-labels — keep their per-scope column tints. */}
                <th style={groupTh(G.exp, 'var(--accent-amber)')}>Expiring</th>
                <th style={groupTh(G.country, 'var(--accent-blue)')}>Country</th>
                <th style={groupTh(G.region, 'var(--accent-rose)')}>Region</th>
                <th style={groupTh(G.global, 'var(--accent)')}>Global</th>
              </tr>
            </thead>
            <tbody>
              {layers.map((layer, lIdx) => {
                const active = !!layer[scopeKey];
                const editorWrap = (node) => (<div style={{ opacity: active ? 1 : 0.36, pointerEvents: active ? 'auto' : 'none' }}>{node}</div>);
                const blendVal = blendOf(layer);
                const priced = fqPriceLayerOnCurve(layer, quoteCurve?.fit, quoteCurve?.baseEgnpi);
                const impliedExp = priced ? priced.y * 100 : null;
                const blendTxt = blendVal > 0 ? `${blendVal.toFixed(2)}%` : '—';
                return (
                  <tr key={`${scopeKey}-${layer.id || lIdx}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.045)', background: lIdx % 2 ? 'rgba(255,255,255,0.012)' : 'transparent' }}>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <span className="bm-badge" style={{ background: `${scope.color}14`, borderColor: `${scope.color}35`, color: scope.color }}>{lIdx + 1}</span>
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <input type="checkbox" className="np-check" aria-label={`${scope.label} Pricing Structure ${sIdx + 1} Layer ${lIdx + 1}`} checked={active} disabled={disabledByMode} onChange={(e) => updateClientStructureLayer(sIdx, lIdx, scopeKey, e.target.checked)} />
                    </td>
                    <td style={td}><FQReadCell value={fmtMoney(layer.limit)} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                    <td style={td}><FQReadCell value={fmtMoney(layer.attachment)} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                    <td style={td}><FQReadCell value={fmtMoney(layer.egnpi)} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                    {/* Reinstatement terms — layer-level (same value in Risk & Cat tables), always
                        editable. <select> matching the structure screen: blank / 1–10 / Unlimited.
                        Value 'UNLIMITED' must pass through verbatim (no numeric strip) so the save
                        path can preserve the sentinel. */}
                    <td style={{ ...td, background: G.note }}>
                      <select
                        className="bm-cell bm-cell--flat"
                        aria-label={`Structure ${sIdx + 1} Layer ${lIdx + 1} reinstatements`}
                        value={layer.reinstatements ?? ''}
                        onChange={(e) => updateClientStructureLayer(sIdx, lIdx, 'reinstatements', e.target.value)}
                        style={{ width: '100%', boxSizing: 'border-box', color: 'rgba(226,232,240,0.9)', fontSize: 10, padding: '4px 6px', textAlign: 'right', fontFamily: 'inherit' }}>
                        {REINSTATEMENT_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                      </select>
                    </td>
                    <td style={{ ...td, background: G.note }}><FQPctCell value={layer.pctReinst} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, 'pctReinst', v)} /></td>
                    {/* Pure burn / Pareto / exposure are MODEL outputs (engine-calculated):
                        rendered READ-ONLY (the engine ROL%, "—" when zero). The underwriter
                        edits only the weights + final price; the values still round-trip and
                        the Blend below reads these same fields, so the blend math is unchanged. */}
                    <td style={{ ...td, background: COMP.pureBurn.tint }}>{editorWrap(<FQReadCell value={fmtPct(toN(layer[f.pureBurn]))} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" />)}</td>
                    <td style={{ ...td, background: COMP.pareto.tint }}>{editorWrap(<FQReadCell value={fmtPct(toN(layer[f.pareto]))} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" />)}</td>
                    <td style={{ ...td, background: COMP.exposure.tint }}>{editorWrap(<FQReadCell value={fmtPct(toN(layer[f.exposure]))} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" />)}</td>
                    {/* Per-row blend weights — drive THIS row's Blend (no top blender).
                        Each weight is tinted to MATCH the component it weights. */}
                    <td style={{ ...td, background: COMP.pureBurn.tint }}>{editorWrap(wtCell(lIdx, f.wtBurn, layer))}</td>
                    <td style={{ ...td, background: COMP.pareto.tint }}>{editorWrap(wtCell(lIdx, f.wtPareto, layer))}</td>
                    <td style={{ ...td, background: COMP.exposure.tint }}>{editorWrap(wtCell(lIdx, f.wtExp, layer))}</td>
                    <td style={{ ...td, background: G.modelled }}><FQReadCell value={blendTxt} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" /></td>
                    <td style={{ ...td, background: G.exp }}><FQReadCell value={impliedExp != null ? `${impliedExp.toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" /></td>
                    {/* Implied · Country / Region / Global — peer-curve-predicted ROL ("—" when no calibrated pool). */}
                    {[
                      { bg: G.country, fit: scopeFits.country },
                      { bg: G.region, fit: scopeFits.region },
                      { bg: G.global, fit: scopeFits.global },
                    ].map((c, ci) => {
                      const rol = impliedScopeRol(layer, c.fit);
                      return (
                        <td key={`imp-${ci}`} style={{ ...td, background: c.bg }}>
                          <FQReadCell value={rol != null ? `${rol.toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" />
                        </td>
                      );
                    })}
                    <td style={{ ...td, background: G.uw }}>{editorWrap(<FQPctCell value={layer[f.uwPrice]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.uwPrice, v)} placeholder={blendVal > 0 ? `${blendVal.toFixed(2)}%` : '—%'} />)}</td>
                    {/* Engine-written probabilities (read-only). */}
                    <td style={{ ...td, background: G.modelled }}><FQReadCell value={fmtPct(toN(layer[prAttachField]))} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" /></td>
                    <td style={{ ...td, background: G.modelled }}><FQReadCell value={fmtPct(toN(layer[prExhaustField]))} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" /></td>
                    {/* Per-layer free-text note (persists via the save path). */}
                    <td style={{ ...td, background: G.note, textAlign: 'left' }}>
                      <input
                        type="text"
                        value={layer[noteField] || ''}
                        disabled={disabledByMode}
                        placeholder="Note…"
                        aria-label={`${scope.label} Structure ${sIdx + 1} Layer ${lIdx + 1} note`}
                        onChange={(e) => updateClientStructureLayer(sIdx, lIdx, noteField, e.target.value)}
                        style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(5,8,16,0.6)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: 'rgba(226,232,240,0.9)', fontSize: 10, padding: '4px 6px', fontFamily: 'inherit', opacity: disabledByMode ? 0.5 : 1 }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {/* (b) Section Total — per-COLUMN aggregates as the table <tfoot> so
                they stay aligned and scroll horizontally WITH the columns.
                Amounts sum (Limit, EGNPI); rate/% columns are LIMIT-weighted
                averages; non-summable terms show "—". */}
            <tfoot>
              {(() => {
                const ft = { ...td, background: `${scope.color}16`, borderTop: `2px solid ${scope.color}55`, fontWeight: 800, color: 'rgba(226,232,240,0.95)' };
                const dash = '—';
                return (
                  <tr data-testid={`fq-section-total-${scopeKey}`}>
                    <td style={{ ...ft, textAlign: 'center', color: scope.color, letterSpacing: '.08em' }}>TOTAL</td>
                    <td style={{ ...ft, textAlign: 'center' }}>{activeLayers.length || dash}</td>
                    <td style={ft}>{fmtMoney(sumLimit)}</td>
                    <td style={ft}>{dash}</td>
                    <td style={ft}>{fmtMoney(sumEgnpi)}</td>
                    <td style={ft}>{dash}</td>
                    <td style={ft}>{dash}</td>
                    <td style={ft}>{fmtPct(lwAvg((l) => toN(l[f.pureBurn])))}</td>
                    <td style={ft}>{fmtPct(lwAvg((l) => toN(l[f.pareto])))}</td>
                    <td style={ft}>{fmtPct(lwAvg((l) => toN(l[f.exposure])))}</td>
                    <td style={ft}>{dash}</td>
                    <td style={ft}>{dash}</td>
                    <td style={ft}>{dash}</td>
                    <td style={ft}>{fmtPct(lwAvg((l) => blendOf(l)))}</td>
                    <td style={ft}>{fmtPct(lwAvg(impliedExpOf))}</td>
                    <td style={ft}>{fmtPct(lwAvg((l) => impliedScopeRol(l, scopeFits.country)))}</td>
                    <td style={ft}>{fmtPct(lwAvg((l) => impliedScopeRol(l, scopeFits.region)))}</td>
                    <td style={ft}>{fmtPct(lwAvg((l) => impliedScopeRol(l, scopeFits.global)))}</td>
                    <td style={ft}>{fmtPct(lwAvg((l) => toN(l[f.uwPrice])))}</td>
                    <td style={ft}>{fmtPct(lwAvg((l) => toN(l[prAttachField])))}</td>
                    <td style={ft}>{fmtPct(lwAvg((l) => toN(l[prExhaustField])))}</td>
                    <td style={{ ...ft, textAlign: 'left' }}>{dash}</td>
                  </tr>
                );
              })()}
            </tfoot>
          </table>
        </div>
        {/* (c) Notes — persists on structure[`${scopeKey}Notes`] via the save path. */}
        <div style={{ padding: '10px 14px' }}>
          <textarea
            rows={3}
            placeholder={`${scope.label} pricing notes…`}
            value={structure[`${scopeKey}Notes`] || ''}
            onChange={(e) => updateClientStructure(sIdx, `${scopeKey}Notes`, e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(5,8,16,0.6)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: 'rgba(226,232,240,0.9)', fontSize: 11, padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>
      </section>
    );
  };

  const placeholderTab = (title, line) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}>
      <div style={{ maxWidth: 480, textAlign: 'center', background: 'rgba(8,14,30,0.6)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 12, padding: '32px 28px' }}>
        <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '.06em', color: 'rgba(226,232,240,0.9)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.6)', marginTop: 8, lineHeight: 1.5 }}>{line}</div>
      </div>
    </div>
  );

  return (
    <>
    <div className={`bm-modal-backdrop${isQuote ? ' bm-modal-backdrop--fullscreen' : ''}`} role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`bm-modal fq-pa-modal${isQuote ? ' bm-modal--fullscreen' : ''}`}
        style={isQuote
          ? { display: 'grid', gridTemplateRows: 'auto auto 1fr', overflow: 'hidden', background: 'rgb(4, 8, 19)' }
          : { width: '96vw', maxWidth: '1500px', height: '100dvh', maxHeight: '92vh', display: 'grid', gridTemplateRows: 'auto auto 1fr', overflow: 'hidden' }}
      >
        <div className="bm-modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div>Pricing Analysis · Structure {sIdx + 1}</div>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
              Risk and cat layer pricing are analysed separately, then reconciled into the structure totals.
            </div>
          </div>
          <button className="bm-pill" onClick={() => onClose()}>Close</button>
        </div>
        {/* Tab bar — its own grid row, pinned, so the body scrolls under it. */}
        <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid rgba(255,255,255,0.10)', flexShrink: 0 }}>
          {TOP_TABS.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)} style={tabBtn(tab === t.k)}>{t.label}</button>
          ))}
        </div>
        {/* Row 3 = the single vertical scroller. height:100% fills the 1fr track
            and minHeight:0 lets it shrink so overflowY:auto actually scrolls
            (without minHeight:0 the track refuses to shrink and content clips).
            maxHeight:none defeats the shared benchmark modal body's 55vh cap.
            overflowX:hidden keeps the blender bar / section chrome from sliding
            sideways — only each table scrolls horizontally. */}
        <div className="bm-modal-body" style={{ minHeight: 0, height: '100%', maxHeight: 'none', overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 20px' }}>
          {tab === 'pricing' && (
            <>
              {/* ONE tab-level Calculate — runs BOTH Risk + Cat in a single action
                  (not per-section). Pure burn / Pareto / exposure are model outputs;
                  they refresh only here (or the on-open auto-run), so the underwriter
                  controls the overwrite. Weight / Final Price edits never need it. */}
              {layers.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.7)', lineHeight: 1.45 }}>
                    Pure burn, Pareto and exposure are model outputs. Run the engine to refresh both the Risk and Cat sections from the latest losses, Pareto params and profiles.
                  </div>
                  <button
                    type="button"
                    data-testid="fq-calculate-all"
                    onClick={handleCalculateAll}
                    disabled={calculating}
                    title="Run the actuarial engine for every active Risk and Cat layer, then re-blend both sections"
                    style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid rgba(56,189,248,0.55)', background: 'rgba(56,189,248,0.14)', color: '#38bdf8', fontSize: 11, fontWeight: 850, letterSpacing: '.08em', textTransform: 'uppercase', cursor: calculating ? 'default' : 'pointer', whiteSpace: 'nowrap', opacity: calculating ? 0.7 : 1 }}
                  >
                    {calculating ? 'Calculating…' : 'Calculate'}
                  </button>
                </div>
              )}
              {showCalculating && (
                <div data-testid="fq-analysis-calculating" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.28)', color: '#7dd3fc', fontSize: 11, fontWeight: 700, letterSpacing: '.04em' }}>
                  <span aria-hidden="true">⟳</span> Calculating pure burn &amp; exposure…
                </div>
              )}
              {showStaleHint && (
                <div data-testid="fq-analysis-stale-hint" style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.28)', color: 'rgba(251,191,36,0.95)', fontSize: 11, lineHeight: 1.5 }}>
                  Save large/cat losses and risk profile on the earlier NP steps to compute pure burn &amp; exposure.
                </div>
              )}
              {isQuote && calcEngineError && !showCalculating && (
                <div data-testid="fq-analysis-error" style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontSize: 11 }}>
                  {calcEngineError}
                </div>
              )}
              {layers.length === 0 && (
                <div data-testid="fq-analysis-no-layers" style={{ padding: '18px 14px', borderRadius: 8, background: 'rgba(8,14,30,0.6)', border: '1px solid rgba(255,255,255,0.09)', fontSize: 12, color: 'rgba(148,163,184,0.78)' }}>
                  This structure has no layers yet.
                </div>
              )}
              {layers.length > 0 && showRisk && renderScopeSection('risk')}
              {layers.length > 0 && showCat && renderScopeSection('cat')}
              {layers.length > 0 && (showRisk || showCat) && (
                <section style={{ background: 'rgba(8,14,30,0.72)', border: '1px solid rgba(35,209,139,0.28)', borderRadius: 12 }}>
                  <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: '#23d18b' }}>Total Section</div>
                    <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>Combined per-layer pricing (risk + cat) used by the main structure table.</div>
                  </div>
                  <div style={{ overflowX: 'auto', overflowY: 'visible', width: '100%' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820, fontSize: 11 }}>
                      <thead style={{ background: '#050810' }}>
                        <tr>
                          <th style={{ ...th, textAlign: 'center' }}>Layer</th>
                          <th style={th}>Limit</th>
                          <th style={th}>Deductible</th>
                          <th style={th}>Reinstatements</th>
                          <th style={th}>EGNPI</th>
                          <th style={th}>Rate</th>
                          <th style={th}>Earned Premium</th>
                          <th style={th}>ROL</th>
                        </tr>
                      </thead>
                      {(() => {
                        // One row per layer with an active component; limit/egnpi are
                        // counted ONCE per layer (not risk+cat doubled) in the totals.
                        const rows = layers
                          .map((layer, lIdx) => ({ lIdx, c: layerCombined(layer) }))
                          .filter((r) => r.c);
                        const sumLimit = rows.reduce((s, r) => s + r.c.limit, 0);
                        const sumEgnpi = rows.reduce((s, r) => s + r.c.egnpi, 0);
                        const sumEP = rows.reduce((s, r) => s + r.c.earnedPremium, 0);
                        const totRol = sumLimit > 0 ? (sumEP / sumLimit) * 100 : 0;
                        const totRate = sumEgnpi > 0 ? (sumEP / sumEgnpi) * 100 : 0;
                        const ft = { ...td, background: 'rgba(35,209,139,0.12)', borderTop: '2px solid rgba(35,209,139,0.5)', fontWeight: 800, color: 'rgba(226,232,240,0.95)' };
                        return (
                          <>
                            <tbody>
                              {rows.map(({ lIdx, c }) => (
                                <tr key={`combined-${layers[lIdx].id || lIdx}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.045)', background: lIdx % 2 ? 'rgba(255,255,255,0.012)' : 'transparent' }}>
                                  <td style={{ ...td, textAlign: 'center' }}>
                                    <span className="bm-badge" style={{ background: '#23d18b14', borderColor: '#23d18b35', color: '#23d18b' }}>{lIdx + 1}</span>
                                  </td>
                                  <td style={td}>{fmtMoney(c.limit)}</td>
                                  <td style={td}>{fmtMoney(c.deductible)}</td>
                                  <td style={td}>{c.reinst}</td>
                                  <td style={td}>{fmtMoney(c.egnpi)}</td>
                                  <td style={td}>{`${c.rate.toFixed(2)}%`}</td>
                                  <td style={td}>{fmtMoney(c.earnedPremium)}</td>
                                  <td style={td}>{`${c.uwRol.toFixed(2)}%`}</td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr data-testid="fq-total-section-combined">
                                <td style={{ ...ft, textAlign: 'center', color: '#23d18b', letterSpacing: '.08em' }}>TOTAL</td>
                                <td style={ft}>{fmtMoney(sumLimit)}</td>
                                <td style={ft}>—</td>
                                <td style={ft}>—</td>
                                <td style={ft}>{fmtMoney(sumEgnpi)}</td>
                                <td style={ft}>{`${totRate.toFixed(2)}%`}</td>
                                <td style={ft}>{fmtMoney(sumEP)}</td>
                                <td style={ft}>{`${totRol.toFixed(2)}%`}</td>
                              </tr>
                            </tfoot>
                          </>
                        );
                      })()}
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
          {tab === 'pareto' && (
            <>
              {layers.length === 0 && (
                <div data-testid="fq-pareto-no-layers" style={{ padding: '18px 14px', borderRadius: 8, background: 'rgba(8,14,30,0.6)', border: '1px solid rgba(255,255,255,0.09)', fontSize: 12, color: 'rgba(148,163,184,0.78)' }}>
                  This structure has no layers yet.
                </div>
              )}
              {layers.length > 0 && showRisk && (
                <>
                  <SeverityFitPanel
                    scopeKey="risk"
                    structure={structure}
                    contractId={contractId}
                    isQuote={isQuote}
                    onFitChange={setRiskSevFit}
                    savedConfig={structure.riskParetoSim}
                  />
                  <FrequencySimPanel
                    scopeKey="risk"
                    structure={structure}
                    sIdx={sIdx}
                    sevFit={riskSevFit}
                    savedConfig={structure.riskParetoSim}
                    updateClientStructure={updateClientStructure}
                    updateClientStructureLayer={updateClientStructureLayer}
                  />
                </>
              )}
              {layers.length > 0 && showCat && (
                <>
                  <SeverityFitPanel
                    scopeKey="cat"
                    structure={structure}
                    contractId={contractId}
                    isQuote={isQuote}
                    onFitChange={setCatSevFit}
                    savedConfig={structure.catParetoSim}
                  />
                  <FrequencySimPanel
                    scopeKey="cat"
                    structure={structure}
                    sIdx={sIdx}
                    sevFit={catSevFit}
                    savedConfig={structure.catParetoSim}
                    updateClientStructure={updateClientStructure}
                    updateClientStructureLayer={updateClientStructureLayer}
                  />
                </>
              )}
            </>
          )}
          {tab === 'loss' && placeholderTab('Inflation & Loss Manipulation', 'Apply inflation and adjust large/cat loss inputs to stress pricing — coming soon.')}
        </div>
      </div>
    </div>
    <FQFinalPriceModal
      open={!!finalPriceScope}
      scopeKey={finalPriceScope}
      structure={structure}
      sIdx={sIdx}
      updateClientStructureLayer={updateClientStructureLayer}
      save={save}
      doSubmitForApproval={doSubmitForApproval}
      onClose={() => setFinalPriceScope(null)}
    />
    </>
  );
}
