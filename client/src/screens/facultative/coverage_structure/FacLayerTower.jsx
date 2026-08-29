// src/screens/facultative/coverage_structure/FacLayerTower.jsx
//
// The excess tower. A facultative XL placement is rarely one band — it is a
// primary layer and one or more excess layers, each with its own limit,
// share, reinstatements and price. Before migration 136 `fac_risk` carried a
// single retention/limit pair, so a three-layer placement could be recorded
// only as one of its layers and the other two lived in a broker's email.
//
// ROL and payback are derived here, never typed: ROL = premium ÷ limit, and
// payback = 1 ÷ ROL, the number of clean years a layer needs to repay one
// total loss. They are the two numbers an excess underwriter actually reads,
// and deriving them means they cannot disagree with the premium above them.

import { useCallback, useMemo } from 'react';
import { rateOnLine, paybackYears, totalCover } from '../../../../../shared/fac/layers.js';
import './FacLayerTower.css';

import { formatWithCommasDecimal, numOrNull, sanitizeNumber } from '../../../utils/format';
const money = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))
  ? '—'
  : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const pct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))
  ? '—'
  : `${(Number(v) * 100).toFixed(2)}%`);
const years = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))
  ? '—'
  : `${Number(v).toFixed(1)} yrs`);

export const EMPTY_LAYER = {
  layer_no: 1,
  attachment: '',
  limit_amount: '',
  our_share_pct: '',
  reinstatements: '',
  premium: '',
  loss_cost: '',
  notes: '',
};

/**
 * @param {object} props
 * @param {Array<object>} props.layers
 * @param {(layers: Array<object>) => void} props.onChange
 * @param {boolean} [props.readOnly]
 */
