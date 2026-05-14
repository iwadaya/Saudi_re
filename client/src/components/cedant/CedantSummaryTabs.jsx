// Shared cedant-summary side panel used by both PROP pricing and NP final
// pricing screens. Renders three tabs — Overview, In-depth Analysis, Metrics —
// with only the Overview tab implemented today.
//
// The Overview tab is lifted from the PROP CedantSummaryPanel (the cleaner of
// the two). For mode='NP' the current-contract injection reads layer totals
// from the `layers` prop instead of the contract header in AppState.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useAppState } from '../../context/AppContext';
import PctInput from '../PctInput';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'indepth',  label: 'In-depth Analysis' },
  { key: 'metrics',  label: 'Metrics' },
];

export default function CedantSummaryTabs(props) {
  const [active, setActive] = useState('overview');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 13 }}>
      <TabBar active={active} onChange={setActive} />
      {active === 'overview' && <OverviewTab {...props} />}
      {active === 'indepth'  && <ComingSoon text="Coming next — In-depth structure analysis" />}
      {active === 'metrics'  && <ComingSoon text="Coming next — AI recommendations on line sizes" />}
    </div>
  );
}

function TabBar({ active, onChange }) {
  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        gap: 4,
        padding: '8px 16px 0',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(15,26,46,0.6)',
        flexShrink: 0,
      }}
    >
      {TABS.map(t => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.key)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: '10px 14px',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: isActive ? '#22d3ee' : 'rgba(255,255,255,0.45)',
              borderBottom: isActive ? '2px solid #22d3ee' : '2px solid transparent',
              cursor: 'pointer',
              transition: 'color .15s',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function ComingSoon({ text }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'rgba(255,255,255,0.4)', fontSize: 14, padding: 40, textAlign: 'center',
    }}>
      {text}
    </div>
  );
}

