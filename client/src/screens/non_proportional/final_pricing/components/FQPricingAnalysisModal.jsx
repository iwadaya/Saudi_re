// components/FQPricingAnalysisModal.jsx — Phase 4.1 extraction.
//
// Per-structure "Pricing Analysis" modal: risk + cat component tables
// and the reconciled Total Section. JSX + derivations moved verbatim
// from NpFinalPricing's renderPricingAnalysisModal — props in,
// callbacks out, no logic changes.

import { formatWithCommas } from '../../../../utils/format';
import { toN } from '../formatters.js';
import { QUOTE_COMPONENT_SCOPES, quoteComponentDerived } from '../fqQuoteMath.js';
import { FQPctCell, FQReadCell } from './FQCells.jsx';

/**
 * @param {{
 *   pricingAnalysisModal: { open: boolean, structureIndex: number | null },
 *   clientStructures: Array<object>,
 *   currency: string,
 *   isQuote: boolean,
 *   riskDisabled: boolean,
 *   catDisabled: boolean,
 *   updateClientStructureLayer: (sIdx: number, lIdx: number, field: string, value: unknown) => void,
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
  updateClientStructureLayer,
  onClose,
}) {
    const sIdx = pricingAnalysisModal.structureIndex;
    const structure = Number.isInteger(sIdx) ? clientStructures[sIdx] : null;
    if (!pricingAnalysisModal.open || !structure) return null;

    const fmtMoney = (value) => {
      const n = toN(value);
      return n > 0 ? `${currency ? `${currency} ` : ''}${formatWithCommas(String(Math.round(n)))}` : '—';
    };
    const componentTotals = (scopeKey) => {
      const activeLayers = (structure.layers || []).filter((layer) => !!layer[scopeKey]);
      const totalLimit = activeLayers.reduce((s, layer) => s + toN(layer.limit), 0);
      const premium = activeLayers.reduce((s, layer) => {
        const limit = toN(layer.limit);
        const rol = quoteComponentDerived(layer, scopeKey).totalRol;
        return s + (limit > 0 && rol > 0 ? limit * rol / 100 : 0);
      }, 0);
      return {
        activeCount: activeLayers.length,
        totalLimit,
        premium,
        wtdRol: totalLimit > 0 ? (premium / totalLimit) * 100 : 0,
      };
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

    const th = {
      padding: '8px 10px',
      textAlign: 'right',
      fontSize: 9,
      fontWeight: 850,
      letterSpacing: '.11em',
      color: 'rgba(148,163,184,0.68)',
      textTransform: 'uppercase',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      whiteSpace: 'nowrap',
    };
    const td = { padding: '7px 8px', textAlign: 'right', verticalAlign: 'middle' };

    const renderScopeSection = (scopeKey) => {
      const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
      const f = scope.fields;
      const disabledByMode = scopeKey === 'risk' ? riskDisabled : catDisabled;
      return (
        <section key={scopeKey} style={{ background: 'rgba(8,14,30,0.72)', border: `1px solid ${scope.color}35`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: scope.color }}>
                {scope.label} Pricing Analysis
              </div>
              <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>
                Edit component metrics here; the main structure table updates from these totals.
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(226,232,240,0.75)', fontWeight: 750 }}>
              Wtd ROL {componentTotals(scopeKey).wtdRol > 0 ? `${componentTotals(scopeKey).wtdRol.toFixed(2)}%` : '—'}
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1180, fontSize: 11 }}>
              <thead style={{ background: '#050810' }}>
                <tr>
                  {['Layer', 'Active', 'Limit', 'Deductible', 'Pure Burn', 'Pareto', 'Exposure', 'Wt Burn %', 'Wt Pareto %', 'Wt Exp %', 'Loading %', 'Total ROL', 'UW Price'].map((h, i) => (
                    <th key={`${scopeKey}-${h}`} style={{ ...th, textAlign: i < 2 ? 'center' : 'right' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(structure.layers || []).map((layer, lIdx) => {
                  const active = !!layer[scopeKey];
                  const d = quoteComponentDerived(layer, scopeKey);
                  const editorWrap = (node) => (
                    <div style={{ opacity: active ? 1 : 0.36, pointerEvents: active ? 'auto' : 'none' }}>{node}</div>
                  );
                  return (
                    <tr key={`${scopeKey}-${layer.id || lIdx}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.045)', background: lIdx % 2 ? 'rgba(255,255,255,0.012)' : 'transparent' }}>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <span className="bm-badge" style={{ background: `${scope.color}14`, borderColor: `${scope.color}35`, color: scope.color }}>{lIdx + 1}</span>
                      </td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          className="np-check"
                          aria-label={`${scope.label} Pricing Structure ${sIdx + 1} Layer ${lIdx + 1}`}
                          checked={active}
                          disabled={disabledByMode}
                          onChange={(e) => updateClientStructureLayer(sIdx, lIdx, scopeKey, e.target.checked)}
                        />
                      </td>
                      <td style={td}><FQReadCell value={fmtMoney(layer.limit)} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                      <td style={td}><FQReadCell value={fmtMoney(layer.attachment)} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.pureBurn]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.pureBurn, v)} />)}</td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.pareto]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.pareto, v)} />)}</td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.exposure]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.exposure, v)} />)}</td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.wtBurn]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.wtBurn, v)} />)}</td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.wtPareto]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.wtPareto, v)} />)}</td>
                      <td style={td}><FQReadCell value={`${d.wtExp.toFixed(0)}%`} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" /></td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.loading]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.loading, v)} />)}</td>
                      <td style={td}><FQReadCell value={d.totalRol > 0 ? `${d.totalRol.toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--accent bm-calc" /></td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.uwPrice]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.uwPrice, v)} placeholder={d.totalRol > 0 ? `${d.totalRol.toFixed(2)}%` : '—%'} />)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      );
    };

    return (
      <div className="bm-modal-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div
          className="bm-modal"
          style={isQuote
            ? { width: '100vw', height: '100vh', maxWidth: 'none', maxHeight: 'none', borderRadius: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }
            : { width: '96vw', maxWidth: '1500px', maxHeight: '92vh', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}
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
          <div className="bm-modal-body" style={{ minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 20px' }}>
            {renderScopeSection('risk')}
            {renderScopeSection('cat')}
            <section style={{ background: 'rgba(8,14,30,0.72)', border: '1px solid rgba(35,209,139,0.28)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: '#23d18b' }}>Total Section</div>
                <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>Combined component premium and weighted ROL used by the main structure table.</div>
              </div>
              <div style={{ overflowX: 'auto' }}>
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
          </div>
        </div>
      </div>
    );
}
