// src/screens/non_proportional/final_pricing/components/NpLayerTable.jsx
//
// The Risk XL / Cat XL pricing table. Both variants were inline
// in NpFinalPricing — identical structure, only the column header
// subtitle ("MBBEFD" vs "Dmg Ratio"), the field name prefix
// ("risk*" vs "cat*"), and a couple of colour accents differ.
//
// Consolidating into one component keeps the layout guaranteed-
// consistent across the two sections and shaves ~180 lines from
// the parent file.

import { fmtC, toN } from '../formatters.js';

const SECTION_CONFIG = {
  RISK: {
    title:       'Risk XL Layers',
    badge:       'RISK XL',
    exposureSub: 'MBBEFD',
    emptyText:   'No risk layers configured.',
    prefix:      'risk',
    // PureBurn + Pareto get coloured pill backgrounds on the Risk
    // side; Cat only colour-highlights PureBurn.
    pureBurnExtraClass: 'np-val-pill--burn-input',
    paretoInputStyle: {
      background: 'rgba(59,130,246,0.12)',
      borderColor: 'rgba(59,130,246,0.35)',
      color: '#93c5fd',
      fontWeight: 700,
    },
  },
  CAT: {
    title:       'Cat XL Layers',
    badge:       'CAT XL',
    exposureSub: 'Dmg Ratio',
    emptyText:   'No cat layers configured.',
    prefix:      'cat',
    pureBurnExtraClass: '',
    paretoInputStyle: undefined,
  },
};

// Shared style fragments used by both sections.
const PURE_BURN_STYLE = {
  background: 'rgba(239,68,68,0.12)',
  borderColor: 'rgba(239,68,68,0.35)',
  color: '#fca5a5',
  fontWeight: 700,
};

// Weight column borders — colour-coded to the component they belong to.
// Matches the Pure Burn (red) and Pareto (blue) input pill colours so the
// underwriter can visually trace which weight column drives which rate.
const WT_BURN_STYLE = {
  borderColor: 'rgba(239,68,68,0.55)',
  borderWidth: 1.5,
};
const WT_PARETO_STYLE = {
  borderColor: 'rgba(59,130,246,0.55)',
  borderWidth: 1.5,
};

// Weighted-average helpers are duplicated in both inline versions;
// keeping them co-located with the JSX they serve.
function pctWt(rows, totalLim, field) {
  if (!totalLim) return '—';
  const wt = rows.reduce(
    (s, l) => s + toN(l.limit) * (parseFloat(String(l[field] || '0').replace(/%/g, '')) || 0),
    0,
  );
  return (wt / totalLim).toFixed(2) + '%';
}

function avgField(rows, field, dflt) {
  if (!rows.length) return '—';
  const s = rows.reduce(
    (a, l) => a + (parseFloat(String(l[field] || dflt || '0').replace(/%/g, '')) || 0),
    0,
  );
  return (s / rows.length).toFixed(0);
}

/**
 * @param {{
 *   section: 'RISK' | 'CAT',
 *   rows: Array<object>,        // subset of layers being rendered
 *   layers: Array<object>,      // full layers array for indexOf lookup
 *   updateLayer: (idx:number, field:string, value:string) => void,
 * }} props
 */
