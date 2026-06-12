// components/CoveredPropsCard.jsx — Proportional Structure Covered card
// (current year, Net XL treaties only). Extracted verbatim from
// NpStructure.jsx (Phase 4.2). `rows` is the calc-applied list
// (retentionAmount / totalCapacity precomputed by the hook).
import { CommaInput, PctInput } from '../NpStructureHelpers';

export default function CoveredPropsCard({ isNetXl, rows, cobOptions, currency, onUpdate }) {
  return (
    <section className="np-struct-card glass">
      <div className="np-struct-card-header np-struct-card-header--plain">
        <div>
          <div className="np-struct-card-h2">Proportional Structure Covered</div>
          <div className="np-struct-card-hint">If this treaty is written on a Net XL basis, summarise the underlying proportional programmes whose net are covered here.</div>
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
              <tr><td colSpan={6} className="np-muted cell-center" style={{ padding: 20 }}>Proportional structure is only required for Net XL treaties.</td></tr>
            ) : rows.map((r, i) => {
              const cobOpts = cobOptions.length ? cobOptions : [];
              return (
                <tr key={i}>
                  <td>
                    <div className="np-cell-input">
                      <select className="np-mini-input np-mini-select" value={r.cobId || ''} onChange={e => onUpdate(i, 'cobId', e.target.value)}>
                        <option value="">Select…</option>
                        {cobOpts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </div>
                  </td>
                  <td><CommaInput value={r.qsLimit} onChange={v => onUpdate(i, 'qsLimit', v)} suffix={currency} /></td>
                  <td className="cell-center"><PctInput value={r.retentionPct} onChange={v => onUpdate(i, 'retentionPct', v)} /></td>
                  <td><CommaInput value={r.retentionAmount} readOnly suffix={currency} onChange={() => {}} /></td>
                  <td className="cell-center">
                    <div className="np-cell-input">
                      <input className="np-mini-input np-mini-input--center" inputMode="numeric" placeholder="0"
                        value={r.surplusLines || ''} onChange={e => onUpdate(i, 'surplusLines', e.target.value)} />
                    </div>
                  </td>
                  <td><CommaInput value={r.totalCapacity} readOnly suffix={currency} onChange={() => {}} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="np-struct-footnote np-struct-footnote--right">Populate only when treaty nature is Net XL; leave empty for Gross XL.</div>
    </section>
  );
}
