// components/CobParticipationCard.jsx — Classes of Business & Layer
// Participation card. Extracted verbatim from NpStructure.jsx (Phase 4.2).
import { CommaInput } from '../NpStructureHelpers';

export default function CobParticipationCard({ cobRows, layers, currency, onUpdateCobRow, onToggleCobLayer }) {
  return (
    <section className="np-struct-card glass">
      <div className="np-struct-card-header np-struct-card-header--plain">
        <div>
          <div className="np-struct-card-h2">Classes of Business &amp; Layer Participation</div>
          <div className="np-struct-card-hint">Underwriting limits are entered per class. Tick layers that participate for each class.</div>
        </div>
      </div>
      <div className="np-table-wrap np-table-wrap--scroll">
        <table className="np-struct-table np-struct-table--tight np-cob-table">
          <thead>
            <tr>
              <th>CLASS OF BUSINESS</th>
              <th>UNDERWRITING LIMIT</th>
              {layers.map((_, i) => <th key={i} className="cell-center">LAYER {i + 1}</th>)}
            </tr>
          </thead>
          <tbody>
            {cobRows.map((r, ci) => (
              <tr key={ci}>
                <td>{r.name || '—'}</td>
                <td><CommaInput value={r.underwritingLimit} onChange={v => onUpdateCobRow(ci, 'underwritingLimit', v)} suffix={currency} /></td>
                {layers.map((_, li) => (
                  <td key={li} className="cell-center">
                    <input type="checkbox" className="np-check" checked={!!(r.layers && r.layers[li])}
                      onChange={() => onToggleCobLayer(ci, li)} />
                  </td>
                ))}
              </tr>
            ))}
            {cobRows.length === 0 && (
              <tr><td colSpan={2 + layers.length} className="cell-center muted" style={{ padding: 20 }}>Select classes of business in NP treaty detail.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="np-struct-footnote np-struct-footnote--right">Underwriting limits are captured per class. Participation checkboxes sync with layer COB selections.</div>
    </section>
  );
}
