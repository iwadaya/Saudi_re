// src/screens/non_proportional/final_pricing/components/NpAggregateXlHero.jsx
//
// Bloomberg-style header for Aggregate XL treaties on the Final
// Pricing screen. Mirrors NpBloombergHero visually (same .bbg-*
// classes) so the look is consistent, but the metrics come from the
// Aggregate XL structure slice rather than the Risk XL / Cat XL
// layer grid.
//
// Aggregate XL covers a single aggregate annual loss; per-layer
// columns show that layer's Aggregate Limit / Aggregate Deductible
// / per-loss Deductible / AAD plus the Risk / Cat flags captured on
// the Structure page.

import { useMemo } from 'react';
import { toN, fmtC, money } from '../formatters.js';

/**
 * @param {{
 *   npDetail: object,
 *   aggXlInputs: object,   // appState.npAggregateXlInputs
 *   offerStatus: string,
 *   currency: string,
 *   techRatio: number,
 * }} props
 */
export default function NpAggregateXlHero({
  npDetail, aggXlInputs, offerStatus, currency, techRatio,
}) {
  const slice = aggXlInputs || {};
  const layers = useMemo(
    () => (Array.isArray(slice.layers) ? slice.layers : []),
    [slice.layers],
  );
  const cobs = useMemo(() => {
    const m = slice.classesOfBusiness;
    if (!m) return [];
    if (Array.isArray(m)) return m.filter((r) => r && (r.classOfBusiness || r.innerLimit));
    return Object.entries(m).map(([name, vals]) => ({ classOfBusiness: name, ...vals }));
  }, [slice.classesOfBusiness]);

  const egnpi   = toN(npDetail.estGnpi);
  const brok    = toN(npDetail.brokeragePct);
  const uwYear = npDetail.inceptionDate
    ? new Date(npDetail.inceptionDate).getFullYear()
    : (npDetail.startYear || '—');

  const layerCount = parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '0', 10)
    || layers.length || null;

  const {
    aggLimitTotal, aggDeductibleTotal, perLossDedRange, aadTotal,
    riskLayerCount, catLayerCount, innerLimitsTotal,
  } = useMemo(() => {
    const aggLim = layers.reduce((s, l) => s + toN(l.aggregateLimit), 0);
    const aggDed = layers.reduce((s, l) => s + toN(l.aggregateDeductible), 0);
    const perDedList = layers.map((l) => toN(l.deductible)).filter((n) => n > 0);
    const perDedMin = perDedList.length ? Math.min(...perDedList) : 0;
    const perDedMax = perDedList.length ? Math.max(...perDedList) : 0;
    const aad = layers.reduce((s, l) => s + toN(l.aad), 0);
    const innerLim = cobs.reduce((s, c) => s + toN(c.innerLimit), 0);
    return {
      aggLimitTotal:      aggLim,
      aggDeductibleTotal: aggDed,
      perLossDedRange:    { min: perDedMin, max: perDedMax, count: perDedList.length },
      aadTotal:           aad,
      riskLayerCount:     layers.filter((l) => !!l.risk).length,
      catLayerCount:      layers.filter((l) => !!l.cat).length,
      innerLimitsTotal:   innerLim,
    };
  }, [layers, cobs]);

  const totalROL = (egnpi > 0 && aggLimitTotal > 0)
    ? (aggLimitTotal / egnpi) * 100
    : 0;
  const rolColor = totalROL > 50 ? '#f87171'
    : totalROL > 20 ? '#fbbf24'
    : totalROL > 0 ? '#4ade80'
    : undefined;

  const statusColor = {
    DRAFT: 'rgba(148,163,184,0.5)', WAITING_APPROVAL: '#00d4ff',
    SIGNED: '#4ade80', DECLINED: '#f87171', NTU: '#00d4ff',
  }[offerStatus] || 'rgba(148,163,184,0.5)';

  const cedant   = npDetail.cedantName  || npDetail.cedant  || '';
  const quoteRef = npDetail.quoteRef    || npDetail.quote_ref || null;
  const country  = npDetail.countryName || npDetail.country || '';
  const cob = Array.isArray(npDetail.lineOfBusinessLabels) && npDetail.lineOfBusinessLabels.length
    ? npDetail.lineOfBusinessLabels.join(', ')
    : (npDetail.classOfBusiness || '');
  const broker   = npDetail.brokerName  || npDetail.broker  || '';

  const techRatioTotal = techRatio || 0;

  const fmtPerLossDed = () => {
    const { min, max, count } = perLossDedRange;
    if (count === 0) return '—';
    if (min === max) return money(min, currency);
    return `${money(min, currency)} – ${money(max, currency)}`;
  };

  return (
    <div className="bbg-hero">
      <div className="bbg-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="bbg-topbar-id">AGGREGATE XL</div>
          {quoteRef && (
            <span style={{
              fontSize: 9, padding: '2px 7px', borderRadius: 10,
              background: 'rgba(0,212,255,0.12)',
              border: '1px solid rgba(0,212,255,0.35)',
              color: '#00d4ff', fontWeight: 700, letterSpacing: '.04em',
            }}>
              {quoteRef}
            </span>
          )}
          {/* Policy-shape badges from the Structure page. */}
          {slice.franchiseDeductible && (
            <span style={{
              fontSize: 9, padding: '2px 7px', borderRadius: 10,
              background: 'rgba(168,85,247,0.12)',
              border: '1px solid rgba(168,85,247,0.35)',
              color: '#a855f7', fontWeight: 700, letterSpacing: '.04em',
            }}>
              FRANCHISE
            </span>
          )}
          {slice.structuredDeal && (
            <span style={{
              fontSize: 9, padding: '2px 7px', borderRadius: 10,
              background: 'rgba(251,191,36,0.12)',
              border: '1px solid rgba(251,191,36,0.35)',
              color: '#fbbf24', fontWeight: 700, letterSpacing: '.04em',
            }}>
              STRUCTURED
            </span>
          )}
        </div>
        <div className="bbg-topbar-meta">
          {cedant  && <span>CEDANT <b>{cedant}</b></span>}
          {country && <span>COUNTRY <b>{country}</b></span>}
          <span>COB <b>{cob || '—'}</b></span>
          {broker  && <span>BROKER <b>{broker}</b></span>}
          <span>CCY <b>{currency}</b></span>
          <span>UW YEAR <b>{uwYear}</b></span>
          <span style={{ color: statusColor, fontWeight: 700, letterSpacing: '.08em' }}>
            {(offerStatus || 'DRAFT').replace(/_/g, ' ')}
          </span>
        </div>
      </div>

      {/* Left col — Structure Metrics */}
      <div className="bbg-col">
        <div className="bbg-sec">▸ Structure Metrics</div>

        {[
          { k: 'Layers',                v: layerCount || '—' },
          { k: 'Total Aggregate Limit', v: aggLimitTotal ? money(aggLimitTotal, currency) : '—' },
          { k: 'Total Agg Deductible',  v: aggDeductibleTotal ? money(aggDeductibleTotal, currency) : '—' },
          { k: 'Per-Loss Deductible',   v: fmtPerLossDed() },
          { k: 'Total AAD',             v: aadTotal ? money(aadTotal, currency) : '—' },
          { k: 'Total ROL',             v: totalROL ? `${totalROL.toFixed(2)}%` : '—', color: rolColor },
        ].map((m) => (
          <div key={m.k} className="bbg-row">
            <span className="bbg-k">{m.k}</span>
            <span className="bbg-v" style={{ fontWeight: 400, ...(m.color ? { color: m.color } : {}) }}>
              <span className="bbg-dot" style={m.color ? { background: m.color } : undefined} />
              {m.v}
            </span>
          </div>
        ))}

        <div className="bbg-row bbg-row--subhead" style={{ marginTop: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,0.4)' }}>
            COST STRUCTURE
          </span>
        </div>
        <div className="bbg-row">
          <span className="bbg-k">Brokerage</span>
          <span className="bbg-v" style={{ fontWeight: 400 }}>
            <span className="bbg-dot" />
            {brok ? `${brok}%` : '—'}
          </span>
        </div>

        {techRatioTotal > 0 && (
          <>
            <div className="bbg-row">
              <span className="bbg-k">Technical Ratio</span>
              <span className="bbg-v" style={{
                fontWeight: 400,
                color: techRatioTotal > 100 ? '#f87171' : techRatioTotal > 80 ? '#00d4ff' : '#4ade80',
              }}>
                {techRatioTotal.toFixed(2)}%
              </span>
            </div>
            <div className="bbg-row">
              <span className="bbg-k">Result</span>
              <span className="bbg-v" style={{
                fontWeight: 400,
                color: (100 - techRatioTotal) < 0 ? '#f87171' : '#4ade80',
              }}>
                {(100 - techRatioTotal).toFixed(2)}%
              </span>
            </div>
          </>
        )}
      </div>

      <div className="bbg-divider" />

      {/* Centre — Programme */}
      <div className="bbg-center">
        <div className="bbg-prem-label">Est. GNPI · 100% Treaty</div>
        <div className="bbg-prem-ccy">{currency}</div>
        <div className="bbg-prem-val">{egnpi ? fmtC(Math.round(egnpi)) : '—'}</div>

        <div className="bbg-ctr-rows">
          <div className="bbg-ctr-row">
            <span className="bbg-ctr-k">Aggregate Limit</span>
            <span className="bbg-ctr-v" style={{ fontWeight: 400 }}>
              {aggLimitTotal ? money(aggLimitTotal, currency) : '—'}
            </span>
          </div>
          <div className="bbg-ctr-row">
            <span className="bbg-ctr-k">Treaty Type</span>
            <span className="bbg-ctr-v" style={{ fontWeight: 400 }}>AGGREGATE XL</span>
          </div>
          <div className="bbg-ctr-row">
            <span className="bbg-ctr-k">XL Type</span>
            <span className="bbg-ctr-v" style={{ fontWeight: 400 }}>{npDetail.xlType || '—'}</span>
          </div>
          <div className="bbg-ctr-row">
            <span className="bbg-ctr-k">Acctg Method</span>
            <span className="bbg-ctr-v" style={{ fontWeight: 400 }}>{npDetail.accountingMethod || '—'}</span>
          </div>
          <div className="bbg-ctr-row">
            <span className="bbg-ctr-k">Layers</span>
            <span className="bbg-ctr-v" style={{ fontWeight: 400 }}>{layerCount || '—'}</span>
          </div>
          <div className="bbg-ctr-row">
            <span className="bbg-ctr-k">Classes (Inner)</span>
            <span className="bbg-ctr-v" style={{ fontWeight: 400 }}>
              {cobs.length || '—'}
              {innerLimitsTotal > 0 && (
                <span style={{ marginLeft: 6, fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>
                  · {money(innerLimitsTotal, currency)} total
                </span>
              )}
            </span>
          </div>
        </div>

        <div className={`bbg-act-margin${totalROL < 3 && totalROL > 0 ? ' bbg-act-margin--neg' : ''}`}>
          <span className="lbl">TOTAL ROL</span>
          {totalROL ? `${totalROL.toFixed(2)}%` : '—'}
        </div>
      </div>

      <div className="bbg-divider" />

      {/* Right col — Per-layer breakdown */}
      <div className="bbg-col">
        <div className="bbg-sec">▸ Layer Structure</div>

        {layers.length === 0 ? (
          <div style={{ padding: '8px 0', fontSize: 11, color: 'rgba(148,163,184,0.55)' }}>
            No layers configured — set on the Structure page.
          </div>
        ) : (
          layers.map((l, i) => {
            const aggLim = toN(l.aggregateLimit);
            const aggDed = toN(l.aggregateDeductible);
            return (
              <div key={i}>
                <div className="bbg-row bbg-row--subhead" style={{ marginTop: i === 0 ? 2 : 6 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '.1em',
                    color: 'rgba(0,212,255,0.85)',
                  }}>
                    LAYER {i + 1}
                  </span>
                  <span style={{ display: 'flex', gap: 4 }}>
                    {l.risk && (
                      <span style={{
                        fontSize: 8, padding: '1px 5px', borderRadius: 6,
                        background: 'rgba(96,165,250,0.15)',
                        color: 'rgba(96,165,250,0.95)', fontWeight: 700,
                      }}>RISK</span>
                    )}
                    {l.cat && (
                      <span style={{
                        fontSize: 8, padding: '1px 5px', borderRadius: 6,
                        background: 'rgba(0,212,255,0.15)',
                        color: 'rgba(0,212,255,0.95)', fontWeight: 700,
                      }}>CAT</span>
                    )}
                  </span>
                </div>
                <div className="bbg-row" style={{ paddingLeft: 10 }}>
                  <span className="bbg-k" style={{ color: 'rgba(255,255,255,0.45)' }}>Agg Limit</span>
                  <span className="bbg-v" style={{ fontWeight: 400, color: 'rgba(0,212,255,0.9)' }}>
                    {aggLim ? money(aggLim, currency) : '—'}
                  </span>
                </div>
                <div className="bbg-row" style={{ paddingLeft: 10 }}>
                  <span className="bbg-k" style={{ color: 'rgba(255,255,255,0.45)' }}>Agg Deductible</span>
                  <span className="bbg-v" style={{ fontWeight: 400, color: 'rgba(0,212,255,0.9)' }}>
                    {aggDed ? money(aggDed, currency) : '—'}
                  </span>
                </div>
              </div>
            );
          })
        )}

        {(riskLayerCount > 0 || catLayerCount > 0) && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>
            {riskLayerCount > 0 && <span style={{ marginRight: 10 }}>{riskLayerCount} risk</span>}
            {catLayerCount > 0 && <span>{catLayerCount} cat</span>}
          </div>
        )}
      </div>
    </div>
  );
}
