// Shared cedant-summary side panel used by both PROP pricing and NP final
// pricing screens. Renders three tabs:
//
//   • Overview          — line-size table with live totals
//   • In-depth Analysis — per-layer NP rows + PROP structures, with a profit
//                         or loss driver chip on rows that contribute a
//                         dominant share of the absolute portfolio technical
//                         result (threshold below)
//   • Metrics           — placeholder
//
// The cedant summary is fetched on mount. NP layer detail is fetched lazily on
// the first switch to In-depth and re-used across renders. The Overview tab is
// lifted from the PROP CedantSummaryPanel (the cleaner of the two); for
// mode='NP' the current-contract injection reads totals from the `layers` prop
// instead of the contract header in AppState.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useAppState } from '../../context/AppContext';
import PctInput from '../PctInput';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'indepth',  label: 'In-depth Analysis' },
  { key: 'metrics',  label: 'Metrics' },
];

// Rows whose |net_technical_result| / sum(|all NTR| visible) is at or above
// this fraction earn a profit/loss driver chip in the In-depth tab.
const DRIVER_THRESHOLD = 0.10;

// ── pure helpers ───────────────────────────────────────────────────────────
const num = v => { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? n : 0; };
const ga = (r, ...keys) => { for (const k of keys) if (r && r[k] != null && r[k] !== '') return r[k]; return null; };
const idOfRow = r => String(r.contract_id || r.contractId || r.id || '');
const isNpRow = r => String(r.entity_type || '').toUpperCase() === 'NP';

function getUwYear(r) {
  const inceptionDate = r.inception_date ?? r.inceptionDate;
  if (inceptionDate) {
    const yr = new Date(inceptionDate).getFullYear();
    if (yr && !isNaN(yr)) return String(yr);
  }
  return String(r.uw_year ?? r.uwYear ?? r.year ?? '');
}

