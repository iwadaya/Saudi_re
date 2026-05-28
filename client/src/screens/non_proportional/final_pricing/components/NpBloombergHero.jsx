// src/screens/non_proportional/final_pricing/components/NpBloombergHero.jsx
// The Bloomberg-style header at the top of the NP Final Pricing
// screen. Shows structure metrics, treaty type, EGNPI, and layer
// breakdowns for risk/cat/both modes. Pure presentational — every
// derived metric is computed inside a single useMemo from the
// structureLayers prop.

import { useMemo } from 'react';
import { toN, fmtC, money } from '../formatters.js';

/**
 * @param {{
 *   npDetail: object,                 // treaty detail (estGnpi, brokeragePct, etc.)
 *   structureLayers: Array<object>,   // layers from the Structure screen
 *   mode: 'RISK' | 'CAT' | 'BOTH' | string,
 *   offerStatus: string,
 *   currency: string,
 *   techRatio: number,
 *   onInsight?: (key: string) => void,
 * }} props
 */
export default function NpBloombergHero({
  npDetail, structureLayers: _sl, mode, offerStatus, currency, techRatio,
}) {
  const structureLayers = useMemo(() => (Array.isArray(_sl) ? _sl : []), [_sl]);

  const egnpi   = toN(npDetail.estGnpi);
  const brok    = toN(npDetail.brokeragePct);
  const treatyType = npDetail.treatyTypeName || npDetail.treatyType || '';
  const uwYear = npDetail.inceptionDate
    ? new Date(npDetail.inceptionDate).getFullYear()
    : (npDetail.startYear || '—');

  const numLayersFromDetail = parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '0', 10) || 0;

  const {
    allLimitTotal, riskLimitTotal, catLimitTotal,
    riskDed, catDed,
    riskLayerCount, catLayerCount,
    totalEarnedPrem, totalROL,
  } = useMemo(() => {
    const riskLayers = structureLayers.filter(l => l.riskCover === true || l.risk === true);
    const catLayers  = structureLayers.filter(l => l.catCover  === true || l.cat  === true);
    const allLim  = structureLayers.reduce((s, l) => s + toN(l.limit), 0);
    const riskLim = riskLayers.reduce((s, l) => s + toN(l.limit), 0);
    const catLim  = catLayers.reduce((s, l) => s + toN(l.limit), 0);
    const riskD = toN(riskLayers[0]?.deductible);
    const catD  = toN(catLayers[0]?.deductible);
    let ep = 0, lim = 0;
    for (const l of structureLayers) {
      const limN   = toN(l.limit);
      const epN    = toN(l.earnedPremium);
      const rolPct = parseFloat(String(l.rol || '').replace(/%/g, '')) || 0;
      ep  += epN > 0 ? epN : (rolPct > 0 && limN > 0 ? (rolPct / 100) * limN : 0);
      lim += limN;
    }
    return {
      allLimitTotal:   allLim,
      riskLimitTotal:  riskLim,
      catLimitTotal:   catLim,
      riskDed:         riskD,
      catDed:          catD,
      riskLayerCount:  riskLayers.length,
      catLayerCount:   catLayers.length,
      totalEarnedPrem: ep,
      totalROL:        (ep > 0 && lim > 0) ? (ep / lim) * 100 : 0,
    };
  }, [structureLayers]);

  const displayLayerCount = structureLayers.length || numLayersFromDetail || null;
  const showRisk = mode === 'RISK' || mode === 'BOTH';
  const showCat  = mode === 'CAT'  || mode === 'BOTH';

  const statusColor = {
    DRAFT: 'rgba(148,163,184,0.5)', AWAITING_APPROVAL: '#00d4ff',
    SIGNED: '#4ade80', DECLINED: '#f87171', NTU: '#00d4ff',
  }[offerStatus] || 'rgba(148,163,184,0.5)';

  const modeLabel = mode === 'RISK' ? 'RISK XL'
    : mode === 'CAT'  ? 'CAT XL'
    : mode === 'BOTH' ? 'RISK & CAT XL'
    : treatyType.toUpperCase() || 'XL';

  const cedant   = npDetail.cedantName  || npDetail.cedant  || '';
  const quoteRef = npDetail.quoteRef    || npDetail.quote_ref || null;
  const country  = npDetail.countryName || npDetail.country || '';
  const cob = Array.isArray(npDetail.lineOfBusinessLabels) && npDetail.lineOfBusinessLabels.length
    ? npDetail.lineOfBusinessLabels.join(', ')
    : (npDetail.classOfBusiness || '');
  const broker   = npDetail.brokerName  || npDetail.broker  || '';

  const rolColor = totalROL > 10 ? '#4ade80' : totalROL > 5 ? '#00d4ff' : totalROL > 0 ? '#f87171' : undefined;

  const rightMetrics = [
    { k: 'Brokerage', v: brok ? `${brok}%` : '—' },
  ];

  const techRatioTotal = techRatio || 0;

  return (
    <div className="bbg-hero">
      <div className="bbg-topbar">
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div className="bbg-topbar-id">{modeLabel}</div>
          {quoteRef && (
            <span style={{
              fontSize: 9, padding: '2px 7px', borderRadius: 10,
              background: 'rgba(0,212,255,0.12)',
              border: '1px solid rgba(0,212,255,0.35)',
              color: '#00d4ff', fontWeight: 700, letterSpacing: 0,
            }}>
              {quoteRef}
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
          <span style={{ color: statusColor, fontWeight: 700, letterSpacing: 0 }}>
            {(offerStatus || 'DRAFT').replace(/_/g, ' ')}
          </span>
        </div>
      </div>

      {/* Left col — Structure Metrics */}
      <div className="bbg-col">
        <div className="bbg-sec">▸ Structure Metrics</div>

        {[
          { k: 'Layers', v: displayLayerCount || '—' },
          { k: 'Total Earned Prem', v: totalEarnedPrem ? money(totalEarnedPrem, currency) : '—' },
          { k: 'Total ROL', v: totalROL ? `${totalROL.toFixed(2)}%` : '—', color: rolColor },
        ].map(m => (
          <div key={m.k} className="bbg-row">
            <span className="bbg-k">{m.k}</span>
            <span className="bbg-v" style={{ fontWeight: 400, ...(m.color ? { color: m.color } : {}) }}>
              <span className="bbg-dot" style={m.color ? { background: m.color } : undefined} />
              {m.v}
            </span>
          </div>
        ))}

        <div className="bbg-row bbg-row--subhead" style={{ marginTop: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0, color: 'rgba(255,255,255,0.4)' }}>
            COST STRUCTURE
          </span>
        </div>
        {rightMetrics.map(m => (
          <div key={m.k} className="bbg-row">
            <span className="bbg-k">{m.k}</span>
            <span className="bbg-v" style={{ fontWeight: 400 }}>
              <span className="bbg-dot" />
              {m.v}
            </span>
          </div>
        ))}

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

        {npDetail.maxRetention && (
          <div className="bbg-row" style={{ marginTop: 4 }}>
            <span className="bbg-k">Max Retention</span>
            <span className="bbg-v" style={{ fontWeight: 400 }}>
              {money(toN(npDetail.maxRetention), currency)}
            </span>
          </div>
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
            <span className="bbg-ctr-k">Total Limit</span>
            <span className="bbg-ctr-v" style={{ fontWeight: 400 }}>
              {allLimitTotal ? money(allLimitTotal, currency) : '—'}
            </span>
          </div>
          <div className="bbg-ctr-row">
            <span className="bbg-ctr-k">Treaty Type</span>
            <span className="bbg-ctr-v" style={{ fontWeight: 400 }}>{modeLabel}</span>
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
            <span className="bbg-ctr-v" style={{ fontWeight: 400 }}>{displayLayerCount || '—'}</span>
          </div>
        </div>

        <div className={`bbg-act-margin${totalROL < 3 && totalROL > 0 ? ' bbg-act-margin--neg' : ''}`}>
          <span className="lbl">TOTAL ROL</span>
          {totalROL ? `${totalROL.toFixed(2)}%` : '—'}
        </div>
      </div>

      <div className="bbg-divider" />

      {/* Right col — Risk/Cat structure breakdown */}
      <div className="bbg-col">
        <div className="bbg-sec">▸ Layer Structure</div>

        {showRisk && (
          <>
            <div className="bbg-row bbg-row--subhead" style={{ marginTop: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0, color: 'rgba(96,165,250,0.8)' }}>
                RISK XL
              </span>
            </div>
            {[
              { k: 'Layers',      v: riskLayerCount || '—' },
              { k: 'Deductible',  v: riskDed ? money(riskDed, currency) : '—' },
              { k: 'Total Limit', v: riskLimitTotal ? money(riskLimitTotal, currency) : '—' },
            ].map(m => (
              <div key={`risk-${m.k}`} className="bbg-row" style={{ paddingLeft: 10 }}>
                <span className="bbg-k" style={{ color: 'rgba(255,255,255,0.45)' }}>{m.k}</span>
                <span className="bbg-v" style={{ fontWeight: 400, color: 'rgba(96,165,250,0.9)' }}>{m.v}</span>
              </div>
            ))}
          </>
        )}

        {showCat && (
          <>
            <div className="bbg-row bbg-row--subhead" style={{ marginTop: showRisk ? 6 : 2 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0, color: 'rgba(0,212,255,0.85)' }}>
                CAT XL
              </span>
            </div>
            {[
              { k: 'Layers',      v: catLayerCount || '—' },
              { k: 'Deductible',  v: catDed ? money(catDed, currency) : '—' },
              { k: 'Total Limit', v: catLimitTotal ? money(catLimitTotal, currency) : '—' },
            ].map(m => (
              <div key={`cat-${m.k}`} className="bbg-row" style={{ paddingLeft: 10 }}>
                <span className="bbg-k" style={{ color: 'rgba(255,255,255,0.45)' }}>{m.k}</span>
                <span className="bbg-v" style={{ fontWeight: 400, color: 'rgba(0,212,255,0.9)' }}>{m.v}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
