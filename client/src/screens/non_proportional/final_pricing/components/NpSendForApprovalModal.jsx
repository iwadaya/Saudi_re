// components/NpSendForApprovalModal.jsx
//
// Per-structure "Send for Approval" review. Opened from the structure card's
// "Send for Approval" action. Everything shown is READ-ONLY and read straight
// from existing state — no pricing is recomputed here:
//   • Final structure + pricing: one row per active layer using the SAME
//     combined risk+cat derivation as the Pricing Analysis Total Section
//     (layerCombinedPricing), plus the structure total. MDP % is the one
//     EDITABLE cell (default 85); MDP Amount = EP x MDP % / 100 (read-only).
//   • Underwriting limits + COB×layer coverage via FQCobParticipationTable in
//     read-only mode (which classes participate in which layer, each COB limit).
//
// The only editable inputs are the structure-level participation terms:
//   • "Indicative quote" checkbox → structure.quoteType ('INDICATIVE' | 'LEAD').
//   • LEAD (default): Lead Line % enabled; Follow Line % hidden.
//   • INDICATIVE: Lead Line % disabled/greyed; Follow Line % shown.
// A single value 0–100 across the whole structure (not per layer).
//
// "Add to Submission" marks the structure selected_for_approval = true, persists
// quoteType + the active line via save(), then closes.

import { useState, useRef, useEffect } from 'react';
import { toN } from '../formatters.js';
import { formatWithCommas } from '../../../../utils/format';
import { layerCombinedPricing } from '../fqQuoteMath.js';
import FQCobParticipationTable from './FQCobParticipationTable.jsx';
import { FQPctCell } from './FQCells.jsx';

const ACCENT = '#23d18b';
const noop = () => {};

// 0–100 percentage entry: strip non-numeric, clamp to 100, keep trailing
// dot/decimals while typing.
const sanitizePct = (raw) => {
  const cleaned = String(raw ?? '').replace(/[^0-9.]/g, '');
  if (cleaned === '') return '';
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 100 ? '100' : cleaned;
};

/**
 * @param {{
 *   open: boolean,
 *   sIdx: number | null,
 *   structure: Record<string, unknown> | null,
 *   currency: string,
 *   selectedCobs: Array<{ id: string|number, name: string }>,
 *   getCobFlags: (scope: string, cobId: string|number, layers: Array<object>) => boolean[],
 *   getCobUwLimit: (scope: string, cobId: string|number) => string,
 *   approvedStructures: boolean[],
 *   setApprovedQuoteStructure: (index: number, checked: boolean) => void,
 *   updateClientStructure: (sIdx: number, field: string, value: unknown) => void,
 *   updateClientStructureLayer: (sIdx: number, lIdx: number, field: string, value: unknown) => void,
 *   save: (options?: object) => Promise<boolean>,
 *   onClose: () => void,
 * }} props
 */
