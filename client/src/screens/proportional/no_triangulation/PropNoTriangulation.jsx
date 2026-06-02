import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import { formatWithCommas, sanitizeNumber, parseFlexibleNumber } from '../../../utils/format';
import LdfAnalysisModal from '../../shared/LdfAnalysisModal';
import LdfCurveTable from '../../shared/LdfCurveTable';

const ROUTE_KEY = 'PROP_NO_TRIANGULATION';

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
  const { state: appState, setSlice } = useAppState();
  const td = appState.propTreatyDetail || {};
  const apiOpts = appState.quoteMode ? { quote: true } : undefined;

  // Per-treaty large/CAT stripping choice (default on). On this no-triangulation
  // basis, stripping removes the year's large/CAT from incurred before
  // projecting; the projected & quick summaries fold them back accordingly.
  const stripLargeCat = td.stripLargeCat === true;
  const setStrip = (strip) => {
    setSlice('propTreatyDetail', { ...td, stripLargeCat: strip });
    if (contractId) api.setStripLargeCat(contractId, strip, apiOpts).catch(() => {});
  };


  // Derive start year from treaty detail, renewal year from inception date
  // Priority: experienceStartYear (set on treaty detail) → startYear (UW year) → fallback
  const tdExperienceStartYear = Number(td.experienceStartYear) || null;
  const tdStartYear = Number(td.startYear) || null;
  const tdInceptionYear = td.inceptionDate ? new Date(td.inceptionDate).getFullYear()
    : (Number(td.inceptionYear) || null);

  // Derive start year and renewal year strictly from treaty detail — read-only on this screen
  const startYear = tdExperienceStartYear || tdStartYear || new Date().getFullYear() - 5;
  const renewalYear = tdInceptionYear || new Date().getFullYear();

  const [rows, setRows] = useState({});
  const [loading, setLoading] = useState(false);
  const dirty = useRef(false);
  const isPasting = useRef(false);

  // LDF Analysis modal + the currently-saved blend curves displayed in
  // the summary card under the stats table.
  const [ldfModalOpen, setLdfModalOpen] = useState(false);
  const [premiumBlend, setPremiumBlend] = useState(null);
  const [claimsBlend,  setClaimsBlend]  = useState(null);
  // uuid → human class name, used to label the per-class rows in the
  // saved-blend summary card.
  const [classLabelById, setClassLabelById] = useState({});

  const refreshBlends = useCallback(async (id) => {
    if (!id) return;
    try {
      const [prem, claims] = await Promise.all([
        api.getLdfBlend(id, 'PREMIUM').catch(() => null),
        api.getLdfBlend(id, 'CLAIMS_PAID').catch(() => null),
      ]);
      setPremiumBlend(prem);
      setClaimsBlend(claims);
    } catch {
      /* swallow — summary card just stays empty if blend fetch fails */
    }
  }, []);

  // Class-of-business labels (one fetch on mount). LdfCurveTable falls
  // back to the UUID prefix when this map is empty, so a failed fetch
  // is non-fatal — it just shows IDs.
  useEffect(() => {
    let cancelled = false;
    api.listClassOfBusiness().then((rows) => {
      if (cancelled) return;
      const list = Array.isArray(rows) ? rows : [];
      setClassLabelById(Object.fromEntries(list.map((c) => [c.id, c.name])));
    }).catch(() => { /* leave map empty; table will show UUID prefix */ });
    return () => { cancelled = true; };
  }, []);

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
        }
        setRows(newRows);
      } catch (e) {
        console.error('No-triangulation load failed:', e);
      }
      setLoading(false);
    })();
    refreshBlends(contractId);
  }, [contractId, refreshBlends]);

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
      // Per the LDF Analysis workflow, tail_type is always 'CUSTOM' now —
      // the chosen curve lives in contract_ldf_blend_curve and downstream
      // readers (projectWithSavedFactors, PropPricing) source from there.
      await api.saveStraightStats(contractId, 'CUSTOM', statsPayload);
      dirty.current = false;
      return true;
    } catch (e) {
      console.error('Save failed:', e);
      return false;
    }
  }, [contractId, years, rows]);

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
                        fontFamily: 'var(--font-mono)', fontSize: 13, userSelect: 'none',
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
                        fontFamily: 'var(--font-mono)', fontSize: 13, userSelect: 'none',
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}>
                        {renewalYear}
                        <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 2 }}>↗ TD</span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLdfModalOpen(true)}
                    style={{
                      background: 'var(--accent)', color: 'var(--accent-contrast)',
                      border: 'none', padding: '9px 16px', borderRadius: 8,
                      fontWeight: 800, fontSize: 12, letterSpacing: '.06em', textTransform: 'uppercase',
                      cursor: 'pointer',
                    }}
                  >🔍 LDF Analysis</button>
                </div>
                {/* Large / CAT stripping basis (persisted per treaty) */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#bae6fd' }}>Large / CAT losses</span>
                  <div className="toggle-group">
                    <span className={`toggle-option${stripLargeCat ? ' active' : ''}`} onClick={() => setStrip(true)}>Strip from incurred</span>
                    <span className={`toggle-option${!stripLargeCat ? ' active' : ''}`} onClick={() => setStrip(false)}>Keep in incurred</span>
                  </div>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                    Saved per treaty. Strip removes large/CAT from incurred before projecting and adds them back unprojected; Keep projects the full incurred and folds everything into attritional.
                  </span>
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

              {/* Saved blend summary — read-only mirror of what's in
                  contract_ldf_blend_curve. The LDF Analysis modal is
                  the editing surface; this card just shows what's in
                  force for downstream pricing. */}
              <div className="nt-controls-card glass" style={{ padding: 16, marginTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
                      Saved LDF Blend
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      Per-class benchmark curves blended by EPI share — used by the projected summary and pricing engine.
                    </div>
                  </div>
                </div>
                {(premiumBlend?.blended?.length || claimsBlend?.blended?.length) ? (
                  <div style={{ display: 'grid', gap: 14 }}>
                    {premiumBlend?.blended?.length > 0 && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Premium</div>
                        <LdfCurveTable classes={premiumBlend.classes} blended={premiumBlend.blended} classLabelById={classLabelById} compact />
                      </div>
                    )}
                    {claimsBlend?.blended?.length > 0 && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Claims</div>
                        <LdfCurveTable classes={claimsBlend.classes} blended={claimsBlend.blended} classLabelById={classLabelById} compact />
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 0' }}>
                    No blend saved yet. Click <strong>LDF Analysis</strong> above to configure per-class weights.
                  </div>
                )}
              </div>

              {dirty.current && <div className="muted" style={{ marginTop: 8 }}>Unsaved changes</div>}

              <LdfAnalysisModal
                contractId={contractId}
                contractName={td.contractName || ''}
                isOpen={ldfModalOpen}
                onClose={() => setLdfModalOpen(false)}
                onApply={() => refreshBlends(contractId)}
              />
            </>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
