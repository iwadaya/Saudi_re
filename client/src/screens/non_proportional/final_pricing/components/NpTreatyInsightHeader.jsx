// components/NpTreatyInsightHeader.jsx — Phase 4.1 extraction.
//
// Treaty-mode header: the Bloomberg-style hero plus the insight-button
// row (loss selections, aggregates, profiles, analyses, checklist). JSX
// moved verbatim from NpFinalPricing's treaty branch — props in,
// callbacks out, no logic changes.

import NpBloombergHero from './NpBloombergHero.jsx';

/**
 * @param {{
 *   pricing: import('../hooks/useNpPricingState').NpPricingStateApi,
 *   npDetail: Record<string, any>,
 *   mode: string,
 *   currency: string,
 *   navigate: (path: string) => void,
 * }} props
 */
export default function NpTreatyInsightHeader({ pricing, npDetail, mode, currency, navigate, structureLayers }) {
  const {
    layers, localStructureLayers, offerStatus, techRatioAvg,
    setShowReinsurerModal, setShowTechAnalysisModal,
    setInsightKey, setInsightOpen, openBenchmark,
  } = pricing;

  return (
                <>
                  {/* ═══════ BLOOMBERG HERO ═══════ */}
                  <NpBloombergHero
                    npDetail={npDetail}
                    structureLayers={localStructureLayers.length ? localStructureLayers : structureLayers}
                    mode={mode}
                    offerStatus={offerStatus}
                    currency={currency}
                    techRatio={techRatioAvg}
                  />

                  {/* ── Insight row ── */}
                  <div className="np-bbg-insight-row">
                    {[
                      { k:'LARGE_LOSSES',   label:'Large Losses',       color:'pink',    disabled: mode === 'CAT' },
                      { k:'CAT_LOSSES',     label:'CAT Losses',         color:'amber',   disabled: mode === 'RISK' },
                      { k:'AGGREGATES',     label:'Aggregates',         color:'teal',    disabled: mode === 'RISK' },
                      { k:'RISK_PROFILE',   label:'Risk Profile',       color:'cyan' },
                      { k:'CEDANT',         label:'Cedant Summary',     color:'violet' },
                      { k:'REINSURER',      label:'Reinsurer Analysis', color:'green',   onClick: () => setShowReinsurerModal(true) },
                      { k:'TECH_ANALYSIS',  label:'Technical Analysis', color:'emerald', onClick: () => setShowTechAnalysisModal(true) },
                      { k:'HIST_PERF',      label:'Hist. Performance',  color:'blue',    onClick: () => navigate('/np/historical-performance') },
                      { k:'MKT_ANALYSIS',   label:'Market Analysis',    color:'slate',
                        // Same analysis modal as the quote pricing screen.
                        // It opens on Country and lets the user switch scope inside.
                        onClick: () => openBenchmark('country', 'Layer Pricing', layers) },
                      { k:'CHECKLIST',      label:'Checklist',          color:'ghost' },
                      { k:'GEM',            label:'CAT Modelling',      color:'amber',   disabled: mode === 'RISK' },
                    ].map(b => (
                      <button key={b.k}
                        className={`bbg-ib bbg-ib--${b.color}`}
                        disabled={!!b.disabled}
                        title={b.disabled ? 'Not applicable for this treaty type' : undefined}
                        onClick={() => { if (b.onClick) { b.onClick(); } else { setInsightKey(b.k); setInsightOpen(true); } }}>
                        {b.label}
                      </button>
                    ))}
                  </div>

                  {/* Top Grid: Lead Setup (Snapshot removed — fields shown in topbar) */}
                  <div className="np-final-top-grid">
{/* Lead Reinsurer Setup moved to Reinsurer Analysis modal */}
                  </div>
                </>
  );
}