export default function FacLayerTower({ layers, onChange, readOnly = false }) {
  const rows = useMemo(() => layers || [], [layers]);

  const setRow = useCallback((index, key, value) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  }, [rows, onChange]);

  const addRow = useCallback(() => {
    const nextNo = rows.reduce((max, r) => Math.max(max, Number(r.layer_no) || 0), 0) + 1;
    // A new layer attaches where the one below it tops out — the usual case,
    // and still editable when the tower has a gap in it.
    const below = rows[rows.length - 1];
    const attach = below
      ? String((numOrNull(below.attachment) ?? 0) + (numOrNull(below.limit_amount) ?? 0))
      : '';
    onChange([...rows, { ...EMPTY_LAYER, layer_no: nextNo, attachment: attach }]);
  }, [rows, onChange]);

  const removeRow = useCallback((index) => {
    onChange(rows.filter((_, i) => i !== index).map((r, i) => ({ ...r, layer_no: i + 1 })));
  }, [rows, onChange]);

  const derived = useMemo(() => rows.map((r) => {
    const limit = numOrNull(r.limit_amount);
    const premium = numOrNull(r.premium);
    const rol = rateOnLine(premium, limit);
    const share = numOrNull(r.our_share_pct);
    return {
      rol,
      payback: paybackYears(rol),
      cover: totalCover({
        limit_amount: limit,
        reinstatements: numOrNull(r.reinstatements),
        aggregate_limit: numOrNull(r.aggregate_limit),
      }),
      ourPremium: premium !== null && share !== null ? premium * (share / 100) : null,
      unlimitedLimit: limit === null && String(r.limit_amount ?? '').trim() === '',
    };
  }), [rows]);

  const totals = useMemo(() => ({
    premium: rows.reduce((t, r) => t + (numOrNull(r.premium) ?? 0), 0),
    ourPremium: derived.reduce((t, d) => t + (d.ourPremium ?? 0), 0),
    cover: derived.reduce((t, d) => (d.cover === null ? t : t + d.cover), 0),
  }), [rows, derived]);

  return (
    <div className="fac-tower">
      <p className="fac-tower__intro">
        One row per layer. Rate on line and payback are derived from the premium and the
        limit — ROL is premium ÷ limit, payback is the clean years a layer needs to repay
        one total loss. Leave the limit blank for an unlimited top layer, and the
        reinstatements blank for unlimited free ones; both are different from zero.
      </p>

      {rows.length === 0 ? (
        <div className="fac-tower__empty">
          No layers recorded. A single-band placement can stay on the retention and limit
          above; add layers here when the placement is a tower.
        </div>
      ) : (
        <div className="fac-tower__scroll">
          <table className="fac-tower__table">
            <thead>
              <tr>
                <th>Layer</th>
                <th>Attachment</th>
                <th>Limit</th>
                <th>Our share</th>
                <th>R/I</th>
                <th>Premium (100%)</th>
                <th className="fac-tower__num">ROL</th>
                <th className="fac-tower__num">Payback</th>
                <th className="fac-tower__num">Total cover</th>
                <th className="fac-tower__num">Our premium</th>
                {!readOnly && <th aria-label="Remove layer" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.layer_id || `layer-${r.layer_no}-${i}`}>
                  <td>{r.layer_no}</td>
                  <td>
                    <input
                      className="fi" type="text" inputMode="decimal" readOnly={readOnly}
                      aria-label={`Layer ${r.layer_no} attachment`}
                      value={formatWithCommasDecimal(r.attachment)}
                      onChange={(e) => setRow(i, 'attachment', sanitizeNumber(e.target.value))}
                    />
                  </td>
                  <td>
                    <input
                      className="fi" type="text" inputMode="decimal" readOnly={readOnly}
                      aria-label={`Layer ${r.layer_no} limit`}
                      placeholder="Unlimited"
                      value={formatWithCommasDecimal(r.limit_amount)}
                      onChange={(e) => setRow(i, 'limit_amount', sanitizeNumber(e.target.value))}
                    />
                  </td>
                  <td>
                    <input
                      className="fi fac-tower__narrow" type="number" readOnly={readOnly}
                      aria-label={`Layer ${r.layer_no} our share percent`}
                      min={0} max={100} step={0.01}
                      value={r.our_share_pct ?? ''}
                      onChange={(e) => setRow(i, 'our_share_pct', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="fi fac-tower__narrow" type="number" readOnly={readOnly}
                      aria-label={`Layer ${r.layer_no} reinstatements`}
                      min={0} step={1} placeholder="∞"
                      value={r.reinstatements ?? ''}
                      onChange={(e) => setRow(i, 'reinstatements', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="fi" type="text" inputMode="decimal" readOnly={readOnly}
                      aria-label={`Layer ${r.layer_no} premium`}
                      value={formatWithCommasDecimal(r.premium)}
                      onChange={(e) => setRow(i, 'premium', sanitizeNumber(e.target.value))}
                    />
                  </td>
                  <td className="fac-tower__num fac-tower__derived">{pct(derived[i].rol)}</td>
                  <td className="fac-tower__num fac-tower__derived">{years(derived[i].payback)}</td>
                  <td className="fac-tower__num fac-tower__derived">
                    {derived[i].cover === null
                      ? <span className="fac-tower__derived--muted">Unlimited</span>
                      : money(derived[i].cover)}
                  </td>
                  <td className="fac-tower__num fac-tower__derived">{money(derived[i].ourPremium)}</td>
                  {!readOnly && (
                    <td>
                      <button
                        type="button"
                        className="fac-tower__btn fac-tower__btn--row"
                        onClick={() => removeRow(i)}
                        aria-label={`Remove layer ${r.layer_no}`}
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!readOnly && (
        <div className="fac-tower__actions">
          <button type="button" className="fac-tower__btn" onClick={addRow}>Add layer</button>
        </div>
      )}

      {rows.length > 0 && (
        <div className="fac-tower__totals">
          <span>Layers <strong>{rows.length}</strong></span>
          <span>Premium (100%) <strong>{money(totals.premium)}</strong></span>
          <span>Our premium <strong>{money(totals.ourPremium)}</strong></span>
          <span>Total cover <strong>{money(totals.cover)}</strong></span>
        </div>
      )}

      <p className="fac-tower__note">
        Reinstatement terms — the percentage of premium, and whether each is pro rata as to
        time, as to amount, or both — are recorded per layer on the slip. They are priced
        only where the slip states them; nothing here assumes a convention.
      </p>
    </div>
  );
}
