// components/FQFinalPriceModal.jsx — per-scope "Final Price" consolidation.
//
// Opened from a peril section header in the Pricing Analysis modal. Lists the
// scope's ACTIVE layers with the underwriter price (ROL = layer uwPrice) and the
// figures derived from it (Premium = ROL·Limit, Rate = Premium/EGNPI), plus an
// editable per-scope MDP %. "Save" rides the chosen pricing along in the saved
// quote via the existing save() action (clientStructures → quote_np_final_structure);
// it does NOT submit — "Send for Approval" still does that.
import { useState, useEffect } from 'react';
import { formatWithCommas } from '../../../../utils/format';
import { toN } from '../formatters.js';
import { QUOTE_COMPONENT_SCOPES, reinstLabel } from '../fqQuoteMath.js';
import { FQPctCell } from './FQCells.jsx';

// Bare numbers — no currency code (matches the Pricing Analysis tables).
const fmtNum = (n) => (Number.isFinite(n) && n > 0 ? formatWithCommas(String(Math.round(n))) : '—');
const fmtPct = (n, dp = 2) => (n != null && Number.isFinite(n) && n > 0 ? `${n.toFixed(dp)}%` : '—');

/**
 * @param {{
 *   open: boolean,
 *   scopeKey: 'risk' | 'cat' | null,
 *   structure: { layers?: Array<Record<string, unknown>> } | null,
 *   sIdx: number,
 *   updateClientStructureLayer: (sIdx: number, lIdx: number, field: string, value: unknown) => void,
 *   save?: () => Promise<boolean>,
 *   doSubmitForApproval?: () => Promise<void>,
 *   onClose: () => void,
 * }} props
 */
