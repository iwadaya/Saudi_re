// src/screens/non_proportional/expiring_structure/NpStopLossExpiring.jsx
//
// Stop Loss expiring layer table. Renders one row per layer of the
// expiring placement (count comes from
// npTreatyDetail.expiringNumberOfLayers — default 1). Columns: Layer,
// Attach LR%, Limit LR%, EPI, Rate%, ROL%.
//
// Persists into AppContext slice `npStopLossExpiring.layers`. The
// component is mounted on both the Structure screen (below the
// current-year layer setup) and the dedicated Expiring Structure
// screen, so edits in one place show up in the other.

import { useCallback, useEffect, useMemo } from 'react';
import PctInput from '../../../components/PctInput';
import { useAppState } from '../../../context/AppContext';
import { fmtMoney, parseNum } from '../structure/NpStructureHelpers';

const SLICE_KEY = 'npStopLossExpiring';
const DEFAULT_LAYER = { attachment_lr_pct: '', limit_lr_pct: '', epi: '', rate_pct: '', rol_pct: '' };


export default function NpStopLossExpiring({ currency = 'SAR' }) {
  const { state: appState, setSlice } = useAppState();
  const npDetail = appState.npTreatyDetail || {};
  const stored = appState[SLICE_KEY];

  const layerCount = useMemo(() => {
    const n = parseInt(npDetail.expiringNumberOfLayers || npDetail.expiring_number_of_layers || '1', 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 1;
  }, [npDetail.expiringNumberOfLayers, npDetail.expiring_number_of_layers]);

  const layers = useMemo(() => {
    // Tolerate both the new `layers` shape and the legacy `rows` shape
    // (which previously allowed user-driven add/remove). Convert rows
    // to the canonical layer record on the way through.
    const saved = Array.isArray(stored?.layers)
      ? stored.layers
      : Array.isArray(stored?.rows)
        ? stored.rows.map((r) => ({
            attachment_lr_pct: r.attachment_lr_pct ?? '',
            limit_lr_pct: r.limit_lr_pct ?? '',
            epi: r.epi ?? '',
            rate_pct: r.rate_pct ?? '',
            rol_pct: r.rol_pct ?? '',
          }))
        : [];
    const out = [];
    for (let i = 0; i < layerCount; i++) {
      out.push(saved[i] ? { ...DEFAULT_LAYER, ...saved[i] } : { ...DEFAULT_LAYER });
    }
    return out;
  }, [stored, layerCount]);

  // Persist the resolved-and-padded layers back to the slice when the
  // layer count changes so legacy rows / counts catch up to treaty detail.
  useEffect(() => {
    setSlice(SLICE_KEY, { layers });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerCount]);

  const updateLayer = useCallback((i, patch) => {
    const next = layers.map((l, idx) => (idx === i ? { ...l, ...patch } : l));
    setSlice(SLICE_KEY, { layers: next });
  }, [layers, setSlice]);

  return (
    <section className="np-struct-card glass" style={{ marginBottom: 16 }}>
      <div className="np-struct-card-header">
        <div className="np-struct-card-title">EXPIRING STOP LOSS · By Layer</div>
        <div className="np-struct-card-actions">
          <span className="np-tag">Loss-Ratio Basis</span>
          <span className="np-tag" style={{ marginLeft: 8 }}>{layerCount} layer{layerCount === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div className="np-table-wrap np-table-wrap--scroll">
        <table className="np-struct-table">
          <thead>
            <tr>
              <th className="np-table-sticky cell-center">LAYER</th>
              <th className="np-col-rate cell-center">ATTACH LR %</th>
              <th className="np-col-rate cell-center">LIMIT LR %</th>
              <th className="np-col cell-center">EPI ({currency})</th>
              <th className="np-col-rate cell-center">RATE %</th>
              <th className="np-col-rol cell-center">ROL %</th>
            </tr>
          </thead>
          <tbody>
            {layers.map((l, i) => {
              const ratePctNum = parseNum(l.rate_pct);
              const limLrPctNum = parseNum(l.limit_lr_pct);
              const impliedRolPct = (ratePctNum != null && limLrPctNum != null && limLrPctNum > 0)
                ? (ratePctNum / limLrPctNum) * 100
                : null;
              const userRol = parseNum(l.rol_pct);
              const rolDisplay = userRol != null
                ? l.rol_pct
                : (impliedRolPct != null ? `${impliedRolPct.toFixed(2)}` : '');
              return (
                <tr key={i}>
                  <th className="np-table-sticky cell-center">L{i + 1}</th>
                  <td className="np-col-rate cell-center">
                    <div className="np-cell-input">
                      <PctInput
                        className="np-mini-input np-mini-input--center"
                        value={l.attachment_lr_pct}
                        onChange={(v) => updateLayer(i, { attachment_lr_pct: v })}
                        placeholder="—%"
                      />
                    </div>
                  </td>
                  <td className="np-col-rate cell-center">
                    <div className="np-cell-input">
                      <PctInput
                        className="np-mini-input np-mini-input--center"
                        value={l.limit_lr_pct}
                        onChange={(v) => updateLayer(i, { limit_lr_pct: v })}
                        placeholder="—%"
                      />
                    </div>
                  </td>
                  <td className="np-col cell-center">
                    <div className="np-cell-input">
                      <input
                        className="np-mini-input np-mini-input--center"
                        value={fmtMoney(l.epi)}
                        onChange={(e) => updateLayer(i, { epi: e.target.value.replace(/[^\d.-]/g, '') })}
                        placeholder="—"
                      />
                      <span className="np-sfx">{currency}</span>
                    </div>
                  </td>
                  <td className="np-col-rate cell-center">
                    <div className="np-cell-input">
                      <PctInput
                        className="np-mini-input np-mini-input--center"
                        value={l.rate_pct}
                        onChange={(v) => updateLayer(i, { rate_pct: v })}
                        placeholder="—%"
                      />
                    </div>
                  </td>
                  <td className="np-col-rol cell-center">
                    <div className="np-cell-input">
                      <PctInput
                        className="np-mini-input np-mini-input--center"
                        value={rolDisplay}
                        onChange={(v) => updateLayer(i, { rol_pct: v })}
                        placeholder={impliedRolPct != null ? `${impliedRolPct.toFixed(2)}%` : '—%'}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '10px 16px 14px', fontSize: 11, color: 'rgba(148,163,184,0.55)', lineHeight: 1.5 }}>
        Number of layers comes from Treaty Detail. ROL = Rate / Limit&nbsp;LR
        when both are entered; you can override per layer.
      </div>
    </section>
  );
}
