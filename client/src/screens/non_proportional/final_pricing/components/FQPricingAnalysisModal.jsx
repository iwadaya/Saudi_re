// components/FQPricingAnalysisModal.jsx — 3-tab pricing workbench.
//
// Tab 1 "Pricing Analysis": per-peril sections (Risk above Cat) stacked
// vertically, each with a weight Blender bar, a metrics table, and a notes
// box; a reconciled Total Section is shown only when both perils are active.
// Tabs 2/3 ("Pareto Simulation", "Inflation & Loss") are placeholders.
import { useState, useEffect, useMemo, useRef } from 'react';
import { formatWithCommas } from '../../../../utils/format';
import { toN } from '../formatters.js';
import { QUOTE_COMPONENT_SCOPES, quoteComponentDerived } from '../fqQuoteMath.js';
import { fqPriceLayerOnCurve, fqFitPowerLaw, fqPeerToXY, fqGeomean } from '../fqHelpers.js';
import { api } from '../../../../api';
import { FQPctCell, FQReadCell } from './FQCells.jsx';

const TOP_TABS = [
  { k: 'pricing', label: 'Pricing Analysis' },
  { k: 'pareto', label: 'Pareto Simulation' },
  { k: 'loss', label: 'Inflation & Loss' },
];

// Subtle background tints that band the table into Modelled / Implied-Expiring /
// Implied-Market / UW groups.
const G = {
  modelled: 'rgba(74,222,128,0.06)',
  exp: 'rgba(245,158,11,0.08)',
  country: 'rgba(0,212,255,0.08)',
  region: 'rgba(167,139,250,0.08)',
  global: 'rgba(74,222,128,0.08)',
  uw: 'rgba(0,212,255,0.08)',
  note: 'rgba(148,163,184,0.06)',
};