export default function NpLayerTable({ section, rows, layers, updateLayer, disabled = false }) {
  const cfg = SECTION_CONFIG[section];
  if (!cfg) return null;
  const k = (suffix) => `${cfg.prefix}${suffix}`;

  const totalLim = rows.reduce((s, l) => s + toN(l.limit), 0);

  // When the offer has hit a terminal status (SIGNED / NTU / DECLINED) the
  // pricing inputs need to lock — otherwise a stale browser tab can mutate
  // a contract whose pricing has already been bound or rejected. Browsers
  // dim disabled inputs by default so we don't need extra styling.
  const inputProps = disabled ? { disabled: true, tabIndex: -1 } : {};

  return (
    <section className="np-final-section">
      <div className="np-final-section-head">
        <div className="np-final-section-title">{cfg.title}</div>
        <span className="np-badge">{cfg.badge}</span>
      </div>
      <div className="np-final-card np-final-card--flush">
        <div className="np-final-table-wrap np-final-table-wrap--wide">
          <table className="np-final-wide-table np-final-wide-table--layers">
            <thead>
              <tr>
                <th className="col-layer">Layer</th>
                <th className="col-limit">Limit</th>
                <th className="col-deductible">Deductible</th>
                <th className="col-compact">Pure Burn</th>
                <th className="col-compact">Pareto</th>
                <th className="col-compact">Burn + Pareto</th>
                <th className="col-compact">Exposure<br /><span style={{ fontSize: 9, opacity: 0.6 }}>{cfg.exposureSub}</span></th>
                <th className="col-compact">Wt Burn %</th>
                <th className="col-compact">Wt Pareto %</th>
                <th className="col-compact">Wt Exp %</th>
                <th className="col-compact">Loading %</th>
                <th className="col-compact">Total ROL</th>
                <th className="col-compact col-uw">UW Price</th>
                <th className="col-prob">Prob. Attachment</th>
                <th className="col-prob">Prob. Exhaustion</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const gi = layers.indexOf(l);
                const pureBurnClass = `np-mini-input${cfg.pureBurnExtraClass ? ' ' + cfg.pureBurnExtraClass : ''}`;
                return (
                  <tr key={l.layer}>
                    <td className="col-layer"><span className={`np-layer-num-badge np-layer-num-badge--${l.layer}`}>{l.layer}</span></td>
                    <td className="col-limit">{fmtC(l.limit)}</td>
                    <td className="col-deductible">{fmtC(l.deductible)}</td>
                    <td>
                      <input className={pureBurnClass}
                        value={l[k('PureBurn')] || '0.00%'}
                        onChange={(e) => updateLayer(gi, k('PureBurn'), e.target.value)}
                        style={PURE_BURN_STYLE}
                        {...inputProps} />
                    </td>
                    <td>
                      <input className="np-mini-input"
                        value={l[k('Pareto')] || '0.00%'}
                        onChange={(e) => updateLayer(gi, k('Pareto'), e.target.value)}
                        style={cfg.paretoInputStyle}
                        {...inputProps} />
                    </td>
                    <td className="muted">{l[k('AvgBurnPareto')] || '0.00%'}</td>
                    <td>
                      <input className="np-mini-input"
                        value={l[k('Exposure')] || '0.00%'}
                        onChange={(e) => updateLayer(gi, k('Exposure'), e.target.value)}
                        {...inputProps} />
                    </td>
                    <td>
                      <input className="np-mini-input"
                        value={l[k('WeightBurn')] || '50'}
                        onChange={(e) => updateLayer(gi, k('WeightBurn'), e.target.value)}
                        style={WT_BURN_STYLE}
                        {...inputProps} />
                    </td>
                    <td>
                      <input className="np-mini-input"
                        value={l[k('WeightPareto')] || '0'}
                        onChange={(e) => updateLayer(gi, k('WeightPareto'), e.target.value)}
                        style={WT_PARETO_STYLE}
                        {...inputProps} />
                    </td>
                    <td>
                      <span className="np-mini-input" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.7, cursor: 'default' }}>
                        {l[k('WeightExposure')] || '50'}
                      </span>
                    </td>
                    <td>
                      <input className="np-mini-input"
                        value={l[k('Loading')] || '15'}
                        onChange={(e) => updateLayer(gi, k('Loading'), e.target.value)}
                        {...inputProps} />
                    </td>
                    <td style={{ color: '#00d4ff', fontWeight: 800, fontSize: 14 }}>{l[k('TotalPrice')] || '0.00%'}</td>
                    <td>
                      <input className="np-mini-input np-mini-input--uw"
                        value={l[k('UwPrice')] || '0.00%'}
                        placeholder={l[k('TotalPrice')] || '0.00%'}
                        onChange={(e) => updateLayer(gi, k('UwPrice'), e.target.value)}
                        {...inputProps} />
                    </td>
                    <td>
                      <input className="np-mini-input"
                        value={l[k('PrAttach')] || '0.00%'}
                        onChange={(e) => updateLayer(gi, k('PrAttach'), e.target.value)}
                        {...inputProps} />
                    </td>
                    <td>
                      <input className="np-mini-input"
                        value={l[k('PrExhaust')] || '0.00%'}
                        onChange={(e) => updateLayer(gi, k('PrExhaust'), e.target.value)}
                        {...inputProps} />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={15} className="muted" style={{ padding: 16 }}>{cfg.emptyText}</td></tr>
              )}
              {rows.length > 0 && (
                <tr className="np-struct-total">
                  <td className="col-layer"><span className="np-layer-num-badge np-layer-num-badge--total">TOTAL</span></td>
                  <td className="col-limit"><b>{fmtC(totalLim)}</b></td>
                  <td className="col-deductible"></td>
                  <td style={{ fontWeight: 700 }}>{pctWt(rows, totalLim, k('PureBurn'))}</td>
                  <td style={{ fontWeight: 700 }}>{pctWt(rows, totalLim, k('Pareto'))}</td>
                  <td style={{ fontWeight: 700 }}>{pctWt(rows, totalLim, k('AvgBurnPareto'))}</td>
                  <td style={{ fontWeight: 700 }}>{pctWt(rows, totalLim, k('Exposure'))}</td>
                  <td>{avgField(rows, k('WeightBurn'), '50')}</td>
                  <td>{avgField(rows, k('WeightPareto'), '0')}</td>
                  <td>{avgField(rows, k('WeightExposure'), '50')}</td>
                  <td>{avgField(rows, k('Loading'), '15')}</td>
                  <td style={{ color: '#00d4ff', fontWeight: 800, fontSize: 14 }}>{pctWt(rows, totalLim, k('TotalPrice'))}</td>
                  <td style={{ fontWeight: 700 }}>{pctWt(rows, totalLim, k('UwPrice'))}</td>
                  <td></td>
                  <td></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
