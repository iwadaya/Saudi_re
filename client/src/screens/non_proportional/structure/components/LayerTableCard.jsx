// components/LayerTableCard.jsx — TREATY STRUCTURE – LAYERS card.
// Pure presentation extracted verbatim from NpStructure.jsx (Phase 4.2):
// props in, callbacks out. Totals math is render-local and pinned by
// goldenMaster.test.jsx.
import { toNum, rateToFloat, fmtPctMaybe, CommaInput, RateInput, PctInput } from '../NpStructureHelpers';

export default function LayerTableCard({
  layers, currency, mode,
  riskLocked, catLocked, riskPillOn, catPillOn,
  reinstatementOptions,
  onUpdateLayer, onAddLayer, onDeleteLastLayer, onPaste,
}) {
  return (
    <section className="np-struct-card glass" id="npLayersCard">
      <div className="np-struct-card-header">
        <div className="np-struct-card-title">TREATY STRUCTURE – LAYERS</div>
        <div className="np-struct-card-actions">
          <div className="np-type-pills" aria-label="Treaty type">
            <span className={`np-type-pill ${riskPillOn ? 'is-on' : 'is-off'}`}>RISK XL</span>
            <span className={`np-type-pill ${catPillOn ? 'is-on' : 'is-off'}`}>CAT XL</span>
          </div>
          <button type="button" className="np-struct-btn" onClick={onAddLayer}>+ Add Layer</button>
          <button type="button" className="np-struct-btn" onClick={onDeleteLastLayer} disabled={layers.length <= 1}>Delete Layer</button>
        </div>
      </div>
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
            {layers.map((l, i) => (
              <tr key={i} data-layer-row={i}>
                <th className="np-table-sticky cell-center">{l.layer}</th>
                <td><CommaInput value={l.limit} onChange={v => onUpdateLayer(i, 'limit', v)} suffix={currency} pasteField="limit" /></td>
                <td><CommaInput value={l.deductible} readOnly suffix={currency} onChange={() => {}} /></td>
                <td><CommaInput value={l.annualAggLimit} onChange={v => onUpdateLayer(i, 'annualAggLimit', v)} suffix={currency} pasteField="annualAggLimit" /></td>
                <td><CommaInput value={l.egnpi} onChange={v => onUpdateLayer(i, 'egnpi', v)} suffix={currency} pasteField="egnpi" /></td>
                <td className="cell-center np-col-rate"><RateInput value={l.rate} onChange={v => onUpdateLayer(i, 'rate', v)} pasteField="rate" /></td>
                <td><CommaInput value={l.earnedPremium} readOnly suffix={currency} onChange={() => {}} /></td>
                <td><CommaInput value={l.mdp} onChange={v => onUpdateLayer(i, 'mdp', v)} suffix={currency} pasteField="mdp" /></td>
                <td className="cell-center np-col-mdp-pct"><PctInput className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.mdpPct || ''} onChange={() => {}} placeholder="—%" /></td>
                <td className="cell-center np-col-reinst">
                  <div className="np-cell-input">
                    <select className="np-mini-input np-mini-input--center np-mini-select" value={l.reinstatements || ''} onChange={e => onUpdateLayer(i, 'reinstatements', e.target.value)}>
                      {reinstatementOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                  </div>
                </td>
                <td className="cell-center np-col-reinst">
                  <PctInput value={l.reinstatementPct} onChange={v => onUpdateLayer(i, 'reinstatementPct', v)} pasteField="reinstatementPct" />
                </td>
                <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.aad} onChange={e => onUpdateLayer(i, 'aad', e.target.checked)} /></td>
                <td><CommaInput value={l.aadAmount} onChange={v => onUpdateLayer(i, 'aadAmount', v)} suffix={currency} disabled={!l.aad} pasteField="aadAmount" /></td>
                <td className={`np-col-chk cell-center np-cover-cell ${mode === 'CAT' ? 'is-off' : ''} ${riskLocked ? 'is-locked' : ''}`}>
                  <input type="checkbox" className="np-check" checked={!!l.riskCover} onChange={e => onUpdateLayer(i, 'riskCover', e.target.checked)} disabled={mode === 'RISK' || mode === 'CAT'} />
                </td>
                <td className={`np-col-chk cell-center np-cover-cell ${mode === 'RISK' ? 'is-off' : ''} ${catLocked ? 'is-locked' : ''}`}>
                  <input type="checkbox" className="np-check" checked={!!l.catCover} onChange={e => onUpdateLayer(i, 'catCover', e.target.checked)} disabled={mode === 'RISK' || mode === 'CAT'} />
                </td>
                <td className="cell-center np-col-rol"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.rol || ''} placeholder="—" /></div></td>
              </tr>
            ))}
          </tbody>
          {/* Totals row */}
          {layers.length > 0 && (() => {
            const totLimit     = layers.reduce((s,l) => s + toNum(l.limit), 0);
            const firstDed     = toNum(layers[0]?.deductible);
            const totAgg       = layers.reduce((s,l) => s + toNum(l.annualAggLimit), 0);
            const totEgnpi     = Math.max(0, ...layers.map(l => toNum(l.egnpi)));
            const totRate      = layers.reduce((s,l) => s + rateToFloat(l.rate), 0);
            const totEP        = layers.reduce((s,l) => s + toNum(l.earnedPremium), 0);
            const totMdp       = layers.reduce((s,l) => s + toNum(l.mdp), 0);
            const totMdpPct    = totEP > 0 && totMdp > 0 ? fmtPctMaybe(totMdp / totEP) : '';
            // ROL total = SUMPRODUCT(rate% × EGNPI) / totalLimit
            // Falls back to SUM(earnedPremium) / totalLimit if EP is entered directly
            const totRolNum    = layers.reduce((s,l) => s + rateToFloat(l.rate) / 100 * toNum(l.egnpi), 0);
            const totRol       = totLimit > 0 && totRolNum > 0
              ? fmtPctMaybe(totRolNum / totLimit)
              : totLimit > 0 && totEP > 0 ? fmtPctMaybe(totEP / totLimit) : '';
            const maxReinst    = layers.reduce((max,l) => {
              if (l.reinstatements === 'UNLIMITED') return 'UNLIMITED';
              const n = parseInt(l.reinstatements, 10);
              return Number.isFinite(n) && n > (typeof max === 'number' ? max : 0) ? n : max;
            }, 0);
            const maxReinstLabel = maxReinst === 'UNLIMITED' ? 'Unlimited' : maxReinst > 0 ? String(maxReinst) : '';
            return (
              <tfoot>
                <tr style={{ borderTop: '2px solid rgba(0,212,255,0.45)', background: 'rgba(0,212,255,0.06)' }}>
                  <th className="np-table-sticky cell-center" style={{ color: '#00d4ff', fontSize: 10, letterSpacing: '.08em', fontWeight: 800, background: 'rgba(0,212,255,0.08)' }}>TOTAL</th>
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
      <div className="np-struct-footnote">Enter <b>Rate</b> to calculate <b>Earned Premium = EGNPI × Rate</b>. <b>ROL</b> is implied as <b>Earned Premium ÷ Limit</b>. <b>MDP%</b> is implied as <b>MDP ÷ Earned Premium</b>. Layer 1 deductible is pulled from NP treaty detail; subsequent deductibles auto-calculate as <b>prior deductible + prior limit</b>.</div>
    </section>
  );
}