export default function FQFinalPriceModal({ open, scopeKey, structure, sIdx, updateClientStructureLayer, save, doSubmitForApproval, onClose }) {
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  // Reset the confirmation when (re)opened for a scope/structure.
  useEffect(() => { setSaveState('idle'); }, [open, scopeKey, sIdx]);

  if (!open || !scopeKey || !structure) return null;
  const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
  const f = scope.fields;
  const mdpField = scopeKey === 'risk' ? 'riskMdpPct' : 'catMdpPct';
  const allLayers = structure.layers || [];
  // One row per ACTIVE layer of this scope; keep the original layer index for numbering + edits.
  const rows = allLayers
    .map((layer, lIdx) => ({ layer, lIdx }))
    .filter(({ layer }) => !!layer[scopeKey])
    .map(({ layer, lIdx }) => {
      const limit = toN(layer.limit);
      const egnpi = toN(layer.egnpi);
      const rol = toN(layer[f.uwPrice]);                                  // ROL = underwriter price
      const premium = rol > 0 && limit > 0 ? (rol / 100) * limit : 0;     // Premium = ROL·Limit
      const rate = egnpi > 0 && premium > 0 ? (premium / egnpi) * 100 : null; // Rate = Premium/EGNPI
      const mdpPctRaw = layer[mdpField];
      const mdpPct = toN(mdpPctRaw);
      const mdpAmount = mdpPct > 0 && premium > 0 ? (mdpPct / 100) * premium : null;
      return { layer, lIdx, limit, egnpi, rol, premium, rate, mdpPctRaw, mdpAmount };
    });

  const totalPremium = rows.reduce((s, r) => s + r.premium, 0);
  const totalMdp = rows.reduce((s, r) => s + (r.mdpAmount || 0), 0);
  const sumLimit = rows.reduce((s, r) => s + r.limit, 0);
  const wtdRol = sumLimit > 0 ? rows.reduce((s, r) => s + r.limit * r.rol, 0) / sumLimit : 0;
  const busy = saveState === 'saving';
  const noRows = rows.length === 0;

  const doSave = async () => {
    if (busy) return;
    setSaveState('saving');
    try {
      const ok = await save?.();
      if (ok === false) { setSaveState('error'); return; }
      setSaveState('saved');
      setTimeout(() => onClose?.(), 900);
    } catch { setSaveState('error'); }
  };
  const doSaveAndSend = async () => {
    if (busy) return;
    setSaveState('saving');
    try {
      const ok = await save?.();
      if (ok === false) { setSaveState('error'); return; }
      setSaveState('saved');
      await doSubmitForApproval?.();
      onClose?.();
    } catch { setSaveState('error'); }
  };

  const th = { padding: '7px 9px', textAlign: 'right', fontSize: 9, fontWeight: 850, letterSpacing: '.1em', color: 'rgba(148,163,184,0.7)', textTransform: 'uppercase', borderBottom: `2px solid ${scope.color}55`, whiteSpace: 'nowrap', background: '#050810' };
  const td = { padding: '6px 9px', textAlign: 'right', verticalAlign: 'middle', borderBottom: '1px solid rgba(255,255,255,0.05)' };
  const ftd = { ...td, fontWeight: 850, color: scope.color, background: `${scope.color}14`, borderTop: `2px solid ${scope.color}55` };

  return (
    <div className="bm-modal-backdrop" role="presentation" style={{ display: 'flex' }} onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="bm-modal" style={{ width: 'min(1040px, 94vw)', display: 'grid', gridTemplateRows: 'auto minmax(0,1fr) auto' }}>
        <div className="bm-modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div data-testid="fq-final-price-title">Final Price · Structure {sIdx + 1} · <span style={{ color: scope.color }}>{scope.label}</span></div>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
              The underwriter price (ROL) drives Premium and Rate; set MDP % per layer.
            </div>
          </div>
          <button className="bm-pill" onClick={() => onClose?.()}>Close</button>
        </div>
        <div className="bm-modal-body" style={{ minHeight: 0, maxHeight: 'none', overflow: 'auto', padding: '14px 16px' }}>
          {noRows ? (
            <div data-testid="fq-final-price-no-layers" style={{ padding: '18px 4px', fontSize: 12, color: 'rgba(148,163,184,0.78)' }}>
              No active {scope.label} layers in this structure.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'center' }}>Layer</th>
                  <th style={th}>Limit</th>
                  <th style={th}>Deductible</th>
                  <th style={th}>EGNPI</th>
                  <th style={th}>Reinstatements</th>
                  <th style={th}>Rate</th>
                  <th style={th}>Premium</th>
                  <th style={th}>MDP %</th>
                  <th style={th}>MDP Amount</th>
                  <th style={th}>ROL</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ layer, lIdx, limit, egnpi, rol, premium, rate, mdpPctRaw, mdpAmount }) => (
                  <tr key={`fp-${layer.id ?? lIdx}`}>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <span className="bm-badge" style={{ background: `${scope.color}14`, borderColor: `${scope.color}35`, color: scope.color }}>{lIdx + 1}</span>
                    </td>
                    <td style={td}>{fmtNum(limit)}</td>
                    <td style={td}>{fmtNum(toN(layer.attachment))}</td>
                    <td style={td}>{fmtNum(egnpi)}</td>
                    <td style={td}>{reinstLabel(layer.reinstatements, layer.pctReinst)}</td>
                    <td style={td}>{fmtPct(rate, 4)}</td>
                    <td style={td}>{fmtNum(premium)}</td>
                    <td data-testid={`fq-final-price-mdp-${lIdx}`} style={{ ...td, background: 'rgba(148,163,184,0.06)' }}>
                      <FQPctCell value={mdpPctRaw} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, mdpField, v)} />
                    </td>
                    <td style={td}>{mdpAmount != null ? fmtNum(mdpAmount) : '—'}</td>
                    <td style={{ ...td, color: scope.color, fontWeight: 800 }}>{fmtPct(rol, 2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr data-testid="fq-final-price-total">
                  <td style={{ ...ftd, textAlign: 'center' }}>TOTAL</td>
                  <td style={ftd}>{fmtNum(sumLimit)}</td>
                  <td style={ftd}>—</td>
                  <td style={ftd}>—</td>
                  <td style={ftd}>—</td>
                  <td style={ftd}>—</td>
                  <td style={ftd}>{fmtNum(totalPremium)}</td>
                  <td style={ftd}>—</td>
                  <td style={ftd}>{fmtNum(totalMdp)}</td>
                  <td style={ftd}>{fmtPct(wtdRol, 2)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.7)', maxWidth: 470, lineHeight: 1.5 }}>
            Saving stores this as the final price; use Send for Approval to submit for review.
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {saveState === 'saved' && <span data-testid="fq-final-price-saved" style={{ fontSize: 11, fontWeight: 800, color: '#23d18b' }}>✓ Saved</span>}
            {saveState === 'error' && <span style={{ fontSize: 11, fontWeight: 800, color: '#f87171' }}>Save failed</span>}
            {typeof doSubmitForApproval === 'function' && (
              <button className="bm-pill" onClick={doSaveAndSend} disabled={busy || noRows} style={{ opacity: noRows ? 0.5 : 1 }}>
                Save &amp; Send for Approval
              </button>
            )}
            <button className="bm-pill" data-testid="fq-final-price-save" onClick={doSave} disabled={busy || noRows}
              style={{ background: `${scope.color}22`, borderColor: `${scope.color}66`, color: scope.color, fontWeight: 800, opacity: noRows ? 0.5 : 1 }}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