const fmtMoney = (currency, n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '—';
  const abs = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${v < 0 ? '-' : ''}${currency} ${abs}`;
};

const fmtBareInt = n => {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const pctCell = v => {
  if (v == null) return '—';
  const n = num(v);
  const frac = Math.abs(n) > 1.5 ? n / 100 : n;
  const d = (frac * 100).toFixed(2) + '%';
  const c = frac < 0 ? '#f87171' : frac > 0.08 ? '#4ade80' : '#facc15';
  return <span style={{ color: c, fontWeight: 600 }}>{d}</span>;
};

const signedNtrCell = (currency, v) => {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  const c = n < 0 ? '#f87171' : '#4ade80';
  return <span style={{ color: c, fontWeight: 600 }}>{fmtMoney(currency, n)}</span>;
};

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

// ── parent ────────────────────────────────────────────────────────────────
export default function CedantSummaryTabs(props) {
  const { contractId, contract: contractProp, layers, isQuote = false, mode = 'PROP' } = props;
  const isNp = mode === 'NP';
  const [active, setActive] = useState('overview');

  const { state: appState } = useAppState();
  const td = useMemo(
    () => (isNp ? appState.npTreatyDetail : appState.propTreatyDetail) || {},
    [appState.npTreatyDetail, appState.propTreatyDetail, isNp],
  );
  const hdrLocal = useMemo(
    () => contractProp?.header || contractProp || {},
    [contractProp],
  );

  // NP-only 100% totals for the current contract, derived from the `layers` prop
  const cur100Limit = useMemo(() => {
    if (!isNp || !Array.isArray(layers)) return 0;
    return layers.reduce((s, l) => s + num(l.limit ?? l.layer_limit), 0);
  }, [isNp, layers]);
  const cur100Prem = useMemo(() => {
    if (!isNp || !Array.isArray(layers)) return 0;
    return layers.reduce((s, l) => s + num(l.earnedPremium ?? l.earned_premium), 0);
  }, [isNp, layers]);

  // Shared state across tabs
  const [cedantId, setCedantId] = useState('');
  const [allRows, setAllRows] = useState([]);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [yearFilter, setYearFilter] = useState('ALL');
  const [npLayers, setNpLayers] = useState([]);
  const [npLoading, setNpLoading] = useState(false);
  const [npFetched, setNpFetched] = useState(false);

  // Pass mutable inputs through a ref so the summary fetch only re-runs on contractId change
  const fetchInputsRef = useRef({ td, hdrLocal, cur100Limit, cur100Prem, isQuote, isNp });
  useEffect(() => {
    fetchInputsRef.current = { td, hdrLocal, cur100Limit, cur100Prem, isQuote, isNp };
  }, [td, hdrLocal, cur100Limit, cur100Prem, isQuote, isNp]);

  // Cedant summary fetch — runs on mount, populates allRows + cedantId
  useEffect(() => {
    if (!contractId) { setSummaryLoading(false); return; }
    let cancelled = false;

    (async () => {
      const {
        td: cTd, hdrLocal: cHdr, cur100Limit: cLim, cur100Prem: cPrem,
        isQuote: cIsQuote, isNp: cIsNp,
      } = fetchInputsRef.current;
      try {
        let cid = cHdr.cedant_id || cTd.cedantId || cTd.cedant_id || '';
        if (!cid) {
          const apiOpts = cIsQuote ? { quote: true } : undefined;
          const cData = await api.getContract(contractId, apiOpts).catch(() => null);
          cid = cData?.header?.cedant_id || cData?.cedant_id || '';
        }
        if (!cid) {
          if (!cancelled) { setCedantId(''); setSummaryLoading(false); }
          return;
        }
        if (!cancelled) setCedantId(cid);

        let data = await api.getCedantSummary(cid).catch(e => {
          console.warn('[CedantSummary] getCedantSummary failed:', e);
          return [];
        });
        if (!Array.isArray(data)) data = [];

        if (!data.length) {
          const home = await api.getHomeSummary().catch(() => ({}));
          const all = [...(home.drafts || []), ...(home.submitted || []), ...(home.renewals || [])];
          data = all.filter(r => String(r.cedant_id || r.cedantId || '') === String(cid));
        }

        const curExists = data.some(r => String(r.contract_id || r.contractId || r.id || '') === String(contractId));
        if (!curExists) {
          const curUwYear = cTd.inceptionDate
            ? new Date(cTd.inceptionDate).getFullYear()
            : (cTd.startYear || cTd.uw_year || '');
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
            entity_type: cIsNp ? 'NP' : 'PROP',
            treaty_type: cTd.treatyTypeName || cTd.treatyType || (cIsNp ? 'Non-Prop' : ''),
            premium: curPremium,
            limit: curLimit,
            actuarial_margin: 0, actual_margin: 0, uw_margin: 0,
          });
        }

        if (cancelled) return;
        setAllRows(data);
      } catch (e) {
        console.error('[CedantSummary] fetch error:', e);
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [contractId]);

  // NP per-layer fetch — fires on first In-depth selection, after cedantId resolves
  useEffect(() => {
    if (active !== 'indepth' || npFetched || !cedantId) return;
    let cancelled = false;
    setNpLoading(true);
    api.getCedantNpLayers(cedantId)
      .then(res => {
        if (cancelled) return;
        setNpLayers(Array.isArray(res?.layers) ? res.layers : []);
        setNpFetched(true);
      })
      .catch(e => {
        if (cancelled) return;
        console.warn('[CedantSummary] getCedantNpLayers failed:', e);
        setNpLayers([]);
        setNpFetched(true);
      })
      .finally(() => { if (!cancelled) setNpLoading(false); });
    return () => { cancelled = true; };
  }, [active, cedantId, npFetched]);

  const availableYears = useMemo(() => {
    const yrs = new Set();
    allRows.forEach(r => { const y = getUwYear(r); if (y) yrs.add(y); });
    return Array.from(yrs).sort((a, b) => Number(b) - Number(a));
  }, [allRows]);

  const shared = {
    contractId, currency: props.currency,
    allRows, summaryLoading, yearFilter, setYearFilter, availableYears,
    cur100Limit, cur100Prem, isNp,
    liveModelledMargin: props.liveModelledMargin,
    liveActualMargin: props.liveActualMargin,
    npLayers, npLoading,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 13 }}>
      <TabBar active={active} onChange={setActive} />
      {active === 'overview' && <OverviewTab {...shared} />}
      {active === 'indepth'  && <InDepthTab  {...shared} />}
      {active === 'metrics'  && <ComingSoon text="Coming next — AI recommendations on line sizes" />}
    </div>
  );
}

// ── tab bar ───────────────────────────────────────────────────────────────
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

function YearFilterSelect({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
      <label style={{
        fontSize: 11, color: 'rgba(255,255,255,0.45)', letterSpacing: '.08em',
        textTransform: 'uppercase', fontWeight: 700, whiteSpace: 'nowrap',
      }}>UW Year</label>
      <select
        className="bbg-select"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: 110, height: 32, fontSize: 12 }}
      >
        <option value="ALL">All Years</option>
        {options.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}

// ── driver chip (7.4.b) ───────────────────────────────────────────────────
function DriverChip({ share, ntr }) {
  if (share == null || share < DRIVER_THRESHOLD) return null;
  const isProfit = num(ntr) > 0;
  const isLoss = num(ntr) < 0;
  if (!isProfit && !isLoss) return null;
  const label = isProfit ? 'Profit driver' : 'Loss driver';
  const c = isProfit ? '#4ade80' : '#f87171';
  const tooltip = `Contributes ${(share * 100).toFixed(1)}% of |portfolio technical result|`;
  return (
    <span title={tooltip} style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
      padding: '3px 8px', borderRadius: 12, whiteSpace: 'nowrap',
      background: `${c}18`, color: c, border: `1px solid ${c}40`,
    }}>{label}</span>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────
function OverviewTab({
  contractId, currency: rawCurrency,
  allRows, summaryLoading, yearFilter, setYearFilter, availableYears,
  cur100Limit, cur100Prem, isNp,
  liveModelledMargin, liveActualMargin,
}) {
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'USD';
  const [includeMap, setIncludeMap] = useState({});
  const [lineSizes, setLineSizes] = useState({});
  const initRef = useRef(false);

  // One-shot init of include / line-size maps once data lands
  useEffect(() => {
    if (initRef.current || !allRows.length) return;
    initRef.current = true;
    const inc = {}; const ls = {};
    allRows.forEach(r => {
      const id = idOfRow(r);
      const st = String(r.status || r.decision || r.uw_status || '').toUpperCase();
      inc[id] = !(st === 'DECLINED' || st === 'NTU');
      ls[id] = String(r.signed_line_pct || r.signedLinePct || r.written_line_pct || '');
    });
    allRows.forEach(r => {
      const id = idOfRow(r);
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
  }, [allRows]);

  const rows = yearFilter === 'ALL' ? allRows : allRows.filter(r => getUwYear(r) === yearFilter);
  const isCur = r => idOfRow(r) === String(contractId);

  const getLim100 = r => {
    if (isNp && isCur(r) && cur100Limit > 0) return cur100Limit;
    return num(ga(r, 'limit', 'treaty_limit', 'total_limit', 'qs_limit', 'total_capacity', 'capacity', 'totalCapacity', 'qs_limit_amt'));
  };
  const getPrem100 = r => {
    if (isNp && isCur(r) && cur100Prem > 0) return cur100Prem;
    return num(ga(r, 'premium', 'epi', 'premium_amt', 'written_premium', 'quota_share_epi', 'quotaShareEpi', 'gross_premium'));
  };
  const parsePct = s => { const v = parseFloat(String(s).replace('%', '').trim()); return Number.isFinite(v) ? v / 100 : 0; };
  const getActLim = r => { const lp = parsePct(lineSizes[idOfRow(r)] || ''); return lp > 0 ? getLim100(r) * lp : 0; };
  const getActSz  = r => { const lp = parsePct(lineSizes[idOfRow(r)] || ''); return lp > 0 ? getPrem100(r) * lp : 0; };

  const included = rows.filter(r => includeMap[idOfRow(r)] !== false);
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

  const allSelected = rows.length > 0 && rows.every(r => includeMap[idOfRow(r)] !== false);
  const toggleAll = () => {
    const next = !allSelected;
    const m = { ...includeMap };
    rows.forEach(r => { m[idOfRow(r)] = next; });
    setIncludeMap(m);
  };
  const toggleOne = id => setIncludeMap(prev => ({ ...prev, [id]: !prev[id] }));
  const setLine = (id, val) => setLineSizes(prev => ({ ...prev, [id]: val }));

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
        <YearFilterSelect value={yearFilter} onChange={setYearFilter} options={availableYears} />
        <button
          className="bbg-btn"
          onClick={toggleAll}
          style={{ borderColor: 'rgba(34,211,238,0.4)', color: '#22d3ee' }}
        >
          {allSelected ? '☑ Deselect All' : '☑ Select All'}
        </button>
      </div>

      {summaryLoading && (
        <div style={{
          margin: '12px 20px', padding: '10px 16px', borderRadius: 8,
          background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)',
          fontSize: 13, color: 'rgba(255,255,255,0.7)',
        }}>Loading cedant summary…</div>
      )}
      {!summaryLoading && rows.length === 0 && (
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
              const id = idOfRow(r); const cur = isCur(r); const inc = includeMap[id] !== false;
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
                  <td style={{ ...tdS, textAlign: 'right' }}>{fmtMoney(currency, getPrem100(r))}</td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{fmtMoney(currency, getLim100(r))}</td>
                  <td style={{ ...tdS, textAlign: 'right', color: '#60a5fa' }}>{getActSz(r)  ? fmtMoney(currency, getActSz(r))  : '—'}</td>
                  <td style={{ ...tdS, textAlign: 'right', color: '#60a5fa' }}>{getActLim(r) ? fmtMoney(currency, getActLim(r)) : '—'}</td>
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
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700 }}>{fmtMoney(currency, totPrem100)}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700 }}>{fmtMoney(currency, totLim100)}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700, color: '#60a5fa' }}>{totActSz  ? fmtMoney(currency, totActSz)  : '—'}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700, color: '#60a5fa' }}>{totActLim ? fmtMoney(currency, totActLim) : '—'}</td>
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

// ── In-depth Analysis tab ─────────────────────────────────────────────────
function InDepthTab({
  contractId, currency: rawCurrency,
  allRows, summaryLoading, yearFilter, setYearFilter, availableYears,
  npLayers, npLoading,
}) {
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'USD';

  const filteredRows = useMemo(
    () => (yearFilter === 'ALL' ? allRows : allRows.filter(r => getUwYear(r) === yearFilter)),
    [allRows, yearFilter],
  );

  const visibleNpContractIds = useMemo(
    () => new Set(filteredRows.filter(isNpRow).map(idOfRow)),
    [filteredRows],
  );

  const propRows = useMemo(
    () => filteredRows.filter(r => !isNpRow(r)),
    [filteredRows],
  );

  const visibleNpLayers = useMemo(
    () => npLayers.filter(l => visibleNpContractIds.has(String(l.contract_id))),
    [npLayers, visibleNpContractIds],
  );

  // Group NP layers by contract, paired with the contract's summary row
  const npGroups = useMemo(() => {
    const summaryById = new Map(filteredRows.map(r => [idOfRow(r), r]));
    const groups = new Map();
    visibleNpLayers.forEach(l => {
      const cid = String(l.contract_id);
      if (!groups.has(cid)) groups.set(cid, { layers: [], summary: summaryById.get(cid) });
      groups.get(cid).layers.push(l);
    });
    // Stable ordering: by UW year desc then by contract description
    return Array.from(groups.entries())
      .map(([cid, g]) => ({ cid, ...g }))
      .sort((a, b) => {
        const ya = Number(getUwYear(a.summary || {})) || 0;
        const yb = Number(getUwYear(b.summary || {})) || 0;
        if (yb !== ya) return yb - ya;
        return String(a.summary?.contract_description || '').localeCompare(String(b.summary?.contract_description || ''));
      });
  }, [visibleNpLayers, filteredRows]);

  // % of Portfolio denominator: NP layer premiums + PROP contract premiums
  const portfolioPremium = useMemo(() => {
    const npPrem = visibleNpLayers.reduce((s, l) => s + num(l.earned_premium), 0);
    const propPrem = propRows.reduce(
      (s, r) => s + num(ga(r, 'premium', 'epi', 'premium_amt', 'written_premium', 'quota_share_epi', 'quotaShareEpi', 'gross_premium')),
      0,
    );
    return npPrem + propPrem;
  }, [visibleNpLayers, propRows]);

  // Driver share: |NTR| / sum(|NTR|) across the same universe of visible rows
  const driverShares = useMemo(() => {
    const all = [
      ...visibleNpLayers.map(l => ({
        key: `np:${l.contract_id}:${l.layer_number}`,
        ntr: num(l.net_technical_result),
      })),
      ...propRows.map(r => ({
        key: `prop:${idOfRow(r)}`,
        ntr: num(ga(r, 'net_technical_result')),
      })),
    ];
    const total = all.reduce((s, x) => s + Math.abs(x.ntr), 0);
    const out = new Map();
    if (total === 0) return out;
    all.forEach(x => { out.set(x.key, { share: Math.abs(x.ntr) / total, ntr: x.ntr }); });
    return out;
  }, [visibleNpLayers, propRows]);

  const pctOfPortfolio = premium => {
    if (!portfolioPremium || !premium) return '—';
    return ((num(premium) / portfolioPremium) * 100).toFixed(1) + '%';
  };

  const loading = summaryLoading || npLoading;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>In-depth Analysis</div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 }}>
            Per-layer technical results and structure breakdown by contract.
          </div>
        </div>
        <YearFilterSelect value={yearFilter} onChange={setYearFilter} options={availableYears} />
      </div>

      {loading && (
        <div style={{
          margin: '12px 20px', padding: '10px 16px', borderRadius: 8,
          background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)',
          fontSize: 13, color: 'rgba(255,255,255,0.7)',
        }}>Loading in-depth data…</div>
      )}

      <NpSection
        currency={currency}
        groups={npGroups}
        contractId={contractId}
        portfolioPremium={portfolioPremium}
        driverShares={driverShares}
        pctOfPortfolio={pctOfPortfolio}
      />
      <PropSection
        currency={currency}
        rows={propRows}
        contractId={contractId}
        driverShares={driverShares}
        pctOfPortfolio={pctOfPortfolio}
      />
    </div>
  );
}

function SectionTitle({ children, count }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 10,
      padding: '18px 20px 8px',
    }}>
      <div style={{
        fontSize: 12, fontWeight: 800, letterSpacing: '.10em', textTransform: 'uppercase',
        color: '#22d3ee',
      }}>{children}</div>
      {count != null && (
        <div style={{
          fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 600,
        }}>({count})</div>
      )}
    </div>
  );
}

function SectionEmpty({ text }) {
  return (
    <div style={{
      margin: '0 20px 12px', padding: '10px 16px', borderRadius: 8,
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
      fontSize: 12, color: 'rgba(255,255,255,0.5)',
    }}>{text}</div>
  );
}

function NpSection({ currency, groups, contractId, driverShares, pctOfPortfolio }) {
  const thS = {
    padding: '10px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '.07em',
    textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)',
    borderBottom: '1px solid rgba(255,255,255,0.1)', whiteSpace: 'nowrap',
    background: 'rgba(15,26,46,0.98)',
  };
  const tdS = {
    padding: '8px 10px', verticalAlign: 'middle',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  };

  return (
    <>
      <SectionTitle count={groups.reduce((s, g) => s + g.layers.length, 0) || null}>
        Non-Proportional Layers
      </SectionTitle>
      {groups.length === 0 ? (
        <SectionEmpty text="No NP contracts" />
      ) : (
        <div style={{ margin: '0 20px 18px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 1000 }}>
            <thead>
              <tr>
                <th style={{ ...thS, textAlign: 'left',  width: 240 }}>Contract & UW Year</th>
                <th style={{ ...thS, textAlign: 'left',  width: 60  }}>Layer</th>
                <th style={{ ...thS, textAlign: 'left',  width: 200 }}>Coverage</th>
                <th style={{ ...thS, textAlign: 'left',  width: 140 }}>COBs</th>
                <th style={{ ...thS, textAlign: 'right', width: 80  }}>ROL</th>
                <th style={{ ...thS, textAlign: 'right', width: 80  }}>Reinst.</th>
                <th style={{ ...thS, textAlign: 'right', width: 130 }}>Earned Premium</th>
                <th style={{ ...thS, textAlign: 'right', width: 140 }}>Net Tech. Result</th>
                <th style={{ ...thS, textAlign: 'right', width: 100 }}>% of Portfolio</th>
                <th style={{ ...thS, textAlign: 'center', width: 130 }}>Driver</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => {
                const s = g.summary || {};
                const year = getUwYear(s);
                const cur = String(g.cid) === String(contractId);
                const desc = String(s.contract_description || s.treaty_type || `Contract ${g.cid.slice(0, 6)}`);
                const cob = String(ga(s, 'cob', 'classOfBusiness', 'class_of_business') || '—');
                const sortedLayers = [...g.layers].sort((a, b) => num(a.layer_number) - num(b.layer_number));
                return (
                  <Fragment key={g.cid}>
                    <tr style={{
                      background: cur ? 'rgba(16,185,129,0.10)' : 'rgba(34,211,238,0.06)',
                      borderLeft: cur ? '3px solid rgba(74,222,128,0.5)' : '3px solid transparent',
                    }}>
                      <td colSpan={10} style={{
                        ...tdS, padding: '10px 14px',
                        fontWeight: 700, color: '#e2e8f0',
                        borderBottom: '1px solid rgba(255,255,255,0.08)',
                      }}>
                        <span>{desc}</span>
                        {year && (
                          <span style={{
                            marginLeft: 10, color: '#22d3ee', fontWeight: 700,
                            fontSize: 11, letterSpacing: '.06em',
                          }}>{year}</span>
                        )}
                        {cur && (
                          <span style={{
                            marginLeft: 10, fontSize: 10, fontWeight: 700, color: '#4ade80',
                            textTransform: 'uppercase', letterSpacing: '.06em',
                          }}>▶ Current</span>
                        )}
                        <span style={{ marginLeft: 12, color: 'rgba(255,255,255,0.5)', fontWeight: 500, fontSize: 11 }}>
                          {String(s.treaty_type || '—')}
                        </span>
                      </td>
                    </tr>
                    {sortedLayers.map(l => {
                      const dKey = `np:${l.contract_id}:${l.layer_number}`;
                      const d = driverShares.get(dKey);
                      return (
                        <tr key={`${g.cid}-${l.layer_number}`}>
                          <td style={tdS}></td>
                          <td style={{ ...tdS, color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>L{l.layer_number}</td>
                          <td style={tdS}>
                            {fmtBareInt(l.layer_limit)} <span style={{ color: 'rgba(255,255,255,0.4)' }}>xs</span> {fmtBareInt(l.layer_deductible)}
                          </td>
                          <td style={{ ...tdS, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }} title={cob}>{cob}</td>
                          <td style={{ ...tdS, textAlign: 'right' }}>{pctCell(l.rol)}</td>
                          <td style={{ ...tdS, textAlign: 'right' }}>{l.reinstatements != null ? l.reinstatements : '—'}</td>
                          <td style={{ ...tdS, textAlign: 'right' }}>{fmtMoney(currency, l.earned_premium)}</td>
                          <td style={{ ...tdS, textAlign: 'right' }}>{signedNtrCell(currency, l.net_technical_result)}</td>
                          <td style={{ ...tdS, textAlign: 'right', color: 'rgba(255,255,255,0.7)' }}>{pctOfPortfolio(l.earned_premium)}</td>
                          <td style={{ ...tdS, textAlign: 'center' }}>
                            {d && <DriverChip share={d.share} ntr={d.ntr} />}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function PropSection({ currency, rows, contractId, driverShares, pctOfPortfolio }) {
  const thS = {
    padding: '10px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '.07em',
    textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)',
    borderBottom: '1px solid rgba(255,255,255,0.1)', whiteSpace: 'nowrap',
    background: 'rgba(15,26,46,0.98)',
  };
  const tdS = {
    padding: '8px 10px', verticalAlign: 'middle',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  };

  return (
    <>
      <SectionTitle count={rows.length || null}>Proportional Structures</SectionTitle>
      {rows.length === 0 ? (
        <SectionEmpty text="No proportional contracts" />
      ) : (
        <div style={{ margin: '0 20px 24px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 1100 }}>
            <thead>
              <tr>
                <th style={{ ...thS, textAlign: 'left',  width: 240 }}>Contract & UW Year</th>
                <th style={{ ...thS, textAlign: 'left',  width: 130 }}>Treaty Type</th>
                <th style={{ ...thS, textAlign: 'left',  width: 140 }}>COBs</th>
                <th style={{ ...thS, textAlign: 'right', width: 130 }}>Limit (100%)</th>
                <th style={{ ...thS, textAlign: 'right', width: 130 }}>Event Limit</th>
                <th style={{ ...thS, textAlign: 'right', width: 120 }}>AAL</th>
                <th style={{ ...thS, textAlign: 'right', width: 90  }}>Cession %</th>
                <th style={{ ...thS, textAlign: 'right', width: 130 }}>Premium</th>
                <th style={{ ...thS, textAlign: 'right', width: 140 }}>Net Tech. Result</th>
                <th style={{ ...thS, textAlign: 'right', width: 100 }}>% of Portfolio</th>
                <th style={{ ...thS, textAlign: 'center', width: 130 }}>Driver</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const id = idOfRow(r); const cur = id === String(contractId);
                const desc = String(r.contract_description || `Contract ${id.slice(0, 6)}`);
                const year = getUwYear(r);
                const ttype = String(ga(r, 'treaty_type', 'treatyType', 'type') || '—');
                const cob = String(ga(r, 'cob', 'classOfBusiness', 'class_of_business') || '—');
                const premium = num(ga(r, 'premium', 'epi', 'premium_amt', 'written_premium', 'quota_share_epi', 'quotaShareEpi', 'gross_premium'));
                const limit = num(ga(r, 'limit', 'treaty_limit', 'total_limit', 'qs_limit', 'total_capacity'));
                const dKey = `prop:${id}`;
                const d = driverShares.get(dKey);
                return (
                  <tr key={id + i} style={{
                    background: cur ? 'rgba(16,185,129,0.07)' : i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                    borderLeft: cur ? '3px solid rgba(74,222,128,0.5)' : '3px solid transparent',
                  }}>
                    <td style={tdS}>
                      <div style={{ fontWeight: cur ? 700 : 600, color: '#e2e8f0' }}>{desc}</div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                        {year && <span style={{ color: '#22d3ee', fontSize: 11, fontWeight: 700 }}>{year}</span>}
                        {cur && <span style={{ fontSize: 9, fontWeight: 700, color: '#4ade80', textTransform: 'uppercase', letterSpacing: '.06em' }}>▶ Current</span>}
                      </div>
                    </td>
                    <td style={{ ...tdS, fontSize: 11 }}>{ttype}</td>
                    <td style={{ ...tdS, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }} title={cob}>{cob}</td>
                    <td style={{ ...tdS, textAlign: 'right' }}>{fmtMoney(currency, limit)}</td>
                    <td style={{ ...tdS, textAlign: 'right' }}>{fmtMoney(currency, r.event_limit)}</td>
                    <td style={{ ...tdS, textAlign: 'right' }}>{fmtMoney(currency, r.aal)}</td>
                    <td style={{ ...tdS, textAlign: 'right' }}>{pctCell(r.cession_pct)}</td>
                    <td style={{ ...tdS, textAlign: 'right' }}>{fmtMoney(currency, premium)}</td>
                    <td style={{ ...tdS, textAlign: 'right' }}>{signedNtrCell(currency, r.net_technical_result)}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: 'rgba(255,255,255,0.7)' }}>{pctOfPortfolio(premium)}</td>
                    <td style={{ ...tdS, textAlign: 'center' }}>
                      {d && <DriverChip share={d.share} ntr={d.ntr} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
