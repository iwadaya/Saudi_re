// src/screens/non_proportional/structure/NpStopLossStructure.jsx
//
// Stop Loss-specific layer setup that replaces the Risk XL / Cat XL
// layer table on the Structure screen when the treaty type is "Stop
// Loss". Renders N rows where N = npTreatyDetail.numberOfLayers
// (defaults to 1). Each row captures the cover's loss-ratio attach,
// loss-ratio limit, and EPI. Persists into the existing
// `npStopLossInputs.layers` slice; the pricing screen consumes
// `layers[0]` as the primary cover.

import { useCallback, useEffect, useMemo } from 'react';
import PctInput from '../../../components/PctInput';
import { useAppState } from '../../../context/AppContext';

const DEFAULT_LAYER = { attachmentLossRatio: '', limitLossRatio: '', epi: '' };

function fmtMoney(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
}
function parseNum(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export default function NpStopLossStructure({ currency = 'SAR' }) {
  const { state: appState, setSlice } = useAppState();
  const slice = appState.npStopLossInputs || {};
  const npDetail = appState.npTreatyDetail || {};

  // Number of layers comes from Treaty Detail (camelCase or snake_case).
  // Default to 1 — stop loss treaties are almost always single-layer.
  const layerCount = useMemo(() => {
    const n = parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '1', 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 1;
  }, [npDetail.numberOfLayers, npDetail.number_of_layers]);

  // Resolve the stored layers, padding/truncating to match treaty detail.
  // Backward-compat shim: if a single-layer record exists at the top
  // level (pre-refactor shape) seed it as layer 0.
  const layers = useMemo(() => {
    const saved = Array.isArray(slice.layers) ? slice.layers : null;
    const legacy = (!saved || saved.length === 0) && (slice.attachmentLossRatio || slice.limitLossRatio || slice.epi)
      ? [{ attachmentLossRatio: slice.attachmentLossRatio || '', limitLossRatio: slice.limitLossRatio || '', epi: slice.epi || '' }]
      : null;
    const base = saved && saved.length > 0 ? saved : (legacy || []);
    const out = [];
    for (let i = 0; i < layerCount; i++) {
      out.push(base[i] ? { ...DEFAULT_LAYER, ...base[i] } : { ...DEFAULT_LAYER });
    }
    return out;
  }, [slice.layers, slice.attachmentLossRatio, slice.limitLossRatio, slice.epi, layerCount]);

  // Keep the slice in sync with the resolved layer count on first
  // render (or when treaty detail changes the layer count). Mirrors
  // layer 0 into the legacy top-level fields so the existing pricing
  // screen keeps working without a coordinated refactor.
  useEffect(() => {
    const primary = layers[0] || DEFAULT_LAYER;
    setSlice('npStopLossInputs', {
      layers,
      attachmentLossRatio: primary.attachmentLossRatio,
      limitLossRatio: primary.limitLossRatio,
      epi: primary.epi,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerCount]);

  const updateLayer = useCallback((i, patch) => {
    const next = layers.map((l, idx) => (idx === i ? { ...l, ...patch } : l));
    const primary = next[0] || DEFAULT_LAYER;
    setSlice('npStopLossInputs', {
      layers: next,
      attachmentLossRatio: primary.attachmentLossRatio,
      limitLossRatio: primary.limitLossRatio,
      epi: primary.epi,
    });
  }, [layers, setSlice]);

  return (
    <section className="np-struct-card glass" style={{ marginBottom: 16 }}>
      <div className="np-struct-card-header">
        <div className="np-struct-card-title">STOP LOSS STRUCTURE · By Layer</div>
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
              <th className="np-col cell-center">RESOLVED · LIMIT</th>
              <th className="np-col cell-center">RESOLVED · ATTACH</th>
            </tr>
          </thead>
          <tbody>
            {layers.map((l, i) => {
              const epiN = parseNum(l.epi);
              const attN = parseNum(l.attachmentLossRatio);
              const limN = parseNum(l.limitLossRatio);
              const limit = (epiN != null && limN != null) ? (epiN * limN) / 100 : null;
              const attach = (epiN != null && attN != null) ? (epiN * attN) / 100 : null;
              return (
                <tr key={i}>
                  <th className="np-table-sticky cell-center">L{i + 1}</th>
                  <td className="np-col-rate cell-center">
                    <div className="np-cell-input">
                      <PctInput
                        className="np-mini-input np-mini-input--center"
                        value={l.attachmentLossRatio}
                        onChange={(v) => updateLayer(i, { attachmentLossRatio: v })}
                        placeholder="—%"
                      />
                    </div>
                  </td>
                  <td className="np-col-rate cell-center">
                    <div className="np-cell-input">
                      <PctInput
                        className="np-mini-input np-mini-input--center"
                        value={l.limitLossRatio}
                        onChange={(v) => updateLayer(i, { limitLossRatio: v })}
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
                  <td className="np-col cell-center">
                    <div className="np-cell-input">
                      <input
                        className="np-mini-input np-mini-input--center np-mini-input--readonly"
                        readOnly
                        value={limit != null ? fmtMoney(limit) : ''}
                        placeholder="—"
                      />
                      <span className="np-sfx">{currency}</span>
                    </div>
                  </td>
                  <td className="np-col cell-center">
                    <div className="np-cell-input">
                      <input
                        className="np-mini-input np-mini-input--center np-mini-input--readonly"
                        readOnly
                        value={attach != null ? fmtMoney(attach) : ''}
                        placeholder="—"
                      />
                      <span className="np-sfx">{currency}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '10px 16px 14px', fontSize: 11, color: 'rgba(148,163,184,0.55)', lineHeight: 1.5 }}>
        Number of layers comes from Treaty Detail. Resolved limit and
        attachment use the row's EPI; the Stop Loss Pricing screen
        prices layer&nbsp;1.
      </div>
    </section>
  );
}
