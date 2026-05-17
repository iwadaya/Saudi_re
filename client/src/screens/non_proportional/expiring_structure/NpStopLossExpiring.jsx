// src/screens/non_proportional/expiring_structure/NpStopLossExpiring.jsx
//
// Stop Loss-specific expiring-structure layout: one row per
// historical placement showing Attachment LR%, Limit LR%, EPI, Rate%
// and ROL%. Replaces the Risk XL layer-grid view when the treaty
// type is "Stop Loss". Rows persist in AppContext slice
// `npStopLossExpiring` until a dedicated server endpoint exists.

import { useCallback, useMemo } from 'react';
import PctInput from '../../../components/PctInput';
import { useAppState } from '../../../context/AppContext';

const SLICE_KEY = 'npStopLossExpiring';
const DEFAULT_ROW = { uw_year: '', attachment_lr_pct: '', limit_lr_pct: '', epi: '', rate_pct: '', rol_pct: '' };

function fmtMoney(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
}
function parseNum(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export default function NpStopLossExpiring({ currency = 'SAR' }) {
  const { state: appState, setSlice } = useAppState();
  const stored = appState[SLICE_KEY];
  const rows = useMemo(() => {
    const list = Array.isArray(stored?.rows) ? stored.rows : [];
    return list.length > 0 ? list : [{ ...DEFAULT_ROW }];
  }, [stored]);

  const updateRow = useCallback((idx, patch) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    setSlice(SLICE_KEY, { rows: next });
  }, [rows, setSlice]);

  const addRow = useCallback(() => {
    setSlice(SLICE_KEY, { rows: [...rows, { ...DEFAULT_ROW }] });
  }, [rows, setSlice]);

  const removeRow = useCallback((idx) => {
    const next = rows.filter((_, i) => i !== idx);
    setSlice(SLICE_KEY, { rows: next.length > 0 ? next : [{ ...DEFAULT_ROW }] });
  }, [rows, setSlice]);

  return (
    <section className="np-struct-card glass" style={{ marginBottom: 16 }}>
      <div className="np-struct-card-header">
        <div className="np-struct-card-title">EXPIRING STOP LOSS · By UW Year</div>
        <div className="np-struct-card-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="np-tag">Loss-Ratio Basis</span>
          <button type="button" className="dock-btn dock-btn--ghost" onClick={addRow}>+ Add Year</button>
        </div>
      </div>
      <div className="np-table-wrap np-table-wrap--scroll">
        <table className="np-struct-table">
          <thead>
            <tr>
              <th className="np-table-sticky cell-center">UW YEAR</th>
              <th className="np-col-rate cell-center">ATTACH LR %</th>
              <th className="np-col-rate cell-center">LIMIT LR %</th>
              <th className="np-col">EPI ({currency})</th>
              <th className="np-col-rate cell-center">RATE %</th>
              <th className="np-col-rol cell-center">ROL %</th>
              <th className="cell-center" style={{ width: 40 }} aria-label="row actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="np-table-sticky cell-center">
                  <input
                    className="np-mini-input np-mini-input--center"
                    value={r.uw_year}
                    onChange={(e) => updateRow(i, { uw_year: e.target.value.replace(/[^\d]/g, '').slice(0, 4) })}
                    placeholder="YYYY"
                  />
                </td>
                <td className="np-col-rate cell-center">
                  <div className="np-cell-input">
                    <PctInput
                      className="np-mini-input np-mini-input--center"
                      value={r.attachment_lr_pct}
                      onChange={(v) => updateRow(i, { attachment_lr_pct: v })}
                      placeholder="—%"
                    />
                  </div>
                </td>
                <td className="np-col-rate cell-center">
                  <div className="np-cell-input">
                    <PctInput
                      className="np-mini-input np-mini-input--center"
                      value={r.limit_lr_pct}
                      onChange={(v) => updateRow(i, { limit_lr_pct: v })}
                      placeholder="—%"
                    />
                  </div>
                </td>
                <td className="np-col">
                  <div className="np-cell-input">
                    <input
                      className="np-mini-input np-mini-input--center"
                      value={fmtMoney(r.epi)}
                      onChange={(e) => updateRow(i, { epi: e.target.value.replace(/[^\d.-]/g, '') })}
                      placeholder="—"
                    />
                    <span className="np-sfx">{currency}</span>
                  </div>
                </td>
                <td className="np-col-rate cell-center">
                  <div className="np-cell-input">
                    <PctInput
                      className="np-mini-input np-mini-input--center"
                      value={r.rate_pct}
                      onChange={(v) => updateRow(i, { rate_pct: v })}
                      placeholder="—%"
                    />
                  </div>
                </td>
                <td className="np-col-rol cell-center">
                  <div className="np-cell-input">
                    <PctInput
                      className="np-mini-input np-mini-input--center"
                      value={r.rol_pct}
                      onChange={(v) => updateRow(i, { rol_pct: v })}
                      placeholder="—%"
                    />
                  </div>
                </td>
                <td className="cell-center" style={{ width: 40 }}>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    aria-label={`Remove row ${i + 1}`}
                    title="Remove"
                    style={{
                      appearance: 'none',
                      background: 'transparent',
                      border: 'none',
                      color: 'rgba(248,113,113,0.65)',
                      cursor: 'pointer',
                      fontSize: 14,
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '10px 16px 14px', fontSize: 11, color: 'rgba(148,163,184,0.55)', lineHeight: 1.5 }}>
        Capture the expiring placement's attachment/limit (as % of EPI),
        the gross EPI, the rate paid and the resulting ROL.
        {parseNum(rows[0]?.rate_pct) != null && parseNum(rows[0]?.limit_lr_pct) != null && (
          <span style={{ marginLeft: 8, color: 'rgba(0,212,255,0.85)' }}>
            Latest year ROL implied ≈ {((parseNum(rows[0].rate_pct) / parseNum(rows[0].limit_lr_pct)) * 100).toFixed(2)}%
          </span>
        )}
      </div>
    </section>
  );
}
