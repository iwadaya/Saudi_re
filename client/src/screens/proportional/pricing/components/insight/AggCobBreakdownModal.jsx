import { useState, useEffect } from 'react';
import { api } from '../../../../../api.js';
import { toN as cn } from '../../../../../utils/format.js';

export function AggCobBreakdownModal({ contractId, shareRows, contractAgg100, otherCountryAgg, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeShare, setActiveShare] = useState(null);

  useEffect(() => {
    api.getAggCobBreakdown(contractId).then(d => {
      setData(d);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [contractId]);

  const fmt = n => Number.isFinite(n) && n !== 0 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
  const pct = (n, total) => total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '—';
  const parsePct = s => { const v = parseFloat(String(s).replace('%', '').trim()); return Number.isFinite(v) ? v / 100 : 0; };

  // Merge contract COBs and country COBs into unified COB list
  const contractCobs = data?.contract || [];
  const countryCobs = data?.country_others || [];
  const allCobs = Array.from(new Set([
    ...contractCobs.map(r => r.cob),
    ...countryCobs.map(r => r.cob),
  ])).filter(Boolean);

  const contractTotal = contractCobs.reduce((s, r) => s + cn(r.total_agg), 0);
  const countryOtherTotal = countryCobs.reduce((s, r) => s + cn(r.total_agg), 0);

  const getContractCob = cob => contractCobs.find(r => r.cob === cob);
  const getCountryCob = cob => countryCobs.find(r => r.cob === cob);

  const PERILS = ['eq_agg', 'ws_agg', 'flood_agg', 'srcc_agg', 'others_agg'];
  const PERIL_LABELS = { eq_agg: 'EQ', ws_agg: 'WS', flood_agg: 'Flood', srcc_agg: 'SRCC', others_agg: 'Other' };
  const PERIL_COLORS = { eq_agg: '#f87171', ws_agg: '#60a5fa', flood_agg: '#34d399', srcc_agg: '#fbbf24', others_agg: '#a78bfa' };

  // Share rows filtered to numeric ones (skip 100%)
  const shareOptions = shareRows.filter(s => !s.includes('100'));
  const selected = activeShare || shareOptions[0] || '1%';
  const sharePct = parsePct(selected);

  // Per-share agg contribution and country agg
  const aggContrib = contractAgg100 != null ? contractAgg100 * sharePct : null;
  const countryAggTotal = contractAgg100 != null && otherCountryAgg != null
    ? otherCountryAgg + contractAgg100 * sharePct : null;

  // COB-level breakdown at this share
  const cobRows = allCobs.map(cob => {
    const cc = getContractCob(cob);
    const cOther = getCountryCob(cob);
    const contractCobAgg = cn(cc?.total_agg);
    const otherCobAgg = cn(cOther?.total_agg);
    const contribution = contractCobAgg * sharePct;
    const countryWithContrib = otherCobAgg + contribution;
    return { cob, contractCobAgg, otherCobAgg, contribution, countryWithContrib, perils: cc };
  }).sort((a, b) => b.contribution - a.contribution);

  const thS = { padding: '9px 12px', fontSize: 10, fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap', background: 'rgba(8,14,28,0.95)', position: 'sticky', top: 0, zIndex: 3 };
  const tdS = { padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', verticalAlign: 'middle', fontSize: 13 };

  return (
    <div className="modal-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(3,7,18,0.80)', backdropFilter: 'blur(6px)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass" role="dialog" aria-modal="true" style={{ width: 'calc(100vw - 24px)', height: 'calc(100vh - 24px)', background: 'linear-gradient(180deg,#0c1628,#060c18)', border: '1px solid rgba(251,191,36,0.20)', borderRadius: 16, boxShadow: '0 28px 60px rgba(0,0,0,0.65)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: '#fff', letterSpacing: 0 }}>◈ COB Aggregate Breakdown</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.42)', marginTop: 2 }}>Agg Contribution &amp; Country Agg split by Class of Business at each share participation</div>
          </div>
          {/* Share selector */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.40)', fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase' }}>Share</span>
            {shareOptions.map(s => (
              <button key={s} onClick={() => setActiveShare(s)}
                style={{ padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${s === selected ? 'rgba(251,191,36,0.70)' : 'rgba(255,255,255,0.14)'}`, background: s === selected ? 'rgba(251,191,36,0.12)' : 'rgba(255,255,255,0.04)', color: s === selected ? '#fbbf24' : 'rgba(255,255,255,0.55)', transition: 'all .15s' }}>
                {s}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.7)', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 13 }}>✕</button>
        </div>

        {loading && <div style={{ padding: 24, color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>Loading breakdown…</div>}

        {!loading && (
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>

            {/* Summary chips */}
            <div style={{ display: 'flex', gap: 10, padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
              {[
                { label: `Agg Contribution @ ${selected}`, value: aggContrib, color: '#fbbf24' },
                { label: 'Country Agg incl. Contribution', value: countryAggTotal, color: '#60a5fa' },
                { label: `This Contract 100% Agg`, value: contractAgg100, color: '#a78bfa' },
                { label: 'Other Country Contracts', value: otherCountryAgg, color: '#94a3b8' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ flex: '1 1 200px', padding: '10px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: `1px solid ${color}30` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: 'rgba(255,255,255,0.40)', marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{value != null ? fmt(value) : '—'}</div>
                </div>
              ))}
            </div>

            {/* Main table */}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...thS, textAlign: 'left', width: 180 }}>Class of Business</th>
                  <th style={{ ...thS, textAlign: 'right', color: 'rgba(167,139,250,0.80)' }}>Contract 100% Agg</th>
                  <th style={{ ...thS, textAlign: 'right', color: 'rgba(167,139,250,0.60)' }}>% of Total</th>
                  <th style={{ ...thS, textAlign: 'right', color: 'rgba(251,191,36,0.80)' }}>Agg Contribution @ {selected}</th>
                  <th style={{ ...thS, textAlign: 'right', color: 'rgba(251,191,36,0.60)' }}>% of Contrib</th>
                  <th style={{ ...thS, textAlign: 'right', color: 'rgba(148,163,184,0.80)' }}>Other Contracts Agg</th>
                  <th style={{ ...thS, textAlign: 'right', color: 'rgba(96,165,250,0.80)' }}>Country Agg incl.</th>
                  <th style={{ ...thS, textAlign: 'right', color: 'rgba(96,165,250,0.60)' }}>% of Country</th>
                  <th style={{ ...thS, textAlign: 'center', color: 'rgba(255,255,255,0.35)', width: 200 }}>Peril Split</th>
                </tr>
              </thead>
              <tbody>
                {cobRows.map((row, i) => {
                  const perilTotal = PERILS.reduce((s, p) => s + cn(row.perils?.[p]), 0);
                  return (
                    <tr key={row.cob} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.018)' }}>
                      <td style={{ ...tdS, fontWeight: 700, color: 'rgba(226,232,240,0.88)' }}>{row.cob}</td>
                      {/* Contract 100% */}
                      <td style={{ ...tdS, textAlign: 'right', color: 'rgba(167,139,250,0.85)', fontVariantNumeric: 'tabular-nums' }}>{fmt(row.contractCobAgg)}</td>
                      <td style={{ ...tdS, textAlign: 'right', color: 'rgba(167,139,250,0.55)', fontSize: 12 }}>{pct(row.contractCobAgg, contractTotal)}</td>
                      {/* Agg Contribution */}
                      <td style={{ ...tdS, textAlign: 'right', color: '#fbbf24', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(row.contribution)}</td>
                      <td style={{ ...tdS, textAlign: 'right', color: 'rgba(251,191,36,0.55)', fontSize: 12 }}>{aggContrib ? pct(row.contribution, aggContrib) : '—'}</td>
                      {/* Other country */}
                      <td style={{ ...tdS, textAlign: 'right', color: 'rgba(148,163,184,0.70)', fontVariantNumeric: 'tabular-nums' }}>{fmt(row.otherCobAgg)}</td>
                      {/* Country incl. contribution */}
                      <td style={{ ...tdS, textAlign: 'right', color: '#60a5fa', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmt(row.countryWithContrib)}</td>
                      <td style={{ ...tdS, textAlign: 'right', color: 'rgba(96,165,250,0.55)', fontSize: 12 }}>{countryAggTotal ? pct(row.countryWithContrib, countryAggTotal) : '—'}</td>
                      {/* Peril bar */}
                      <td style={{ ...tdS, padding: '6px 12px' }}>
                        {perilTotal > 0 ? (
                          <div>
                            <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', gap: 1 }}>
                              {PERILS.map(p => {
                                const v = cn(row.perils?.[p]);
                                if (!v) return null;
                                return <div key={p} title={`${PERIL_LABELS[p]}: ${fmt(v)}`} style={{ flex: v, background: PERIL_COLORS[p], opacity: 0.85 }} />;
                              })}
                            </div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                              {PERILS.filter(p => cn(row.perils?.[p]) > 0).map(p => (
                                <span key={p} style={{ fontSize: 9, color: PERIL_COLORS[p], fontWeight: 700 }}>
                                  {PERIL_LABELS[p]} {pct(cn(row.perils?.[p]), perilTotal)}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 11 }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Totals */}
              <tfoot style={{ position: 'sticky', bottom: 0, zIndex: 2 }}>
                <tr style={{ background: 'rgba(8,14,28,0.97)', borderTop: '2px solid rgba(255,255,255,0.12)' }}>
                  <td style={{ ...tdS, fontWeight: 800, fontSize: 11, letterSpacing: 0, textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)' }}>Total</td>
                  <td style={{ ...tdS, textAlign: 'right', color: 'rgba(167,139,250,0.85)', fontWeight: 700 }}>{fmt(contractTotal)}</td>
                  <td style={{ ...tdS, textAlign: 'right', color: 'rgba(167,139,250,0.45)', fontSize: 12 }}>100%</td>
                  <td style={{ ...tdS, textAlign: 'right', color: '#fbbf24', fontWeight: 800 }}>{aggContrib != null ? fmt(aggContrib) : '—'}</td>
                  <td style={{ ...tdS, textAlign: 'right', color: 'rgba(251,191,36,0.45)', fontSize: 12 }}>100%</td>
                  <td style={{ ...tdS, textAlign: 'right', color: 'rgba(148,163,184,0.70)', fontWeight: 700 }}>{fmt(countryOtherTotal)}</td>
                  <td style={{ ...tdS, textAlign: 'right', color: '#60a5fa', fontWeight: 800 }}>{countryAggTotal != null ? fmt(countryAggTotal) : '—'}</td>
                  <td style={{ ...tdS, textAlign: 'right', color: 'rgba(96,165,250,0.45)', fontSize: 12 }}>100%</td>
                  <td style={{ ...tdS }} />
                </tr>
              </tfoot>
            </table>

          </div>
        )}
      </div>
    </div>
  );
}
