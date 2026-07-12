// components/ExpiringStructureCard.jsx — Expiring Structure & Terms card.
// Extracted verbatim from NpStructure.jsx (Phase 4.2): props in, callbacks
// out. Expiring recalc math lives in state/structureReducer.ts; totals here
// are render-local and pinned by goldenMaster.test.jsx.
import { toNum, rateToFloat, fmtPctMaybe, CommaInput, RateInput, PctInput } from '../NpStructureHelpers';

export default function ExpiringStructureCard({
  expiringLayerCount, expiringLayers, expiringTerms,
  isRenewal, expiringAutoPopulated,
  currency, reinstatementOptions,
  onUpdateLayer, onUpdateTerm, onEnableOverride, onShowCurve, onPaste,
}) {
  return (
    <section className="np-struct-card glass">
      <div className="np-struct-card-header np-struct-card-header--plain">
        <div>
          <div className="np-struct-card-h2">Expiring Structure &amp; Terms</div>
          <div className="np-struct-card-hint">
            {isRenewal
              ? expiringAutoPopulated
                ? '⟳ Auto-populated from prior year contract. Fields are read-only — click Override to edit manually.'
                : '✓ Loaded from prior year contract. You may edit fields below.'
              : 'New business — enter expiring market terms manually for YoY comparison in pricing metrics.'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="np-green-pill"
            style={{ fontSize: 11 }}
            onClick={onShowCurve}>
            ◈ VIEW IMPLIED PRICING CURVE
          </button>
          {isRenewal && expiringAutoPopulated && (
            <button
              className="np-struct-btn np-struct-btn--ghost"
              style={{ fontSize: 11 }}
              onClick={onEnableOverride}>
              Override
            </button>
          )}
          <span style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.58)', whiteSpace: 'nowrap' }}>
            Layers
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(var(--text-rgb),0.75)', minWidth: 24, textAlign: 'center' }}>
            {expiringLayerCount || '—'}
          </span>
        </div>
      </div>

      {/* Renewal auto-populate notice */}
      {isRenewal && expiringAutoPopulated && (
        <div style={{ margin: '0 14px 10px', padding: '8px 12px', borderRadius: 10, background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.25)', fontSize: 12, color: 'var(--accent-blue)' }}>
          ⟳ Expiring structure auto-loaded from prior year contract. Data is read-only. Click <b>Override</b> above to edit.
        </div>
      )}

      {/* Expiring Terms — Brokerage, NCB, Profit Commission only */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(180px, 240px))', gap: 10, padding: '10px 14px 12px', borderBottom: '1px solid rgba(148,163,184,0.12)' }}>
        {[
          { k: 'brokerage_pct',          label: 'Brokerage %' },
          { k: 'no_claims_bonus_pct',    label: 'NCB %' },
          { k: 'profit_commission_pct',  label: 'Profit Comm. %' },
        ].map(({ k, label }) => {
          const locked = isRenewal && expiringAutoPopulated;
          return (
            <div key={k}>
              <div style={{ fontSize: 11, color: 'rgba(var(--text-rgb),0.7)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</div>
              <input
                className={`np-mini-input${locked ? ' np-mini-input--readonly' : ''}`}
                value={expiringTerms[k] ?? ''}
                placeholder="—"
                readOnly={locked}
                onChange={locked ? undefined : e => onUpdateTerm(k, e.target.value)} />
            </div>
          );
        })}
      </div>

      {/* Expiring Layers table */}
      <div className="np-table-wrap np-table-wrap--scroll np-table-wrap--wide">
        <table className="np-struct-table np-struct-table--wide">
          <thead>
            <tr>
              <th className="np-table-sticky cell-center">LAYER</th>
              <th className="np-col">LIMIT</th>
              <th className="np-col">DEDUCTIBLE / ATTACHMENT</th>
              <th className="np-col">AGGREGATE LIMIT</th>
              <th className="np-col">EGNPI</th>
              <th className="np-col-rate" title="RATE = Earned Premium ÷ EGNPI (expressed as %). Enter e.g. 2.5 for 2.5% — NOT 0.025.">RATE</th>
              <th className="np-col">EARNED PREMIUM</th>
              <th className="np-col">MDP</th>
              <th className="np-col-mdp-pct">MDP%</th>
              <th className="np-col-reinst">NO. REINSTATEMENTS</th>
              <th className="np-col-reinst">% REINSTATEMENTS</th>
              <th className="np-col-chk">AAD</th>
              <th className="np-col">AAD AMOUNT</th>
              <th className="np-col-chk">RISK</th>
              <th className="np-col-chk">CAT</th>
              <th className="np-col-rol" title="ROL = Earned Premium ÷ Limit (Rate-on-Line, expressed as %). Auto-computed from Rate and Limit — displayed here, not editable.">ROL</th>
            </tr>
          </thead>
          <tbody onPaste={onPaste}>
            {Array.from({ length: expiringLayerCount }, (_, i) => {
              const locked = isRenewal && expiringAutoPopulated;
              const emptyExp = { layer: i+1, limit:'', deductible:'', annualAggLimit:'', egnpi:'', earnedPremium:'', rate:'', mdp:'', mdpPct:'', reinstatements:'', reinstatementPct:'', aad:false, aadAmount:'', riskCover:true, catCover:true, rol:'', perilScope:'BOTH' };
              const l = { ...emptyExp, ...(expiringLayers[i] || {}) };
              const upd = locked ? () => {} : (field, val) => onUpdateLayer(i, field, val);
              return (
                <tr key={i} data-exp-row={i} style={locked ? { opacity: 0.8 } : undefined}>
                  <th className="np-table-sticky cell-center"><span className="np-layer-badge">L{i+1}</span></th>
                  <td><CommaInput value={l.limit} onChange={v => upd('limit', v)} suffix={currency} readOnly={locked} pasteField="limit" /></td>
                  <td><CommaInput value={l.deductible} onChange={i === 0 ? v => upd('deductible', v) : () => {}} readOnly={locked || i > 0} suffix={currency} /></td>
                  <td><CommaInput value={l.annualAggLimit} onChange={v => upd('annualAggLimit', v)} suffix={currency} readOnly={locked} pasteField="annualAggLimit" /></td>
                  <td><CommaInput value={l.egnpi} onChange={v => upd('egnpi', v)} suffix={currency} readOnly={locked} pasteField="egnpi" /></td>
                  <td className="cell-center np-col-rate"><RateInput value={l.rate} onChange={v => upd('rate', v)} readOnly={locked} pasteField="rate" /></td>
                  <td><CommaInput value={l.earnedPremium} readOnly suffix={currency} onChange={() => {}} /></td>
                  <td><CommaInput value={l.mdp} onChange={v => upd('mdp', v)} suffix={currency} readOnly={locked} pasteField="mdp" /></td>
                  <td className="cell-center np-col-mdp-pct"><PctInput className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.mdpPct || ''} onChange={() => {}} placeholder="—%" /></td>
                  <td className="cell-center np-col-reinst">
                    <div className="np-cell-input">
                      <select className="np-mini-input np-mini-input--center np-mini-select"
                        value={l.reinstatements || ''} disabled={locked}
                        onChange={locked ? undefined : e => upd('reinstatements', e.target.value)}>
                        {reinstatementOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="cell-center np-col-reinst"><PctInput value={l.reinstatementPct} onChange={v => upd('reinstatementPct', v)} readOnly={locked} pasteField="reinstatementPct" /></td>
                  <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.aad} disabled={locked} onChange={locked ? undefined : e => upd('aad', e.target.checked)} /></td>
                  <td><CommaInput value={l.aadAmount} onChange={v => upd('aadAmount', v)} suffix={currency} disabled={!l.aad || locked} readOnly={locked} /></td>
                  <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.riskCover} disabled={locked} onChange={locked ? undefined : e => upd('riskCover', e.target.checked)} /></td>
                  <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.catCover} disabled={locked} onChange={locked ? undefined : e => upd('catCover', e.target.checked)} /></td>
                  <td className="cell-center np-col-rol"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.rol || ''} placeholder="—" /></div></td>
                </tr>
              );
            })}
          </tbody>
          {/* Totals row */}
          {expiringLayerCount > 0 && (() => {
            const visLayers    = Array.from({ length: expiringLayerCount }, (_, i) => ({ ...{ limit:'', deductible:'', annualAggLimit:'', egnpi:'', earnedPremium:'', rate:'', mdp:'' }, ...(expiringLayers[i] || {}) }));
            const totLimit     = visLayers.reduce((s,l) => s + toNum(l.limit), 0);
            const firstDed     = toNum(visLayers[0]?.deductible);
            const totAgg       = visLayers.reduce((s,l) => s + toNum(l.annualAggLimit), 0);
            const totEgnpi     = Math.max(0, ...visLayers.map(l => toNum(l.egnpi)));
            const totRate      = visLayers.reduce((s,l) => s + rateToFloat(l.rate), 0);
            const totEP        = visLayers.reduce((s,l) => s + toNum(l.earnedPremium), 0);
            const totMdp       = visLayers.reduce((s,l) => s + toNum(l.mdp), 0);
            const totMdpPct    = totEP > 0 && totMdp > 0 ? fmtPctMaybe(totMdp / totEP) : '';
            // ROL total = SUMPRODUCT(rate% × EGNPI) / totalLimit
            const totRolNum    = visLayers.reduce((s,l) => s + rateToFloat(l.rate) / 100 * toNum(l.egnpi), 0);
            const totRol       = totLimit > 0 && totRolNum > 0
              ? fmtPctMaybe(totRolNum / totLimit)
              : totLimit > 0 && totEP > 0 ? fmtPctMaybe(totEP / totLimit) : '';
            const maxReinst    = visLayers.reduce((max,l) => {
              if (l.reinstatements === 'UNLIMITED') return 'UNLIMITED';
              const n = parseInt(l.reinstatements, 10);
              return Number.isFinite(n) && n > (typeof max === 'number' ? max : 0) ? n : max;
            }, 0);
            const maxReinstLabel = maxReinst === 'UNLIMITED' ? 'Unlimited' : maxReinst > 0 ? String(maxReinst) : '';
            return (
              <tfoot>
                <tr style={{ borderTop: '2px solid rgba(0,212,255,0.45)', background: 'rgba(0,212,255,0.06)' }}>
                  <th className="np-table-sticky cell-center" style={{ color: 'var(--accent-blue)', fontSize: 10, letterSpacing: '.08em', fontWeight: 800, background: 'rgba(0,212,255,0.08)' }}>TOTAL</th>
                  <td><CommaInput value={totLimit ? String(totLimit) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                  <td><CommaInput value={firstDed ? String(firstDed) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                  <td><CommaInput value={totAgg ? String(totAgg) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                  <td><CommaInput value={totEgnpi ? String(totEgnpi) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                  <td className="cell-center np-col-rate"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totRate > 0 ? `${parseFloat(totRate.toFixed(4))}%` : ''} placeholder="—" /></div></td>
                  <td><CommaInput value={totEP ? String(totEP) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                  <td><CommaInput value={totMdp ? String(totMdp) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                  <td className="cell-center np-col-mdp-pct"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totMdpPct} placeholder="—" /></div></td>
                  <td className="cell-center np-col-reinst"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={maxReinstLabel} placeholder="—" /></div></td>
                  <td></td>
                  <td></td>
                  <td></td>
                  <td></td>
                  <td></td>
                  <td className="cell-center np-col-rol"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totRol} placeholder="—" style={{ borderColor: 'rgba(0,212,255,0.55)', borderWidth: totRol ? 2 : 1 }} /></div></td>
                </tr>
              </tfoot>
            );
          })()}
        </table>
      </div>
      <div className="np-struct-footnote np-struct-footnote--right">Expiring structure is used to auto-populate year-on-year metrics in Final Pricing.</div>
    </section>
  );
}
