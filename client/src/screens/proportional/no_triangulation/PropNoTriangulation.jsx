import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import { formatWithCommas, sanitizeNumber, parseFlexibleNumber } from '../../../utils/format';

const ROUTE_KEY = 'PROP_NO_TRIANGULATION';

// ── Dummy development factors (industry benchmarks — replace with actuarial factors once available) ──
// SHORT TAIL: Property, Motor (losses mostly settled within 3 years)
const SHORT_TAIL_FACTORS = [
  { devYear: '12→24', ldf: 1.250, desc: 'Initial to 24 months' },
  { devYear: '24→36', ldf: 1.080, desc: '24 to 36 months' },
  { devYear: '36→48', ldf: 1.025, desc: '36 to 48 months' },
  { devYear: '48→60', ldf: 1.010, desc: '48 to 60 months' },
  { devYear: '60→Ult', ldf: 1.005, desc: '60 months to ultimate' },
];
// LONG TAIL: Liability, Medical, Engineering (claims can develop over 10+ years)
const LONG_TAIL_FACTORS = [
  { devYear: '12→24', ldf: 2.100, desc: 'Initial to 24 months' },
  { devYear: '24→36', ldf: 1.450, desc: '24 to 36 months' },
  { devYear: '36→48', ldf: 1.220, desc: '36 to 48 months' },
  { devYear: '48→60', ldf: 1.130, desc: '48 to 60 months' },
  { devYear: '60→72', ldf: 1.075, desc: '60 to 72 months' },
  { devYear: '72→84', ldf: 1.045, desc: '72 to 84 months' },
  { devYear: '84→96', ldf: 1.025, desc: '84 to 96 months' },
  { devYear: '96→Ult', ldf: 1.010, desc: '96 months to ultimate' },
];

// CDFs (cumulative from current to ultimate) — derived from above LDFs
function computeCDF(factors) {
  let cdf = 1.0; const cdfs = [1.0];
  for (let i = factors.length - 1; i >= 0; i--) {
    cdf *= factors[i].ldf;
    cdfs.unshift(Math.round(cdf * 10000) / 10000);
  }
  return cdfs;
}
const SHORT_TAIL_CDF_DISPLAY = computeCDF(SHORT_TAIL_FACTORS);
const LONG_TAIL_CDF_DISPLAY  = computeCDF(LONG_TAIL_FACTORS);
const COLS = ['premium', 'paid', 'os'];