function OverviewTab({
  contractId,
  currency: rawCurrency,
  contract: contractProp,
  layers,
  liveModelledMargin,
  liveActualMargin,
  isQuote = false,
  mode = 'PROP',
}) {
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'USD';
  const isNp = mode === 'NP';

  const [allRows, setAllRows]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [includeMap, setIncludeMap] = useState({});
  const [lineSizes, setLineSizes]   = useState({});
  const [yearFilter, setYearFilter] = useState('ALL');

  const { state: appState } = useAppState();
  const td = useMemo(
    () => (isNp ? appState.npTreatyDetail : appState.propTreatyDetail) || {},
    [appState.npTreatyDetail, appState.propTreatyDetail, isNp],
  );
  const hdrLocal = useMemo(
    () => contractProp?.header || contractProp || {},
    [contractProp],
  );

  const num = v => { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? n : 0; };

  // NP-only: 100% limit/premium derived from the current contract's layers
  const cur100Limit = useMemo(() => {
    if (!isNp || !Array.isArray(layers)) return 0;
    return layers.reduce((s, l) => s + num(l.limit ?? l.layer_limit), 0);
  }, [isNp, layers]);
  const cur100Prem = useMemo(() => {
    if (!isNp || !Array.isArray(layers)) return 0;
    return layers.reduce((s, l) => s + num(l.earnedPremium ?? l.earned_premium), 0);
  }, [isNp, layers]);

  // Pass mutable inputs through a ref so fetchData only re-runs on contractId change
  const fetchInputsRef = useRef({ td, hdrLocal, cur100Limit, cur100Prem, isQuote, isNp });
  useEffect(() => {
    fetchInputsRef.current = { td, hdrLocal, cur100Limit, cur100Prem, isQuote, isNp };
  }, [td, hdrLocal, cur100Limit, cur100Prem, isQuote, isNp]);

  useEffect(() => {
    if (!contractId) { setLoading(false); return; }
    let cancelled = false;

    const fetchData = async () => {
      const {
        td: cTd, hdrLocal: cHdr, cur100Limit: cLim, cur100Prem: cPrem,
        isQuote: cIsQuote, isNp: cIsNp,
      } = fetchInputsRef.current;
      try {
        let cedantId = cHdr.cedant_id || cTd.cedantId || cTd.cedant_id || '';
        if (!cedantId) {
          const apiOpts = cIsQuote ? { quote: true } : undefined;
          const cData = await api.getContract(contractId, apiOpts).catch(() => null);
          cedantId = cData?.header?.cedant_id || cData?.cedant_id || '';
        }
        if (!cedantId) { if (!cancelled) setLoading(false); return; }

        let data = await api.getCedantSummary(cedantId).catch(e => {
          console.warn('[CedantSummary] getCedantSummary failed:', e);
          return [];
        });
        if (!Array.isArray(data)) data = [];

        if (!data.length) {
          const home = await api.getHomeSummary().catch(() => ({}));
          const all = [...(home.drafts || []), ...(home.submitted || []), ...(home.renewals || [])];
          data = all.filter(r => String(r.cedant_id || r.cedantId || '') === String(cedantId));
        }

        const curExists = data.some(r => String(r.contract_id || r.contractId || r.id || '') === String(contractId));
        if (!curExists) {
          const curUwYear = cTd.inceptionDate
            ? new Date(cTd.inceptionDate).getFullYear()
            : (cTd.startYear || cTd.uw_year || '');
          // NP-specific delta: pull current premium/limit from layers rather than
          // contract header fields (which only exist for PROP).
          const curPremium = cIsNp
            ? cPrem
            : (parseFloat(cTd.quotaShareEpi || 0) || 0) + (parseFloat(cTd.surplusEpi || 0) || 0);
          const curLimit = cIsNp
            ? cLim
            : parseFloat(cTd.qsLimit || 0) || parseFloat(cTd.totalCapacity || 0) || 0;
          data.unshift({
            contract_id: contractId,
            uw_year: curUwYear,
            inception_date: cTd.inceptionDate || '',
            status: cTd.status || 'DRAFT',
            treatyType: cTd.treatyTypeName || cTd.treatyType || (cIsNp ? 'Non-Prop' : ''),
            premium: curPremium,
            limit: curLimit,
            actuarial_margin: 0, actual_margin: 0, uw_margin: 0,
          });
        }

        if (cancelled) return;
        setAllRows(data);
        const inc = {}; const ls = {};
        data.forEach(r => {
          const id = String(r.contract_id || r.contractId || r.id || '');
          const st = String(r.status || r.decision || r.uw_status || '').toUpperCase();
          inc[id] = !(st === 'DECLINED' || st === 'NTU');
          ls[id] = String(r.signed_line_pct || r.signedLinePct || r.written_line_pct || '');
        });
        // Auto-populate line size for SIGNED / submitted treaties
        data.forEach(r => {
          const id = String(r.contract_id || r.contractId || r.id || '');
          const st = String(r.status || r.uw_status || '').toUpperCase();
          const isSigned  = st === 'SIGNED';
          const isWritten = st === 'AWAITING_SIGNED_LINE' || st === 'AWAITING_APPROVAL';
          const signedPct  = r.signed_line_pct  || r.effective_line_pct;
          const writtenPct = r.written_line_pct;
          if (isSigned && signedPct && !ls[id]) {
            ls[id] = String(parseFloat(String(signedPct).replace(/%/g, '')) || '');
          } else if (isWritten && writtenPct && !ls[id]) {
            ls[id] = String(parseFloat(String(writtenPct).replace(/%/g, '')) || '');
          }
        });
        setIncludeMap(inc);
        setLineSizes(ls);
      } catch (e) {
        console.error('[CedantSummary] fetch error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => { cancelled = true; };
  }, [contractId]);

  const getUwYear = r => {
    const inceptionDate = r.inception_date ?? r.inceptionDate;
    if (inceptionDate) {
      const yr = new Date(inceptionDate).getFullYear();
      if (yr && !isNaN(yr)) return String(yr);
    }
    return String(r.uw_year ?? r.uwYear ?? r.year ?? '');
  };

  const availableYears = useMemo(() => {
    const yrs = new Set();
    allRows.forEach(r => { const y = getUwYear(r); if (y) yrs.add(y); });
    return Array.from(yrs).sort((a, b) => Number(b) - Number(a));
  }, [allRows]);

  const rows = yearFilter === 'ALL' ? allRows : allRows.filter(r => getUwYear(r) === yearFilter);

  const idOf = r => String(r.contract_id || r.contractId || r.id || '');
  const isCur = r => idOf(r) === String(contractId);
  const ga = (r, ...keys) => { for (const k of keys) { if (r[k] != null && r[k] !== '') return r[k]; } return null; };
  const money = n => {
    const v = Number(n);
    return Number.isFinite(v) && v !== 0
      ? `${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : '—';
  };
  const pctCell = v => {
    if (v == null) return '—';
    const n = num(v);
    const frac = Math.abs(n) > 1.5 ? n / 100 : n;
    const d = (frac * 100).toFixed(2) + '%';
    const c = frac < 0 ? '#f87171' : frac > 0.08 ? '#4ade80' : '#facc15';
    return <span style={{ color: c, fontWeight: 600 }}>{d}</span>;
  };

  const getLim100 = r => {
    if (isNp && isCur(r) && cur100Limit > 0) return cur100Limit;
    return num(ga(r, 'limit', 'treaty_limit', 'total_limit', 'qs_limit', 'total_capacity', 'capacity', 'totalCapacity', 'qs_limit_amt'));
  };
  const getPrem100 = r => {
    if (isNp && isCur(r) && cur100Prem > 0) return cur100Prem;
    return num(ga(r, 'premium', 'epi', 'premium_amt', 'written_premium', 'quota_share_epi', 'quotaShareEpi', 'gross_premium'));
  };
  const parsePct = s => { const v = parseFloat(String(s).replace('%', '').trim()); return Number.isFinite(v) ? v / 100 : 0; };
  const getActLim = r => { const lp = parsePct(lineSizes[idOf(r)] || ''); return lp > 0 ? getLim100(r) * lp : 0; };
  const getActSz  = r => { const lp = parsePct(lineSizes[idOf(r)] || ''); return lp > 0 ? getPrem100(r) * lp : 0; };

  const included = rows.filter(r => includeMap[idOf(r)] !== false);
  const totLim100  = included.reduce((a, r) => a + getLim100(r),  0);
  const totPrem100 = included.reduce((a, r) => a + getPrem100(r), 0);
  const totActLim  = included.reduce((a, r) => a + getActLim(r),  0);
  const totActSz   = included.reduce((a, r) => a + getActSz(r),   0);
  const wAvg = fn => {
    if (!included.length || totPrem100 === 0) return null;
    return included.reduce((a, r) => a + fn(r) * getPrem100(r), 0) / totPrem100;
  };
  const totModM = wAvg(r => (isCur(r) && liveModelledMargin != null)
    ? liveModelledMargin
    : num(ga(r, 'actuarial_margin', 'actuarialMargin', 'modelled_margin')));
  const totActM = wAvg(r => (isCur(r) && liveActualMargin != null)
    ? liveActualMargin
    : num(ga(r, 'actual_margin', 'actualMargin', 'margin_actual')));

  const allSelected = rows.length > 0 && rows.every(r => includeMap[idOf(r)] !== false);
  const toggleAll = () => {
    const next = !allSelected;
    const m = { ...includeMap };
    rows.forEach(r => { m[idOf(r)] = next; });
    setIncludeMap(m);
  };
  const toggleOne = id => setIncludeMap(prev => ({ ...prev, [id]: !prev[id] }));
  const setLine = (id, val) => setLineSizes(prev => ({ ...prev, [id]: val }));

  const statusBadge = s => {
    const st = String(s || 'DRAFT').toUpperCase();
    const colors = {
      SIGNED: '#4ade80', DRAFT: '#94a3b8', NTU: '#f97316',
      DECLINED: '#f87171', AWAITING_APPROVAL: '#facc15', AWAITING_SIGNED_LINE: '#60a5fa',
    };
    const c = colors[st] || colors.DRAFT;
    return (
      <span style={{
        fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
        border: `1px solid ${c}40`, background: `${c}18`, color: c, whiteSpace: 'nowrap',
      }}>{st.replace(/_/g, ' ')}</span>
    );
  };

  const thS = {
    padding: '11px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '.07em',
    textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)',
    borderBottom: '1px solid rgba(255,255,255,0.1)', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, zIndex: 3, background: 'rgba(15,26,46,0.98)',
  };
  const tdS = {
    padding: '10px 10px', verticalAlign: 'middle',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>Cedant Programmes</div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 }}>
            All contracts for this cedant. Edit Line Size % to calculate actual exposures. Totals update live.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <label style={{
            fontSize: 11, color: 'rgba(255,255,255,0.45)', letterSpacing: '.08em',
            textTransform: 'uppercase', fontWeight: 700, whiteSpace: 'nowrap',
          }}>UW Year</label>
          <select
            className="bbg-select"
            value={yearFilter}
            onChange={e => setYearFilter(e.target.value)}
            style={{ width: 110, height: 32, fontSize: 12 }}
          >
            <option value="ALL">All Years</option>
            {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button
            className="bbg-btn"
            onClick={toggleAll}
            style={{ borderColor: 'rgba(34,211,238,0.4)', color: '#22d3ee' }}
          >
            {allSelected ? '☑ Deselect All' : '☑ Select All'}
          </button>
        </div>
      </div>

      {loading && (
        <div style={{
          margin: '12px 20px', padding: '10px 16px', borderRadius: 8,
          background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)',
          fontSize: 13, color: 'rgba(255,255,255,0.7)',
        }}>Loading cedant summary…</div>
      )}
      {!loading && rows.length === 0 && (
        <div style={{
          margin: '12px 20px', padding: '10px 16px', borderRadius: 8,
          background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)',
          fontSize: 13, color: 'rgba(255,255,255,0.7)',
        }}>
          No programmes found for this cedant{yearFilter !== 'ALL' ? ` in ${yearFilter}` : ''}.
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: 'center', width: 40 }}></th>
              <th style={{ ...thS, textAlign: 'left',   width: 80 }}>UW Year</th>
              <th style={{ ...thS, textAlign: 'left',   width: 130 }}>Treaty Type</th>
              <th style={{ ...thS, textAlign: 'left',   width: 120 }}>Class of Business</th>
              <th style={{ ...thS, textAlign: 'center', width: 100 }}>Line %</th>
              <th style={{ ...thS, textAlign: 'right',  width: 130 }}>100% Premium</th>
              <th style={{ ...thS, textAlign: 'right',  width: 130 }}>100% Limit</th>
              <th style={{ ...thS, textAlign: 'right',  width: 120, color: '#93c5fd' }}>Premium (Share)</th>
              <th style={{ ...thS, textAlign: 'right',  width: 120, color: '#93c5fd' }}>Exposure (Share)</th>
              <th style={{ ...thS, textAlign: 'right',  width: 120, color: '#86efac' }}>Actuarial Margin</th>
              <th style={{ ...thS, textAlign: 'right',  width: 110, color: '#86efac' }}>Actual Margin</th>
              <th style={{ ...thS, textAlign: 'right',  width: 100, color: '#00e8b8' }}>UW Margin</th>
              <th style={{ ...thS, textAlign: 'center', width: 130 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const id = idOf(r); const cur = isCur(r); const inc = includeMap[id] !== false;
              const year = getUwYear(r) || '—';
              const ttype = String(ga(r, 'treaty_type', 'treatyType', 'type') || '');
              const cob = String(ga(r, 'cob', 'classOfBusiness', 'class_of_business') || '—');
              const st = String(ga(r, 'status', 'decision', 'uw_status') || 'DRAFT');
              const lineVal = String(lineSizes[id] || '').replace('%', '').trim();
              const actMargin = (cur && liveActualMargin   != null) ? liveActualMargin   : ga(r, 'actual_margin', 'actualMargin', 'margin_actual');
              const modMargin = (cur && liveModelledMargin != null) ? liveModelledMargin : ga(r, 'actuarial_margin', 'actuarialMargin', 'modelled_margin');
              const uwMargin  = ga(r, 'uw_margin', 'uwMargin');
              return (
                <tr key={id + i} style={{
                  opacity: inc ? 1 : 0.35,
                  background: cur ? 'rgba(16,185,129,0.07)' : i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                  borderLeft: cur ? '3px solid rgba(74,222,128,0.5)' : '3px solid transparent',
                  transition: 'opacity .15s',
                }}>
                  <td style={{ ...tdS, textAlign: 'center' }}>
                    <input
                      type="checkbox" checked={inc}
                      onChange={() => toggleOne(id)}
                      style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#22d3ee' }}
                    />
                  </td>
                  <td style={{ ...tdS, fontWeight: cur ? 700 : 500 }}>
                    {year}
                    {cur && <div style={{ fontSize: 9, color: '#4ade80', fontWeight: 700, textTransform: 'uppercase', marginTop: 1 }}>▶ Current</div>}
                  </td>
                  <td style={{ ...tdS, fontSize: 11 }}>{ttype}</td>
                  <td style={{ ...tdS, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }} title={cob}>{cob}</td>
                  <td style={tdS}>
                    <PctInput
                      value={lineVal} onChange={v => setLine(id, v)} placeholder="0%"
                      className=""
                      style={{
                        background: 'rgba(255,255,255,0.07)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: 6, height: 28, maxWidth: 90, width: '100%',
                        padding: '0 6px', fontSize: 12, color: '#fff', textAlign: 'right',
                        fontFamily: 'inherit', outline: 'none',
                      }}
                    />
                  </td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{money(getPrem100(r))}</td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{money(getLim100(r))}</td>
                  <td style={{ ...tdS, textAlign: 'right', color: '#60a5fa' }}>{getActSz(r)  ? money(getActSz(r))  : '—'}</td>
                  <td style={{ ...tdS, textAlign: 'right', color: '#60a5fa' }}>{getActLim(r) ? money(getActLim(r)) : '—'}</td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{pctCell(modMargin)}</td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{pctCell(actMargin)}</td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{pctCell(uwMargin)}</td>
                  <td style={{ ...tdS, textAlign: 'center' }}>{statusBadge(st)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot style={{ position: 'sticky', bottom: 0, zIndex: 2 }}>
            <tr style={{ background: 'rgba(15,26,46,0.98)' }}>
              <td colSpan={5} style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', fontWeight: 700, fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' }}>
                PORTFOLIO TOTALS ({included.length} treaties)
              </td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700 }}>{money(totPrem100)}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700 }}>{money(totLim100)}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700, color: '#60a5fa' }}>{totActSz  ? money(totActSz)  : '—'}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700, color: '#60a5fa' }}>{totActLim ? money(totActLim) : '—'}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700 }}>{pctCell(totModM)}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700 }}>{pctCell(totActM)}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)' }}></td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)' }}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
