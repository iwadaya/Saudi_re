// components/FQPricingGraphModal.jsx — pricing-curve graph + structure analysis.
import { useMemo } from 'react';
import {
  FQ_MARKET_A,
  FQ_MARKET_B,
  FQ_STRUCTURE_COLORS,
  fqBuildPricingCurve,
  fqCurveBaseEgnpi,
} from '../fqHelpers.js';
import {
  EPS,
  SERIES,
  fmtPct,
  fmtMoney,
  fmtSignedPct,
  norm,
  fitAt,
  weightedAvg,
  buildStructurePoints,
  buildPortfolioPoints,
  fitSeries,
  moneyWithCurrency,
  formatStructureMetric,
  buildStructureAnalysisLayers,
  chooseTargetCurve,
  buildAiAnalysis,
} from './fqGraphHelpers.js';

export default function FQPricingGraphModal({
  open,
  sourceLabel,
  structure,
  expLayers = [],
  npDetail = {},
  portfolioRows = [],
  currency,
  onClose,
}) {
  const data = useMemo(() => {
    const baseEgnpi = fqCurveBaseEgnpi(expLayers, npDetail);
    const expCurve = fqBuildPricingCurve({ expLayers, structures: [], npDetail });
    const structurePts = buildStructurePoints(structure, baseEgnpi);

    const countryName = norm(npDetail.countryName || npDetail.country);
    const portfolioPts = buildPortfolioPoints(portfolioRows);
    const countryPts = buildPortfolioPoints(
      countryName
        ? portfolioRows.filter(row => norm(row.country) === countryName)
        : [],
    );

    const expFit = fitSeries(expCurve.expPts, true);
    const structureFit = fitSeries(structurePts, false);
    const portfolioFit = fitSeries(portfolioPts, false);
    const countryFit = fitSeries(countryPts, false);

    const series = [
      { ...SERIES[0], points: expCurve.expPts, fit: expFit },
      { ...SERIES[1], points: structurePts, fit: structureFit },
      { ...SERIES[2], points: portfolioPts, fit: portfolioFit },
      { ...SERIES[3], points: countryPts, fit: countryFit },
    ];

    const layerRows = structurePts.map((p) => {
      const expiring = fitAt(expFit, p.x);
      const portfolio = fitAt(portfolioFit, p.x);
      const country = fitAt(countryFit, p.x);
      return {
        ...p,
        structure: p.y,
        expiring,
        portfolio,
        country,
        vsExpiring: expiring > 0 ? (p.y / expiring - 1) : null,
        vsCountry: country > 0 ? (p.y / country - 1) : null,
      };
    });
    const targetCurve = chooseTargetCurve({ countryFit, portfolioFit, expFit });
    const aiAnalysis = buildAiAnalysis(layerRows, targetCurve);
    const structureAnalysisLayers = buildStructureAnalysisLayers({
      structure,
      fallbackEgnpi: baseEgnpi,
      portfolioRows,
      npDetail,
    });

    return { baseEgnpi, series, layerRows, expFit, portfolioFit, countryFit, aiAnalysis, structureAnalysisLayers };
  }, [expLayers, npDetail, portfolioRows, structure]);

  if (!open) return null;

  const actualPts = data.series.flatMap(s => s.points.map(p => ({ ...p, series: s.key })));
  const hasPoints = actualPts.length > 0;
  const W = 920;
  const H = 390;
  const pad = { t: 34, r: 28, b: 48, l: 64 };
  const actualXs = actualPts.map(p => p.x).filter(Number.isFinite);
  const actualYs = actualPts.map(p => p.y).filter(Number.isFinite);
  const minXRaw = actualXs.length ? Math.min(...actualXs) : 0.01;
  const maxXRaw = actualXs.length ? Math.max(...actualXs) : 0.2;
  const rawMaxY = Math.max(...actualYs, 0.05);
  let x0 = Math.max(EPS, minXRaw * 0.82);
  let x1 = Math.max(maxXRaw * 1.18, x0 * 1.2);
  if (Math.abs(x1 - x0) < EPS) { x0 *= 0.8; x1 *= 1.2; }

  const sampled = data.series.flatMap((series) => {
    if (!series.fit) return [];
    const out = [];
    for (let i = 0; i <= 90; i += 1) {
      const x = x0 + (x1 - x0) * (i / 90);
      const y = fitAt(series.fit, x);
      if (y > 0 && y <= rawMaxY * 4) out.push({ x, y, series: series.key });
    }
    return out;
  });
  const yVals = [...actualYs, ...sampled.map(p => p.y)].filter(v => Number.isFinite(v) && v > 0);
  const y0 = Math.max(0, (yVals.length ? Math.min(...yVals) : 0.01) * 0.75);
  const y1 = Math.max((yVals.length ? Math.max(...yVals) : 0.12) * 1.25, y0 + 0.05);
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  const sx = x => pad.l + ((x - x0) / (x1 - x0 || 1)) * cw;
  const sy = y => pad.t + ch - ((y - y0) / (y1 - y0 || 1)) * ch;
  const yGrid = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
  const xGrid = Array.from({ length: 4 }, (_, i) => x0 + ((x1 - x0) * i) / 3);
  const seriesByKey = new Map(data.series.map(s => [s.key, s]));
  const totals = {
    structure: weightedAvg(data.layerRows, r => r.structure),
    expiring: weightedAvg(data.layerRows, r => r.expiring),
    portfolio: weightedAvg(data.layerRows, r => r.portfolio),
    country: weightedAvg(data.layerRows, r => r.country),
  };
  const expiringStatus = data.expFit?.calibrated ? `${data.expFit.n} layers` : 'market default';
  const portfolioStatus = data.portfolioFit ? `${data.portfolioFit.n} layers` : 'insufficient data';
  const countryStatus = data.countryFit ? `${data.countryFit.n} layers` : 'insufficient data';

  return (
    <div className="bm-modal-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bm-modal" style={{ width: '100vw', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}>
        <div className="bm-modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div>Pricing Graph Analysis · {sourceLabel}</div>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
              Expiring implied vs selected structure, portfolio curve, and country curve
            </div>
          </div>
          <button className="bm-pill" onClick={onClose}>Close</button>
        </div>

        <div className="bm-modal-body" style={{ minHeight: 0, height: '100%', maxHeight: 'none', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, padding: '20px 28px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
            {[
              { label: 'Structure Wtd ROL', value: fmtPct(totals.structure), color: SERIES[1].color, sub: `${data.layerRows.length} quoted layers` },
              { label: 'Expiring Implied', value: fmtPct(totals.expiring), color: SERIES[0].color, sub: expiringStatus },
              { label: 'Portfolio Curve', value: fmtPct(totals.portfolio), color: SERIES[2].color, sub: portfolioStatus },
              { label: 'Country Curve', value: fmtPct(totals.country), color: SERIES[3].color, sub: countryStatus },
            ].map(card => (
              <div key={card.label} style={{ background: 'rgba(8,14,30,0.72)', border: `1px solid ${card.color}33`, borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', color: card.color, textTransform: 'uppercase' }}>{card.label}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: 'rgba(226,232,240,0.95)', marginTop: 4 }}>{card.value}</div>
                <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>{card.sub}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 10, color: 'rgba(148,163,184,0.65)' }}>
            {data.series.map(s => (
              <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 18, height: 2, borderTop: `2px ${s.dash ? 'dashed' : 'solid'} ${s.color}` }} />
                <b style={{ color: s.color }}>{s.label}</b>
                <span>{s.points.length} pts</span>
              </span>
            ))}
          </div>

          <div style={{ background: '#070d1c', borderRadius: 12, border: '1px solid rgba(255,255,255,0.07)', padding: '12px 8px' }}>
            {!hasPoints ? (
              <div style={{ padding: 44, textAlign: 'center', color: 'rgba(148,163,184,0.38)', fontSize: 13 }}>
                Enter expiring layers and structure pricing to render the graph.
              </div>
            ) : (
              <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ display: 'block', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
                {yGrid.map((v, i) => (
                  <g key={`gy${i}`}>
                    <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} stroke="rgba(255,255,255,0.07)" vectorEffect="non-scaling-stroke" />
                    <text x={pad.l - 8} y={sy(v) + 4} textAnchor="end" fill="rgba(148,163,184,0.75)" fontSize={10}>{fmtPct(v, 1)}</text>
                  </g>
                ))}
                {xGrid.map((v, i) => (
                  <g key={`gx${i}`}>
                    <line x1={sx(v)} x2={sx(v)} y1={pad.t} y2={H - pad.b} stroke="rgba(255,255,255,0.05)" vectorEffect="non-scaling-stroke" />
                    <text x={sx(v)} y={H - 16} textAnchor="middle" fill="rgba(148,163,184,0.60)" fontSize={9}>{v.toFixed(3)}</text>
                  </g>
                ))}
                <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} stroke="rgba(255,255,255,0.30)" vectorEffect="non-scaling-stroke" />
                <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="rgba(255,255,255,0.30)" vectorEffect="non-scaling-stroke" />
                <text x={pad.l - 8} y={pad.t - 12} textAnchor="end" fill="rgba(148,163,184,0.65)" fontSize={10} fontWeight="700">ROL</text>
                <text x={W / 2} y={H - 4} textAnchor="middle" fill="rgba(148,163,184,0.65)" fontSize={10} fontWeight="700">x = sqrt((limit + attachment) * attachment) / EGNPI</text>

                {data.series.map((s) => {
                  if (!s.fit) return null;
                  const pts = [];
                  for (let i = 0; i <= 90; i += 1) {
                    const x = x0 + (x1 - x0) * (i / 90);
                    const y = fitAt(s.fit, x);
                    if (y > 0 && y <= rawMaxY * 4) pts.push(`${sx(x).toFixed(1)},${sy(y).toFixed(1)}`);
                  }
                  return pts.length > 1 ? (
                    <polyline key={s.key} points={pts.join(' ')} fill="none" stroke={s.color} strokeWidth={s.key === 'structure' ? 2.8 : 2} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" opacity={s.key === 'portfolio' ? 0.72 : 0.92} vectorEffect="non-scaling-stroke" />
                  ) : null;
                })}

                {actualPts.map((p, idx) => {
                  const s = seriesByKey.get(p.series);
                  const isMarket = p.series === 'portfolio' || p.series === 'country';
                  return (
                    <g key={`${p.series}-${idx}`}>
                      <circle cx={sx(p.x)} cy={sy(p.y)} r={isMarket ? 3.2 : 5.5} fill={s?.color || '#fff'} opacity={isMarket ? 0.36 : 0.95} />
                      {!isMarket && <text x={sx(p.x) + 8} y={sy(p.y) + 4} fontSize={10} fill={s?.color || '#fff'} fontWeight={800}>{p.label}</text>}
                    </g>
                  );
                })}
              </svg>
            )}
          </div>

          <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.07)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820, fontSize: 11 }}>
              <thead style={{ background: '#050810' }}>
                <tr>
                  {['Layer', 'Limit', 'Attachment', 'Structure ROL', 'Expiring implied', 'Portfolio', 'Country', 'Vs Expiring', 'Vs Country'].map((h, i) => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: i === 0 ? 'left' : 'right', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', color: 'rgba(148,163,184,0.65)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.10)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.layerRows.map(r => {
                  const diff = v => v == null ? '-' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
                  const diffColor = v => v == null ? 'rgba(148,163,184,0.55)' : v > 0 ? '#f87171' : '#4ade80';
                  return (
                    <tr key={r.label} style={{ background: '#080f23' }}>
                      <td style={{ padding: '8px 10px', color: FQ_STRUCTURE_COLORS[0], fontWeight: 800 }}>{r.label}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>{currency ? `${currency} ` : ''}{fmtMoney(r.limit)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>{currency ? `${currency} ` : ''}{fmtMoney(r.attachment)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: SERIES[1].color, fontWeight: 800 }}>{fmtPct(r.structure)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: SERIES[0].color }}>{fmtPct(r.expiring)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: SERIES[2].color }}>{fmtPct(r.portfolio)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: SERIES[3].color }}>{fmtPct(r.country)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: diffColor(r.vsExpiring), fontWeight: 800 }}>{diff(r.vsExpiring)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: diffColor(r.vsCountry), fontWeight: 800 }}>{diff(r.vsCountry)}</td>
                    </tr>
                  );
                })}
                {data.layerRows.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ padding: 24, textAlign: 'center', color: 'rgba(148,163,184,0.38)' }}>
                      This structure needs limit, attachment, and pricing before graph analysis is available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, alignItems: 'stretch' }}>
            <section style={{ background: 'rgba(8,14,30,0.72)', border: `1px solid ${data.aiAnalysis.target.color}`, borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: data.aiAnalysis.target.color }}>
                    AI Suggested Deductible Pricing
                  </div>
                  <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>
                    Anchor curve: {data.aiAnalysis.target.label}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'rgba(226,232,240,0.78)', fontWeight: 750 }}>
                  Suggested Wtd ROL {fmtPct(data.aiAnalysis.summary.aiRol)}
                </div>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1260, fontSize: 11 }}>
                  <thead style={{ background: '#050810' }}>
                    <tr>
                      {['Layer', 'Current Limit', 'AI Limit', 'Current Deductible', 'AI Deductible', 'Current ROL', 'AI ROL', 'AI Rate', 'AI Premium', 'Reason'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: i === 0 || i === 9 ? 'left' : 'right', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', color: 'rgba(148,163,184,0.65)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.10)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.aiAnalysis.rows.map(r => (
                      <tr key={`ai-${r.label}`} style={{ background: '#080f23' }}>
                        <td style={{ padding: '8px 10px', color: FQ_STRUCTURE_COLORS[0], fontWeight: 850 }}>{r.label}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{moneyWithCurrency(r.limit, currency)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: data.aiAnalysis.target.color, fontWeight: 850 }}>
                          {moneyWithCurrency(r.suggestedLimit, currency)}
                          {r.limitMove != null && (
                            <span style={{ marginLeft: 6, color: r.limitMove > 0 ? '#f59e0b' : '#4ade80', fontSize: 10 }}>
                              {fmtSignedPct(r.limitMove)}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{moneyWithCurrency(r.attachment, currency)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: data.aiAnalysis.target.color, fontWeight: 850 }}>
                          {moneyWithCurrency(r.suggestedDeductible, currency)}
                          {r.deductibleMove != null && (
                            <span style={{ marginLeft: 6, color: r.deductibleMove > 0 ? '#f59e0b' : '#4ade80', fontSize: 10 }}>
                              {fmtSignedPct(r.deductibleMove)}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: SERIES[1].color, fontWeight: 800 }}>{fmtPct(r.currentRol)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: data.aiAnalysis.target.color, fontWeight: 850 }}>{fmtPct(r.aiRol)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtPct(r.aiRate)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{moneyWithCurrency(r.aiPremium, currency)}</td>
                        <td style={{ padding: '8px 10px', color: 'rgba(226,232,240,0.72)', minWidth: 280 }}>{r.reason}</td>
                      </tr>
                    ))}
                    {data.aiAnalysis.rows.length === 0 && (
                      <tr>
                        <td colSpan={10} style={{ padding: 22, textAlign: 'center', color: 'rgba(148,163,184,0.38)' }}>
                          Add quoted structure layers to generate deductible pricing suggestions.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section style={{ background: 'rgba(8,14,30,0.72)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(226,232,240,0.86)' }}>
                Structure Analysis
              </div>
              <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
                {data.structureAnalysisLayers.map(layer => (
                  <div key={`structure-analysis-layer-${layer.layerNumber}`} style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, overflow: 'hidden', background: 'rgba(5,8,16,0.32)' }}>
                    <div style={{ padding: '9px 11px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: FQ_STRUCTURE_COLORS[(layer.layerNumber - 1) % FQ_STRUCTURE_COLORS.length] }}>
                        Layer {layer.layerNumber}
                      </div>
                      <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>
                        Structure metrics vs same-layer market averages
                      </div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1120, fontSize: 11 }}>
                        <thead style={{ background: '#050810' }}>
                          <tr>
                            {[
                              'Metric',
                              'Structure Metric',
                              'Country Average',
                              'Region Average',
                              'Global Average',
                              'Within Country Average',
                              'Within Region Average',
                              'Within Global Average',
                            ].map((h, i) => (
                              <th key={h} style={{ padding: '8px 10px', textAlign: i === 0 ? 'left' : 'right', fontSize: 9, fontWeight: 850, letterSpacing: '.11em', color: 'rgba(148,163,184,0.68)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {layer.rows.map(row => (
                            <tr key={`${layer.layerNumber}-${row.key}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                              <td style={{ padding: '7px 10px', color: 'rgba(226,232,240,0.82)', fontWeight: 800 }}>{row.label}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right', color: SERIES[1].color, fontWeight: 850 }}>{formatStructureMetric(row.structureValue, row.format, currency)}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right' }}>{formatStructureMetric(row.countryAverage, row.format, currency)}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right' }}>{formatStructureMetric(row.regionAverage, row.format, currency)}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right' }}>{formatStructureMetric(row.globalAverage, row.format, currency)}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right', color: row.withinCountry.color, fontWeight: 800 }}>{row.withinCountry.label}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right', color: row.withinRegion.color, fontWeight: 800 }}>{row.withinRegion.label}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right', color: row.withinGlobal.color, fontWeight: 800 }}>{row.withinGlobal.label}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
                {data.structureAnalysisLayers.length === 0 && (
                  <div style={{ padding: 18, textAlign: 'center', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, color: 'rgba(148,163,184,0.42)', fontSize: 12 }}>
                    Add structure layers to compare layer metrics against country, region, and global averages.
                  </div>
                )}
              </div>
            </section>
          </div>

          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)' }}>
            Default coefficients are a={FQ_MARKET_A.toFixed(3)}, b={FQ_MARKET_B.toFixed(3)} when expiring terms are not sufficient. Portfolio and country curves only render when at least two valid portfolio layer points are available.
          </div>
        </div>
      </div>
    </div>
  );
}