/**
 * @param {{
 *   pricingAnalysisModal: { open: boolean, structureIndex: number | null },
 *   clientStructures: Array<object>,
 *   currency: string,
 *   isQuote: boolean,
 *   riskDisabled: boolean,
 *   catDisabled: boolean,
 *   quoteCurve: object,
 *   contractId?: string,   // reserved for the Implied · Country/Region/Global columns (next prompt)
 *   cobIds?: string[],     // reserved (peer fetch) for the implied-market columns
 *   runQuoteCalcEngine?: (structureIndex?: number | null) => void,
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
  currency,
  isQuote,
  riskDisabled,
  catDisabled,
  quoteCurve,
  contractId,
  cobIds,
  runQuoteCalcEngine,
  calcEngineRunning,
  runningStructures,
  calcEngineError,
  updateClientStructureLayer,
  updateClientStructure,
  onClose,
}) {
  const [tab, setTab] = useState('pricing');
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
  // The modal reads engine-computed pure burn / exposure straight off the
  // layer rows (riskPureBurn/catPureBurn, riskExposure/catExposure). Those
  // only populate after a calc run, so a freshly-opened structure that hasn't
  // been calc'd yet would show blank cells. When the modal opens for a quote
  // structure whose layers carry no engine results yet, kick `runQuoteCalcEngine`
  // ONCE so the same numbers a bound treaty computes land here too. Guards:
  //   • only quote mode, only when an engine fn is wired in
  //   • skip if a calc for this structure is already in flight
  //   • skip if results already exist (don't clobber / re-run)
  //   • one shot per open (autoRunKeyRef), reset when the modal closes
  // If the run finds no saved inputs the cells stay "—" and an inline hint
  // points the user at the earlier NP steps. We never auto-run on keystrokes —
  // only on open while the structure is stale/empty.
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
    if (!modalOpen) { autoRunKeyRef.current = null; setAutoRan(false); }
  }, [modalOpen]);
  useEffect(() => {
    if (!modalOpen || !isQuote || typeof runQuoteCalcEngine !== 'function') return;
    if (!Number.isInteger(sIdx) || !structure) return;
    const key = String(sIdx);
    if (autoRunKeyRef.current === key) return;       // already handled this open/target
    if (calcRunningForStructure) return;             // a calc is in flight — let it finish
    if (hasEngineResults) { autoRunKeyRef.current = key; return; } // results exist — no run
    autoRunKeyRef.current = key;
    setAutoRan(true);
    runQuoteCalcEngine(sIdx);
  }, [modalOpen, isQuote, runQuoteCalcEngine, sIdx, structure, hasEngineResults, calcRunningForStructure]);
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
  const fmtMoney = (value) => {
    const n = toN(value);
    return n > 0 ? `${currency ? `${currency} ` : ''}${formatWithCommas(String(Math.round(n)))}` : '—';
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
  const bothShown = showRisk && showCat;

  // ── Total Section (reconciled) — unchanged from the prior modal. ──
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
  const riskTotal = componentTotals('risk');
  const catTotal = componentTotals('cat');
  const grandLimit = riskTotal.totalLimit + catTotal.totalLimit;
  const grandPremium = riskTotal.premium + catTotal.premium;
  const grandTotal = {
    activeCount: riskTotal.activeCount + catTotal.activeCount,
    totalLimit: grandLimit,
    premium: grandPremium,
    wtdRol: grandLimit > 0 ? (grandPremium / grandLimit) * 100 : 0,
  };

  const th = { padding: '8px 10px', textAlign: 'right', fontSize: 9, fontWeight: 850, letterSpacing: '.11em', color: 'rgba(148,163,184,0.68)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap' };
  const td = { padding: '7px 8px', textAlign: 'right', verticalAlign: 'middle' };
  const groupTh = (bg, underline) => ({ ...th, background: bg, borderBottom: `2px solid ${underline}` });
  const tabBtn = (active) => ({ padding: '10px 16px', background: active ? 'rgba(0,212,255,0.08)' : 'transparent', border: 'none', borderBottom: active ? '2px solid #00d4ff' : '2px solid transparent', color: active ? '#00d4ff' : 'rgba(226,232,240,0.65)', fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', cursor: 'pointer' });

  const renderScopeSection = (scopeKey) => {
    const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
    const f = scope.fields;
    // Engine-written probability fields + the per-layer note field live
    // outside scope.fields (rendered as their own columns right of UW Price).
    const prAttachField  = scopeKey === 'risk' ? 'riskPrAttach'  : 'catPrAttach';
    const prExhaustField = scopeKey === 'risk' ? 'riskPrExhaust' : 'catPrExhaust';
    const noteField      = `${scopeKey}LayerNote`;
    // Fixed column widths (table-layout: fixed) so the 17 columns don't crush;
    // the table scrolls horizontally inside its own wrapper when narrower.
    const COLW = [56, 64, 116, 116, 124, 92, 80, 92, 80, 116, 108, 108, 108, 104, 92, 96, 190];
    const TABLE_MIN_W = COLW.reduce((s, w) => s + w, 0);
    const disabledByMode = scopeKey === 'risk' ? riskDisabled : catDisabled;
    const layer0 = layers[0] || {};
    // Blender weights live at peril level (read from layer 0); defaults 50/0/50.
    const wOf = (field, dflt) => (layer0[field] != null && layer0[field] !== '' ? toN(layer0[field]) : dflt);
    const burnW = wOf(f.wtBurn, 50);
    const paretoW = wOf(f.wtPareto, 0);
    const expW = wOf(f.wtExp, 50);
    const wSum = burnW + paretoW + expW;
    const valid = Math.round(wSum * 100) / 100 === 100;
    // Any weight change writes to EVERY layer of this peril so the engine and
    // the main-table footer stay consistent.
    const setWeight = (field, raw) => {
      const value = raw.replace(/[^0-9.]/g, '');
      layers.forEach((_, lIdx) => updateClientStructureLayer(sIdx, lIdx, field, value));
    };
    const blendOf = (layer) => {
      const denom = burnW + paretoW + expW;
      return denom > 0 ? (burnW * toN(layer[f.pureBurn]) + paretoW * toN(layer[f.pareto]) + expW * toN(layer[f.exposure])) / denom : 0;
    };
    const wInput = (label, val, field) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.7)', whiteSpace: 'nowrap' }}>{label}</span>
        <input type="text" inputMode="decimal" className="bm-cell bm-cell--sm" style={{ width: 60, opacity: disabledByMode ? 0.5 : 1 }}
          value={val} disabled={disabledByMode} onChange={(e) => setWeight(field, e.target.value)} />
      </div>
    );
    return (
      <section key={scopeKey} style={{ background: 'rgba(8,14,30,0.72)', border: `1px solid ${scope.color}35`, borderRadius: 12, overflow: 'visible', flexShrink: 0, minWidth: 0 }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: scope.color }}>{scope.label} Pricing Analysis</div>
            <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>Edit component metrics here; the main structure table updates from these totals.</div>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(226,232,240,0.75)', fontWeight: 750 }}>Wtd ROL {fmtPct(componentTotals(scopeKey).wtdRol)}</div>
        </div>
        {/* (a) Blender bar — three directly-editable weights + live Σ. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: G.modelled }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.6)' }}>Blend weights</span>
          {wInput('Pure Burn %', burnW, f.wtBurn)}
          {wInput('Pareto %', paretoW, f.wtPareto)}
          {wInput('Exposure %', expW, f.wtExp)}
          <span style={{ fontSize: 11, fontWeight: 800, color: valid ? '#23d18b' : '#f87171' }}>Σ = {Math.round(wSum)}%</span>
          {!valid && <span style={{ fontSize: 10, color: '#f87171' }}>weights must total 100%</span>}
        </div>
        {/* Only the table scrolls horizontally; the header, blender bar and
            notes textarea stay full-width. */}
        <div style={{ overflowX: 'auto', width: '100%' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: TABLE_MIN_W, tableLayout: 'fixed', fontSize: 11 }}>
            <colgroup>{COLW.map((w, ci) => (<col key={`col-${ci}`} style={{ width: w }} />))}</colgroup>
            <thead style={{ background: '#050810' }}>
              <tr>
                <th style={{ ...th, textAlign: 'center' }}>Layer</th>
                <th style={{ ...th, textAlign: 'center' }}>Active</th>
                <th style={th}>Limit</th>
                <th style={th}>Deductible</th>
                <th style={th}>EGNPI</th>
                <th style={groupTh(G.modelled, '#4ade80')}>Pure Burn</th>
                <th style={groupTh(G.modelled, '#4ade80')}>Pareto</th>
                <th style={groupTh(G.modelled, '#4ade80')}>Exposure</th>
                <th style={groupTh(G.modelled, '#4ade80')}>Blend</th>
                <th style={groupTh(G.exp, '#f59e0b')}>Implied · Expiring</th>
                {/* NOTE: Implied · Country/Region/Global placeholders — populated in the next prompt. */}
                <th style={groupTh(G.country, '#00d4ff')}>Implied · Country</th>
                <th style={groupTh(G.region, '#a78bfa')}>Implied · Region</th>
                <th style={groupTh(G.global, '#4ade80')}>Implied · Global</th>
                <th style={groupTh(G.uw, '#00d4ff')}>UW Price</th>
                <th style={groupTh(G.modelled, '#4ade80')}>P(Attach)</th>
                <th style={groupTh(G.modelled, '#4ade80')}>P(Exhaust)</th>
                <th style={{ ...groupTh(G.note, 'rgba(148,163,184,0.45)'), textAlign: 'left' }}>Note</th>
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
                    <td style={{ ...td, background: G.modelled }}>{editorWrap(<FQPctCell value={layer[f.pureBurn]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.pureBurn, v)} />)}</td>
                    <td style={{ ...td, background: G.modelled }}>{editorWrap(<FQPctCell value={layer[f.pareto]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.pareto, v)} />)}</td>
                    <td style={{ ...td, background: G.modelled }}>{editorWrap(<FQPctCell value={layer[f.exposure]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.exposure, v)} />)}</td>
                    <td style={{ ...td, background: G.modelled, opacity: valid ? 1 : 0.5 }}><FQReadCell value={blendTxt} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" /></td>
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
    <div className="bm-modal-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="bm-modal"
        style={isQuote
          ? { width: '100vw', height: '100dvh', maxWidth: 'none', maxHeight: 'none', borderRadius: 0, display: 'grid', gridTemplateRows: 'auto auto 1fr' }
          : { width: '96vw', maxWidth: '1500px', height: '100dvh', maxHeight: '92vh', display: 'grid', gridTemplateRows: 'auto auto 1fr' }}
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
        <div className="bm-modal-body" style={{ minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 20px' }}>
          {tab === 'pricing' && (
            <>
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
              {layers.length > 0 && bothShown && (
                <section style={{ background: 'rgba(8,14,30,0.72)', border: '1px solid rgba(35,209,139,0.28)', borderRadius: 12, overflow: 'visible', flexShrink: 0, minWidth: 0 }}>
                  <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: '#23d18b' }}>Total Section</div>
                    <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>Combined component premium and weighted ROL used by the main structure table.</div>
                  </div>
                  <div style={{ overflowX: 'auto', width: '100%' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760, fontSize: 11 }}>
                      <thead style={{ background: '#050810' }}>
                        <tr>
                          {['Component', 'Active Layers', 'Limit', 'Premium', 'Weighted ROL'].map((h, i) => (
                            <th key={`total-${h}`} style={{ ...th, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          { label: 'Risk', color: QUOTE_COMPONENT_SCOPES.risk.color, ...riskTotal },
                          { label: 'Cat', color: QUOTE_COMPONENT_SCOPES.cat.color, ...catTotal },
                          { label: 'Total', color: '#23d18b', ...grandTotal },
                        ].map((row) => (
                          <tr key={`total-${row.label}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.045)' }}>
                            <td style={{ padding: '8px 10px', color: row.color, fontWeight: 850 }}>{row.label}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right' }}>{row.activeCount || '—'}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(row.totalLimit)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(row.premium)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: row.color, fontWeight: 850 }}>{row.wtdRol > 0 ? `${row.wtdRol.toFixed(2)}%` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
          {tab === 'pareto' && placeholderTab('Pareto Simulation', 'Adjust large-loss and cat Pareto parameters (alpha, threshold, severity) and see pricing update live — coming soon.')}
          {tab === 'loss' && placeholderTab('Inflation & Loss Manipulation', 'Apply inflation and adjust large/cat loss inputs to stress pricing — coming soon.')}
        </div>
      </div>
    </div>
  );
}
