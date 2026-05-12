// src/screens/non_proportional/final_pricing/components/NpTechAnalysisModal.jsx
//
// "Technical Analysis" modal — treaty-metrics % changes vs previous
// year, EGNPI row, and a read-only view of the underwriting-limits
// grid (class × layer). Read-only-ish; only the metric inputs write
// back through setTreatyMetrics. Extracted from NpFinalPricing.jsx.

import { fmtC, toN } from '../formatters.js';

const METRIC_ROWS = [
  { k: 'ded_pct_cover',    label: 'Deductible as % of Cover' },
  { k: 'ded_pct_egnpi',    label: 'Deductible as % EGNPI' },
  { k: 'chg_egnpi',        label: '% Change EGNPI' },
  { k: 'chg_aggregates',   label: '% Change Aggregates' },
  { k: 'chg_rates',        label: '% Change in Rates' },
  { k: 'chg_risk_profile', label: '% Change in Risk Profile' },
];

function pctChange(prev, curr) {
  const pN = parseFloat(String(prev).replace(/[^\d.-]/g, ''));
  const cN = parseFloat(String(curr).replace(/[^\d.-]/g, ''));
  if (isNaN(pN) || isNaN(cN) || pN === 0) return null;
  return ((cN - pN) / Math.abs(pN)) * 100;
}

function formatChange(v) {
  if (v === null) return '';
  return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
}

// Status colour for up/down. These are deliberate semantic colours
// (green=up, red=down) so they stay hardcoded rather than theme tokens.
function changeColor(v) {
  if (v === null) return undefined;
  return v > 0 ? '#4ade80' : v < 0 ? '#f87171' : undefined;
}

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   treatyMetrics: Record<string, any>,
 *   setTreatyMetrics: (updater: (prev:object)=>object) => void,
 *   expiringEgnpi: number | null,
 *   npDetail: { estGnpi?: number|string },
 *   cobUwLimits: Array<{ cob_name?:string, cob_id?:string, limit_amount?:number, layers?:boolean[] }>,
 * }} props
 */
export default function NpTechAnalysisModal({
  open, onClose, treatyMetrics, setTreatyMetrics,
  expiringEgnpi, npDetail, cobUwLimits,
}) {
  if (!open) return null;

  return (
    <div
      className="screen-modal-backdrop"
      style={{ display: 'flex' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="screen-modal screen-modal--fullwidth" role="dialog">
        <div className="screen-modal-header">
          <div className="screen-modal-title">Technical Analysis</div>
          <button className="screen-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="screen-modal-body" style={{ padding: '16px 20px', overflowY: 'auto', maxHeight: 'calc(85vh - 60px)' }}>
          <div className="np-final-mid-grid" style={{ marginBottom: 20, alignItems: 'stretch' }}>

            {/* LEFT: Treaty Metrics with EGNPI as a bottom row */}
            <section className="np-final-card" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="np-final-card-subhead">Treaty Metrics</div>
              <div className="np-final-table-wrap" style={{ flex: 1 }}>
                <table className="np-final-table np-treaty-metrics-table">
                  <thead>
                    <tr>
                      <th className="tm-col-metric">Metric</th>
                      <th className="tm-col-val">Previous Year</th>
                      <th className="tm-col-val">Current Year</th>
                      <th className="tm-col-chg">% Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {METRIC_ROWS.map(({ k, label }) => {
                      const prev = treatyMetrics[k + '_prev'] ?? '';
                      const curr = treatyMetrics[k + '_curr'] ?? '';
                      const chgVal = pctChange(prev, curr);
                      const chgStr = chgVal !== null
                        ? formatChange(chgVal)
                        : (prev && curr ? '—' : '');
                      const chgColor = changeColor(chgVal);
                      return (
                        <tr key={k}>
                          <td className="tm-col-metric">{label}</td>
                          <td className="tm-col-val">
                            <input
                              className="np-mini-input tm-input"
                              value={prev}
                              placeholder="—"
                              onChange={(e) => setTreatyMetrics((p) => ({ ...p, [k + '_prev']: e.target.value }))}
                            />
                          </td>
                          <td className="tm-col-val">
                            <input
                              className="np-mini-input tm-input"
                              value={curr}
                              placeholder="—"
                              onChange={(e) => setTreatyMetrics((p) => ({ ...p, [k + '_curr']: e.target.value }))}
                            />
                          </td>
                          <td className="tm-col-chg" style={chgColor ? { color: chgColor, fontWeight: 700 } : undefined}>
                            {chgStr || '—'}
                          </td>
                        </tr>
                      );
                    })}
                    {(() => {
                      const prev = expiringEgnpi;
                      const curr = toN(npDetail?.estGnpi);
                      const chgVal = (prev && curr) ? ((curr - prev) / Math.abs(prev)) * 100 : null;
                      const chgStr = chgVal !== null ? formatChange(chgVal) : '—';
                      const chgColor = changeColor(chgVal);
                      return (
                        <tr style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                          <td className="tm-col-metric" style={{ fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>EGNPI</td>
                          <td className="tm-col-val">
                            <input className="np-mini-input tm-input" readOnly value={prev ? fmtC(Math.round(prev)) : ''} placeholder="—" />
                          </td>
                          <td className="tm-col-val">
                            <input className="np-mini-input tm-input" readOnly value={curr ? fmtC(Math.round(curr)) : ''} placeholder="—" />
                          </td>
                          <td className="tm-col-chg" style={chgColor ? { color: chgColor, fontWeight: 700 } : undefined}>
                            {chgStr}
                          </td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
              </div>
            </section>

            {/* RIGHT: Underwriting Limits only */}
            <section className="np-final-card" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="np-final-card-subhead">Classes of Business &amp; Underwriting Limits</div>
              {cobUwLimits.length > 0 ? (
                <div style={{ flex: 1 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left',   padding: '4px 8px 8px 0', color: 'rgba(255,255,255,0.4)', fontWeight: 600, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>Class</th>
                        <th style={{ textAlign: 'right',  padding: '4px 8px 8px',   color: 'rgba(255,255,255,0.4)', fontWeight: 600, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>UW Limit</th>
                        {(cobUwLimits[0]?.layers || []).map((_, i) => (
                          <th key={i} style={{ textAlign: 'center', padding: '4px 6px 8px', color: 'rgba(255,255,255,0.4)', fontWeight: 600, fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>L{i + 1}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {cobUwLimits.map((row, ri) => (
                        <tr key={ri}>
                          <td style={{ padding: '7px 8px 7px 0', color: 'rgba(255,255,255,0.75)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>{row.cob_name || row.cob_id}</td>
                          <td style={{ textAlign: 'right', padding: '7px 8px', color: 'rgba(255,255,255,0.85)', fontWeight: 500, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>{fmtC(row.limit_amount) || '–'}</td>
                          {(row.layers || []).map((checked, li) => (
                            <td key={li} style={{ textAlign: 'center', padding: '7px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', color: checked ? '#4ade80' : 'rgba(255,255,255,0.15)', fontSize: 13 }}>
                              {checked ? '☑' : '☐'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>
                  No underwriting limits configured.
                </div>
              )}
            </section>

          </div>
        </div>
      </div>
    </div>
  );
}
