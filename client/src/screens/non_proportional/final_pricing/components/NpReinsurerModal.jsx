// src/screens/non_proportional/final_pricing/components/NpReinsurerModal.jsx
//
// Lead Reinsurer Setup — one editable row per layer (leader, expiring
// reinsurer, ROL, lead share). Rendered as a modal from NpFinalPricing
// so it doesn't compete with the main table for width. Saving commits
// the whole pricing payload via the passed-in save() from the parent;
// close-only dismisses without saving.
//
// Extracted from NpFinalPricing.jsx to keep that file focused on the
// pricing dataflow.

import PctInput from '../../../../components/PctInput';


/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   layers: Array<object>,
 *   leadSetup: Array<{leader?:string, expiringReinsurer?:string, rol?:string, leadShare?:string}>,
 *   updateLeadSetup: (idx:number, field:string, value:string) => void,
 *   reinsurers: Array<{id:string, name:string}>,
 *   onSave: () => Promise<boolean>,
 * }} props
 */
export default function NpReinsurerModal({ open, onClose, layers, leadSetup, updateLeadSetup, reinsurers, onSave }) {
  if (!open) return null;

  const handleSaveAndClose = async () => {
    const ok = await onSave();
    if (ok) onClose();
  };

  return (
    <div
      className="screen-modal-backdrop"
      role="presentation"
      style={{ display: 'flex' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="screen-modal screen-modal--wide" role="dialog">
        <div className="screen-modal-header">
          <div className="screen-modal-title">Reinsurer Analysis</div>
          <button className="screen-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="screen-modal-body" style={{ padding: '0 0 8px' }}>
          <div className="np-reins-modal-body">
            <div className="np-reins-section-label">Lead Reinsurer Setup · Per Layer</div>
            <div className="np-final-table-wrap">
              <table className="np-final-table np-final-table--setup np-reins-table">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>Layer</th>
                    <th>Leader</th>
                    <th>Expiring Reinsurer</th>
                    <th style={{ width: 100 }}>ROL</th>
                    <th style={{ width: 130 }}>Lead Share</th>
                  </tr>
                </thead>
                <tbody>
                  {layers.map((l, i) => (
                    <tr key={i}>
                      <td className="col-layer cell-center">
                        <span className="np-layer-badge">{l.layer}</span>
                      </td>
                      <td>
                        <select
                          className="np-mini-input"
                          value={leadSetup[i]?.leader || ''}
                          onChange={(e) => updateLeadSetup(i, 'leader', e.target.value)}
                        >
                          <option value="">Select...</option>
                          {reinsurers.map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="np-mini-input"
                          value={leadSetup[i]?.expiringReinsurer || ''}
                          onChange={(e) => updateLeadSetup(i, 'expiringReinsurer', e.target.value)}
                        />
                      </td>
                      <td>
                        <PctInput
                          className="np-mini-input"
                          value={leadSetup[i]?.rol || ''}
                          placeholder="e.g. 5.5%"
                          onChange={(v) => updateLeadSetup(i, 'rol', v)}
                        />
                      </td>
                      <td>
                        <PctInput
                          className="np-mini-input"
                          value={leadSetup[i]?.leadShare || ''}
                          placeholder="e.g. 30%"
                          onChange={(v) => updateLeadSetup(i, 'leadShare', v)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="np-reins-modal-footer">
              <button className="np-btn" onClick={onClose}>Close</button>
              <button className="np-btn np-btn--primary" onClick={handleSaveAndClose}>Save &amp; Close</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