function cleanNum(v) {
  if (v === null || v === undefined || v === '') return '';
  return String(v).replace(/,/g, '').replace(/\s+/g, '');
}
function fmtC(v) { return formatWithCommas(v); }
function incurred(row) {
  const pd = parseFloat(cleanNum(row.paid) || 0);
  const os = parseFloat(cleanNum(row.os) || 0);
  return pd + os;
}
export default function PropNoTriangulation() {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const td = appState.propTreatyDetail || {};


  // Derive start year from treaty detail, renewal year from inception date
  // Priority: experienceStartYear (set on treaty detail) → startYear (UW year) → fallback
  const tdExperienceStartYear = Number(td.experienceStartYear) || null;
  const tdStartYear = Number(td.startYear) || null;
  const tdInceptionYear = td.inceptionDate ? new Date(td.inceptionDate).getFullYear()
    : (Number(td.inceptionYear) || null);

  // Derive start year and renewal year strictly from treaty detail — read-only on this screen
  const startYear = tdExperienceStartYear || tdStartYear || new Date().getFullYear() - 5;
  const renewalYear = tdInceptionYear || new Date().getFullYear();

  const [tailType, setTailType] = useState('SHORT_TAIL');
  const [rows, setRows] = useState({});
  const [loading, setLoading] = useState(false);
  const dirty = useRef(false);
  const isPasting = useRef(false);

  // Derive year range
  const lo = Math.min(startYear, renewalYear);
  const hi = Math.max(startYear, renewalYear);
  const years = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

  const getRow = useCallback((year) => rows[year] || { premium: '', paid: '', os: '' }, [rows]);

  // Load data
  useEffect(() => {
    if (!contractId) return;
    setLoading(true);
    (async () => {
      try {
        const data = await api.getStraightStats(contractId);

        if (data?.tail_type) setTailType(data.tail_type);
        else if (data?.config?.tailType) setTailType(data.config.tailType);

        const newRows = {};
        if (Array.isArray(data?.stats) && data.stats.length > 0) {
          data.stats.forEach(r => {
            const y = String(r.underwriting_year || r.year);
            newRows[y] = {
              premium: String(r.premium || ''),
              paid: String(r.paid_claims || r.paid || ''),
              os: String(r.os_claims || r.os || ''),
            };
          });
          // Only fallback to data years if treaty detail didn't provide them — not needed, years are read-only from treaty detail
        }
        setRows(newRows);
      } catch (e) {
        console.error('No-triangulation load failed:', e);
      }
      setLoading(false);
    })();
  }, [contractId]);

  const updateCell = useCallback((year, col, value) => {
    setRows(prev => ({
      ...prev,
      [year]: { ...(prev[year] || { premium: '', paid: '', os: '' }), [col]: value },
    }));
    dirty.current = true;
  }, []);

  const handleBlur = useCallback((year, col, rawValue) => {
    const cleaned = sanitizeNumber(rawValue);
    updateCell(year, col, cleaned);
  }, [updateCell]);

  // Paste handler
  const handlePaste = useCallback((e, yearIdx, colIdx) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    isPasting.current = true;

    const grid = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
      .filter(l => l.length > 0)
      .map(l => l.split('\t'));

    setRows(prev => {
      const next = { ...prev };
      grid.forEach((pastedRow, rOff) => {
        const targetYearIdx = yearIdx + rOff;
        if (targetYearIdx >= years.length) return;
        const targetYear = years[targetYearIdx];

        pastedRow.forEach((val, cOff) => {
          const targetColIdx = colIdx + cOff;
          if (targetColIdx >= COLS.length) return;
          const field = COLS[targetColIdx];
          // Parse the pasted value as a number, then store as clean string
          const parsed = parseFlexibleNumber(val);
          const cleaned = parsed !== null ? String(Math.round(parsed)) : '';
          if (!next[targetYear]) next[targetYear] = { premium: '', paid: '', os: '' };
          next[targetYear] = { ...next[targetYear], [field]: cleaned };
        });
      });
      return next;
    });
    dirty.current = true;
    // Reset paste guard after React re-render
    requestAnimationFrame(() => { isPasting.current = false; });
  }, [years]);

  // Save
  const save = useCallback(async () => {
    if (!contractId) return true;
    if (!dirty.current) return true;
    try {
      const statsPayload = years.map(year => {
        const row = rows[year] || { premium: '', paid: '', os: '' };
        return {
          year: parseInt(year),
          premium: parseFloat(cleanNum(row.premium)) || 0,
          paid: parseFloat(cleanNum(row.paid)) || 0,
          os: parseFloat(cleanNum(row.os)) || 0,
        };
      });
      await api.saveStraightStats(contractId, tailType, statsPayload);
      dirty.current = false;
      return true;
    } catch (e) {
      console.error('Save failed:', e);
      return false;
    }
  }, [contractId, years, rows, tailType]);

  // Totals
  const totals = years.reduce((acc, y) => {
    const r = getRow(y);
    acc.premium += parseFloat(cleanNum(r.premium)) || 0;
    acc.paid += parseFloat(cleanNum(r.paid)) || 0;
    acc.os += parseFloat(cleanNum(r.os)) || 0;
    acc.incurred += incurred(r);
    return acc;
  }, { premium: 0, paid: 0, os: 0, incurred: 0 });

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Straight Stats (No Triangulation)" headerPill="PROPORTIONAL TREATY: STRAIGHT STATS"
      onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className="NO_TRIANGULATION_PAGE">
          {loading ? (
            <div className="df-card df-card--notice"><div className="df-note">Loading...</div></div>
          ) : (
            <>
              {/* Controls */}
              <div className="nt-controls-card glass" style={{ padding: 15, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                  <div style={{ display: 'flex', gap: 20 }}>
                    <div>
                      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', marginBottom: 5 }}>Start Year</div>
                      <div style={{
                        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                        color: 'rgba(255,255,255,0.5)', padding: '8px 14px', borderRadius: 4, width: 100,
                        fontFamily: 'monospace', fontSize: 13, userSelect: 'none',
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}>
                        {startYear}
                        <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 2 }}>↗ TD</span>
                      </div>
                    </div>
                    <div>
                      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', marginBottom: 5 }}>Renewal Year</div>
                      <div style={{
                        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                        color: 'rgba(255,255,255,0.5)', padding: '8px 14px', borderRadius: 4, width: 100,
                        fontFamily: 'monospace', fontSize: 13, userSelect: 'none',
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}>
                        {renewalYear}
                        <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 2 }}>↗ TD</span>
                      </div>
                    </div>
                  </div>
                  <div className="toggle-group">
                    <span className={`toggle-option ${tailType === 'SHORT_TAIL' ? 'active' : ''}`}
                      onClick={() => { setTailType('SHORT_TAIL'); dirty.current = true; }}>Short Tail</span>
                    <span className={`toggle-option ${tailType === 'LONG_TAIL' ? 'active' : ''}`}
                      onClick={() => { setTailType('LONG_TAIL'); dirty.current = true; }}>Long Tail</span>
                  </div>

                </div>
              </div>

              {/* Table */}
              <div className="nt-table-card glass" style={{ padding: '0 0 8px 0' }}>
                <table className="nt-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
                  <thead>
                    <tr style={{ background: 'rgba(5,8,16,0.85)' }}>
                      <th style={{ width: 90, textAlign: 'center', padding: '11px 10px', borderBottom: '1px solid rgba(255,255,255,0.10)', fontSize: 9, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.60)', whiteSpace: 'nowrap' }}>UW Year</th>
                      <th style={{ textAlign: 'center', padding: '11px 10px', borderBottom: '1px solid rgba(255,255,255,0.10)', fontSize: 9, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.60)' }}>Gross Premium</th>
                      <th style={{ textAlign: 'center', padding: '11px 10px', borderBottom: '1px solid rgba(255,255,255,0.10)', fontSize: 9, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.60)' }}>Paid Claims</th>
                      <th style={{ textAlign: 'center', padding: '11px 10px', borderBottom: '1px solid rgba(255,255,255,0.10)', fontSize: 9, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.60)' }}>OS Claims</th>
                      <th style={{ textAlign: 'center', padding: '11px 10px', borderBottom: '1px solid rgba(255,255,255,0.10)', fontSize: 9, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.60)' }}>Incurred (Calc)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {years.map((year, yi) => {
                      const row = getRow(year);
                      const inc = incurred(row);
                      return (
                        <tr key={year} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ textAlign: 'center', padding: '6px 8px' }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              padding: '3px 12px', borderRadius: 6,
                              background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.30)',
                              color: '#a78bfa', fontSize: 12, fontWeight: 800, letterSpacing: '.04em',
                            }}>{year}</span>
                          </td>
                          {COLS.map((col, ci) => (
                            <td key={col} style={{ padding: 6 }}>
                              <input
                                className="nt-cell"
                                value={fmtC(row[col])}
                                placeholder="0"
                                onChange={e => {
                                  if (isPasting.current) return; // Skip — paste handler already set the value
                                  const raw = e.target.value.replace(/,/g, '');
                                  updateCell(year, col, raw);
                                }}
                                onBlur={e => handleBlur(year, col, e.target.value)}
                                onPaste={e => handlePaste(e, yi, ci)}
                                style={{
                                  width: '100%', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)',
                                  color: 'white', padding: '8px 10px', borderRadius: 6,
                                }}
                              />
                            </td>
                          ))}
                          <td style={{ padding: 6 }}>
                            <input
                              className="nt-cell nt-cell--ro"
                              readOnly tabIndex={-1}
                              value={fmtC(inc)}
                              style={{
                                width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid transparent',
                                color: 'rgba(255,255,255,0.6)', padding: '8px 10px', borderRadius: 6, cursor: 'default',
                              }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                    {/* Totals row */}
                    <tr style={{ borderTop: '2px solid rgba(0,212,255,0.35)', background: 'rgba(0,212,255,0.05)' }}>
                      <td style={{ textAlign: 'center', padding: '8px 8px' }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          padding: '3px 12px', borderRadius: 6,
                          background: 'rgba(0,212,255,0.10)', border: '1px solid rgba(0,212,255,0.30)',
                          color: '#00d4ff', fontSize: 11, fontWeight: 800, letterSpacing: '.06em',
                        }}>Total</span>
                      </td>
                      <td className="num" style={{ padding: 6, color: 'rgba(255,255,255,0.8)', paddingRight: 12 }}>{fmtC(totals.premium)}</td>
                      <td className="num" style={{ padding: 6, color: 'rgba(255,255,255,0.8)', paddingRight: 12 }}>{fmtC(totals.paid)}</td>
                      <td className="num" style={{ padding: 6, color: 'rgba(255,255,255,0.8)', paddingRight: 12 }}>{fmtC(totals.os)}</td>
                      <td className="num" style={{ padding: 6, color: 'rgba(255,255,255,0.6)', paddingRight: 12 }}>{fmtC(totals.incurred)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Dev Factors Panel */}
              <div className="nt-controls-card glass" style={{ padding: 16, marginTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>
                      Development Factors Applied — {tailType === 'SHORT_TAIL' ? 'Short Tail' : 'Long Tail'}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
                      Industry benchmark LDFs used to project incurred claims to ultimate.
                      <span style={{ color: '#fbbf24', marginLeft: 6 }}>⚠ Dummy factors — replace with actuarial assumptions when available.</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {(tailType === 'SHORT_TAIL' ? SHORT_TAIL_FACTORS : LONG_TAIL_FACTORS).map((f, i) => (
                    <div key={i} style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', textAlign: 'center', minWidth: 90 }}>
                      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{f.devYear}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: f.ldf > 1.5 ? '#f87171' : f.ldf > 1.1 ? '#fbbf24' : '#4ade80' }}>{f.ldf.toFixed(3)}</div>
                      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>LDF</div>
                    </div>
                  ))}
                </div>
                {/* CDF summary for each year */}
                {years.length > 0 && (
                  <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 8 }}>CDF Applied Per Underwriting Year (newest year gets highest factor)</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {years.map((yr, i) => {
                        const devIdx = years.length - 1 - i;
                        const cdfs = tailType === 'SHORT_TAIL' ? SHORT_TAIL_CDF_DISPLAY : LONG_TAIL_CDF_DISPLAY;
                        const cdf = devIdx < cdfs.length ? cdfs[devIdx] : cdfs[cdfs.length - 1];
                        return (
                          <div key={yr} style={{ padding: '5px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', textAlign: 'center' }}>
                            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{yr}</div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: cdf > 1.5 ? '#f87171' : cdf > 1.1 ? '#fbbf24' : '#4ade80' }}>{cdf.toFixed(3)}×</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {dirty.current && <div className="muted" style={{ marginTop: 8 }}>Unsaved changes</div>}
            </>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
