// components/FQCobParticipationTable.jsx — Phase 4.1 extraction.
//
// "Underwriting Limits & Layer Participation" card rendered under the
// expiring structure and under each quote structure. JSX moved verbatim
// from NpFinalPricing's renderQuoteCobParticipationTable — props in,
// callbacks out, no logic changes.

import { FQNumCell } from './FQCells.jsx';

/**
 * @param {{
 *   scope: string,                       // 'exp' or the structure id
 *   tableLayers: Array<object>,
 *   title?: string,
 *   hint?: string,
 *   currency: string,
 *   selectedCobs: Array<{id: string|number, name: string}>,
 *   getCobFlags: (scope: string, cobId: string|number, layers: Array<object>) => boolean[],
 *   getCobUwLimit: (scope: string, cobId: string|number) => string,
 *   updateUwLimit: (scope: string, cobId: string|number, value: string) => void,
 *   setCobToggle: (scope: string, cobId: string|number, layerIdx: number, currentFlag: boolean) => void,
 *   readOnly?: boolean,                  // review mode: limits + ticks shown but not editable
 * }} props
 */
export default function FQCobParticipationTable({
  scope,
  tableLayers,
  title: titleProp,
  hint: hintProp,
  currency,
  selectedCobs,
  getCobFlags,
  getCobUwLimit,
  updateUwLimit,
  setCobToggle,
  readOnly = false,
}) {
  const options = { title: titleProp, hint: hintProp };
    const safeLayers = Array.isArray(tableLayers) ? tableLayers : [];
    const colSpan = 2 + safeLayers.length;
    const title = options.title || 'Underwriting Limits & Layer Participation';
    const hint = options.hint || 'Underwriting limits are entered per class. Tick layers that participate for each class.';

    return (
      <section className="bm-card bm-cob-section" style={{ marginBottom: 12 }}>
        <div className="bm-cob-section-header">
          <div className="bm-cob-section-title">{title}</div>
          <div className="bm-cob-section-hint">{hint}</div>
        </div>
        <div className="bm-np-table-wrap">
          <table className="bm-np-table">
            <thead>
              <tr>
                <th className="bm-np-th--cob" style={{ minWidth: 230, width: 253 }}>CLASS OF BUSINESS</th>
                <th className="bm-np-th--limit" style={{ minWidth: 299, width: 322 }}>UNDERWRITING LIMIT</th>
                {safeLayers.map((_, lIdx) => (
                  <th key={lIdx} className="bm-np-th--layer" style={{ minWidth: 115, width: 138 }}>LAYER {lIdx + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {selectedCobs.length > 0 ? selectedCobs.map((cob) => {
                const flags = getCobFlags(scope, cob.id, safeLayers);
                return (
                  <tr key={cob.id} className="bm-np-row">
                    <td className="bm-np-td--cob" style={{ minWidth: 230, width: 253 }}>{cob.name}</td>
                    <td className="bm-np-td--limit" style={{ minWidth: 299, width: 322 }}>
                      <div className="bm-np-limit-cell">
                        <FQNumCell
                          className="bm-np-limit-input"
                          value={getCobUwLimit(scope, cob.id)}
                          onChange={(v) => updateUwLimit(scope, cob.id, v)}
                          readOnly={readOnly}
                        />
                        <span className="bm-np-limit-suffix">{currency || ''}</span>
                      </div>
                    </td>
                    {safeLayers.map((_, lIdx) => (
                      <td key={lIdx} className="bm-np-td--check" style={{ minWidth: 115, width: 138 }}>
                        <input
                          type="checkbox"
                          className="np-check"
                          checked={!!flags[lIdx]}
                          disabled={readOnly}
                          onChange={() => { if (readOnly) return; setCobToggle(scope, cob.id, lIdx, !!flags[lIdx]); }}
                        />
                      </td>
                    ))}
                  </tr>
                );
              }) : (
                <tr className="bm-np-row">
                  <td colSpan={colSpan} className="bm-np-td--cob" style={{ textAlign: 'center', padding: 20, color: 'rgba(148,163,184,0.65)' }}>
                    Select classes of business above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    );
}
