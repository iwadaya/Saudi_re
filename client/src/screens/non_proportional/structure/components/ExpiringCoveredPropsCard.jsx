// components/ExpiringCoveredPropsCard.jsx — Expiring Proportional Structure
// Covered card (prior year, Net XL treaties only). Extracted verbatim from
// NpStructure.jsx (Phase 4.2). `rows` is the calc-applied list
// (retentionAmount / totalCapacity precomputed by the hook).
import { CommaInput, PctInput } from '../NpStructureHelpers';

export default function ExpiringCoveredPropsCard({
  isNetXl, isRenewal, locked, rows, cobOptions, currency,
  onUpdate, onAddRow, onRemoveRow,
}) {
  return (
    <section className="np-struct-card glass">
      <div className="np-struct-card-header np-struct-card-header--plain">
        <div>
          <div className="np-struct-card-h2">Expiring Proportional Structure Covered</div>
          <div className="np-struct-card-hint">Prior year underlying proportional programmes covered under this Net XL treaty.</div>
        </div>
      </div>
      <div className="np-table-wrap np-table-wrap--scroll">
        <table className="np-struct-table np-struct-table--wide">
          <thead>
            <tr>
              <th className="np-col-prog">PROPORTIONAL PROGRAMME</th>
              <th className="np-col-prog">QS LIMIT 100%</th>
              <th className="np-col-prog">RETENTION %</th>
              <th className="np-col-prog">RETENTION AMOUNT</th>
              <th className="np-col-prog">SURPLUS LINES</th>
              <th className="np-col-prog">TOTAL CAPACITY</th>
            </tr>
          </thead>
          <tbody>
            {!isNetXl ? (
              <tr><td colSpan={6} className="np-muted cell-center" style={{ padding: 20 }}>Only required for Net XL treaties.</td></tr>
            ) : rows.map((r, i) => {
              const cobOpts = cobOptions.length ? cobOptions : [];
              return (
                <tr key={i}>
                  <td>
                    <div className="np-cell-input">
                      <select className="np-mini-input np-mini-select" value={r.cobId || ''} disabled={locked}
                        onChange={locked ? undefined : e => onUpdate(i, 'cobId', e.target.value)}>
                        <option value="">Select…</option>
                        {cobOpts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </div>
                  </td>
                  <td><CommaInput value={r.qsLimit} onChange={v => onUpdate(i, 'qsLimit', v)} suffix={currency} readOnly={locked} /></td>
                  <td className="cell-center"><PctInput value={r.retentionPct} onChange={v => onUpdate(i, 'retentionPct', v)} readOnly={locked} /></td>
                  <td><CommaInput value={r.retentionAmount} readOnly suffix={currency} onChange={() => {}} /></td>
                  <td className="cell-center">
                    <div className="np-cell-input">
                      <input className={`np-mini-input np-mini-input--center${locked ? ' np-mini-input--readonly' : ''}`} inputMode="numeric" placeholder="0"
                        value={r.surplusLines || ''} readOnly={locked}
                        onChange={locked ? undefined : e => onUpdate(i, 'surplusLines', e.target.value)} />
                    </div>
                  </td>
                  <td><CommaInput value={r.totalCapacity} readOnly suffix={currency} onChange={() => {}} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {isNetXl && !isRenewal && (
        <div style={{ padding: '8px 14px', display: 'flex', gap: 8 }}>
          <button className="np-struct-btn" onClick={onAddRow}>+ Add Row</button>
          {rows.length > 1 && (
            <button className="np-struct-btn" onClick={onRemoveRow}>− Remove</button>
          )}
        </div>
      )}
      <div className="np-struct-footnote np-struct-footnote--right">Expiring proportional covered — leave empty for Gross XL.</div>
    </section>
  );
}