export default function NpSendForApprovalModal({
  open,
  sIdx,
  structure,
  currency,
  selectedCobs,
  getCobFlags,
  getCobUwLimit,
  approvedStructures,
  setApprovedQuoteStructure,
  updateClientStructure,
  updateClientStructureLayer,
  save,
  onClose,
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // One-shot guard: set when "Add to Submission" is clicked. The actual save
  // runs from the effect below — AFTER setApprovedQuoteStructure has committed —
  // so save()'s closure sees the new approval (+ the already-committed quoteType
  // / line edits) instead of stale state.
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!pendingRef.current) return undefined;
    pendingRef.current = false;
    let cancelled = false;
    (async () => {
      let ok = false;
      try { ok = await save(); } catch { ok = false; }
      if (cancelled) return;
      setSubmitting(false);
      if (ok === false) setError('Save failed — please try again.');
      else onClose();
    })();
    return () => { cancelled = true; };
    // Fires when the approval array gets a fresh reference (the reducer always
    // returns a new array), i.e. right after setApprovedQuoteStructure commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvedStructures]);

  if (!open || sIdx == null || !structure) return null;

  const layers = Array.isArray(structure.layers) ? structure.layers : [];
  const isIndicative = structure.quoteType === 'INDICATIVE';
  const scope = structure.id ? String(structure.id) : `quote-structure-${sIdx + 1}`;

  const fmtMoney = (value) => {
    const n = toN(value);
    return n > 0 ? formatWithCommas(String(Math.round(n))) : '—';
  };
  const fmtPct = (n) => `${(Number.isFinite(n) ? n : 0).toFixed(2)}%`;

  const rows = layers
    .map((layer, lIdx) => ({ lIdx, c: layerCombinedPricing(layer) }))
    .filter((r) => r.c);
  const sumLimit = rows.reduce((s, r) => s + r.c.limit, 0);
  const sumEgnpi = rows.reduce((s, r) => s + r.c.egnpi, 0);
  const sumEP = rows.reduce((s, r) => s + r.c.earnedPremium, 0);
  const sumMdp = rows.reduce((s, r) => s + r.c.mdpAmount, 0);
  const totRol = sumLimit > 0 ? (sumEP / sumLimit) * 100 : 0;
  const totRate = sumEgnpi > 0 ? (sumEP / sumEgnpi) * 100 : 0;
  const totMdpPct = sumEP > 0 ? (sumMdp / sumEP) * 100 : 0;   // weighted, like LayerTableCard

  // The one editable cell in this read-only table: set mdp_pct AND keep mdp in
  // sync (mdp = EP x mdp_pct / 100) on the layer, mirroring LayerTableCard.
  const onMdpPctChange = (lIdx, c, raw) => {
    updateClientStructureLayer(sIdx, lIdx, 'mdpPct', raw);
    const amt = c.earnedPremium * toN(raw) / 100;
    updateClientStructureLayer(sIdx, lIdx, 'mdp', amt > 0 ? String(Math.round(amt)) : '');
  };

  const onAddToSubmission = () => {
    if (submitting) return;
    setError('');
    setSubmitting(true);
    pendingRef.current = true;
    // New approval array reference → triggers the effect, which then saves.
    setApprovedQuoteStructure(sIdx, true);
  };

  const th = { padding: '8px 10px', textAlign: 'right', fontSize: 9, fontWeight: 850, letterSpacing: '.11em', color: 'rgba(148,163,184,0.68)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap', background: '#050810' };
  const td = { padding: '7px 9px', textAlign: 'right', verticalAlign: 'middle', borderBottom: '1px solid rgba(255,255,255,0.045)' };
  const ft = { ...td, background: 'rgba(35,209,139,0.12)', borderTop: `2px solid ${ACCENT}80`, fontWeight: 800, color: 'rgba(226,232,240,0.95)' };
  const sectionTitle = { fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: ACCENT };
  const lineInput = (value, disabled, onChange) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: disabled ? 0.45 : 1 }}>
      <input
        type="text"
        inputMode="decimal"
        value={value ?? ''}
        disabled={disabled}
        placeholder="—"
        onChange={(e) => onChange(sanitizePct(e.target.value))}
        style={{ width: 90, boxSizing: 'border-box', background: 'rgba(5,8,16,0.6)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, color: 'rgba(226,232,240,0.95)', fontSize: 13, fontWeight: 700, padding: '6px 9px', textAlign: 'right', fontFamily: 'inherit' }}
      />
      <span style={{ fontSize: 12, color: 'rgba(148,163,184,0.7)', fontWeight: 700 }}>%</span>
    </span>
  );

  return (
    <div className="bm-modal-backdrop bm-modal-backdrop--fullscreen" role="presentation" style={{ display: 'flex' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bm-modal bm-modal--fullscreen" style={{ display: 'grid', gridTemplateRows: 'auto minmax(0,1fr) auto', overflow: 'hidden' }}>
        <div className="bm-modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div data-testid="np-send-approval-title">Send for Approval · <span style={{ color: ACCENT }}>Structure {sIdx + 1}</span></div>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
              Review the final structure, pricing and participation, then add it to the approval submission.
            </div>
          </div>
          <button className="bm-pill" onClick={() => onClose()}>Close</button>
        </div>

        <div className="bm-modal-body" style={{ minHeight: 0, maxHeight: 'none', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14, padding: '14px 16px' }}>
          {/* ── Final structure + pricing (read-only) ── */}
          <section style={{ background: 'rgba(8,14,30,0.72)', border: `1px solid ${ACCENT}28`, borderRadius: 12 }}>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={sectionTitle}>Final Structure &amp; Pricing</div>
              <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>Combined per-layer pricing (risk + cat) — read-only.</div>
            </div>
            <div style={{ overflowX: 'auto', overflowY: 'visible', width: '100%' }}>
              {rows.length === 0 ? (
                <div data-testid="np-send-approval-no-layers" style={{ padding: '16px 14px', fontSize: 12, color: 'rgba(148,163,184,0.75)' }}>
                  No active layers in this structure.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980, fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: 'center' }}>Layer</th>
                      <th style={th}>Limit</th>
                      <th style={th}>Deductible</th>
                      <th style={th}>Reinstatements</th>
                      <th style={th}>EGNPI</th>
                      <th style={th}>Rate</th>
                      <th style={th}>Earned Premium</th>
                      <th style={{ ...th, width: 88, minWidth: 88 }}>MDP %</th>
                      <th style={th}>MDP Amount</th>
                      <th style={th}>UW ROL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ lIdx, c }) => (
                      <tr key={`sfa-${layers[lIdx].id || lIdx}`} style={{ background: lIdx % 2 ? 'rgba(255,255,255,0.012)' : 'transparent' }}>
                        <td style={{ ...td, textAlign: 'center' }}>
                          <span className="bm-badge" style={{ background: `${ACCENT}14`, borderColor: `${ACCENT}35`, color: ACCENT }}>{lIdx + 1}</span>
                        </td>
                        <td style={td}>{fmtMoney(c.limit)}</td>
                        <td style={td}>{fmtMoney(c.deductible)}</td>
                        <td style={td}>{c.reinst}</td>
                        <td style={td}>{fmtMoney(c.egnpi)}</td>
                        <td style={td}>{fmtPct(c.rate)}</td>
                        <td style={td}>{fmtMoney(c.earnedPremium)}</td>
                        <td style={{ ...td, width: 88, minWidth: 88, padding: '4px 6px' }}>
                          <FQPctCell value={String(c.mdpPct)} onChange={(v) => onMdpPctChange(lIdx, c, v)} />
                        </td>
                        <td style={td}>{fmtMoney(c.mdpAmount)}</td>
                        <td style={td}>{fmtPct(c.uwRol)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr data-testid="np-send-approval-total">
                      <td style={{ ...ft, textAlign: 'center', color: ACCENT, letterSpacing: '.08em' }}>TOTAL</td>
                      <td style={ft}>{fmtMoney(sumLimit)}</td>
                      <td style={ft}>—</td>
                      <td style={ft}>—</td>
                      <td style={ft}>{fmtMoney(sumEgnpi)}</td>
                      <td style={ft}>{fmtPct(totRate)}</td>
                      <td style={ft}>{fmtMoney(sumEP)}</td>
                      <td style={ft}>{fmtPct(totMdpPct)}</td>
                      <td style={ft}>{fmtMoney(sumMdp)}</td>
                      <td style={ft}>{fmtPct(totRol)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </section>

          {/* ── Underwriting limits + COB × layer coverage (read-only) ── */}
          <FQCobParticipationTable
            scope={scope}
            tableLayers={layers}
            title="Underwriting Limits &amp; Layer Participation"
            hint="Classes covered in each layer and the underwriting limit per class — read-only review."
            currency={currency}
            selectedCobs={selectedCobs}
            getCobFlags={getCobFlags}
            getCobUwLimit={getCobUwLimit}
            updateUwLimit={noop}
            setCobToggle={noop}
            readOnly
          />

          {/* ── Participation (single % across the structure) ── */}
          <section style={{ background: 'rgba(8,14,30,0.72)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 12, padding: '12px 14px' }}>
            <div style={sectionTitle}>Participation</div>
            <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2, marginBottom: 12 }}>
              One line for the whole structure. Lead by default; tick “Indicative quote” to give a follow line instead.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'rgba(226,232,240,0.9)' }}>
                <input
                  type="checkbox"
                  className="np-check"
                  data-testid="np-send-approval-indicative"
                  checked={isIndicative}
                  onChange={(e) => updateClientStructure(sIdx, 'quoteType', e.target.checked ? 'INDICATIVE' : 'LEAD')}
                  style={{ margin: 0 }}
                />
                Indicative quote
              </label>

              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: isIndicative ? 'rgba(148,163,184,0.45)' : 'rgba(148,163,184,0.8)' }}>Lead Line</span>
                {lineInput(structure.leadLinePct, isIndicative, (v) => updateClientStructure(sIdx, 'leadLinePct', v))}
              </div>

              {isIndicative && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.8)' }}>Follow Line</span>
                  {lineInput(structure.followLinePct, false, (v) => updateClientStructure(sIdx, 'followLinePct', v))}
                </div>
              )}
            </div>
          </section>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.7)', maxWidth: 520, lineHeight: 1.5 }}>
            Adds this structure to the Chief Underwriter submission and queues it alongside the others.
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {error && <span style={{ fontSize: 11, fontWeight: 800, color: '#f87171' }}>{error}</span>}
            <button className="bm-pill" onClick={() => onClose()} disabled={submitting}>Cancel</button>
            <button
              className="bm-pill"
              data-testid="np-send-approval-add"
              onClick={onAddToSubmission}
              disabled={submitting}
              style={{ background: `${ACCENT}22`, borderColor: `${ACCENT}66`, color: ACCENT, fontWeight: 850 }}
            >
              {submitting ? 'Adding…' : 'Add to Submission'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
