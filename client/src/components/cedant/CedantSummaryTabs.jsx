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

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, HttpError } from '../../api';
import { useAppState } from '../../context/AppContext';
import { useGlobalToast } from '../../hooks/useToast';
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
  // Bumped by the Metrics tab after a commit so Overview re-reads
  // signed_line_pct / written_line_pct from contract rather than
  // showing the cached pre-commit values.
  const [summaryRefreshKey, setSummaryRefreshKey] = useState(0);
  const bumpSummaryVersion = useCallback(() => setSummaryRefreshKey(k => k + 1), []);

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
  }, [contractId, summaryRefreshKey]);

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
    cedantId,
    allRows, summaryLoading, yearFilter, setYearFilter, availableYears,
    cur100Limit, cur100Prem, isNp,
    liveModelledMargin: props.liveModelledMargin,
    liveActualMargin: props.liveActualMargin,
    npLayers, npLoading,
    bumpSummaryVersion,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 13 }}>
      <TabBar active={active} onChange={setActive} />
      {active === 'overview' && <OverviewTab {...shared} />}
      {active === 'indepth'  && <InDepthTab  {...shared} />}
      {active === 'metrics'  && <MetricsTab  {...shared} />}
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

function YearFilterSelect({ value, onChange, options }) {
  const selectId = useId();
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
      <label htmlFor={selectId} style={{
        fontSize: 11, color: 'rgba(255,255,255,0.45)', letterSpacing: '.08em',
        textTransform: 'uppercase', fontWeight: 700, whiteSpace: 'nowrap',
      }}>UW Year</label>
      <select
        id={selectId}
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

// ── Metrics tab (AI portfolio recommendations + line-size staging) ─

const RISK_OPTIONS = [
  { key: 'CONSERVATIVE',  label: 'Conservative' },
  { key: 'BALANCED',      label: 'Balanced' },
  { key: 'OPPORTUNISTIC', label: 'Opportunistic' },
];
const METRICS_CACHE_TTL_MS = 30_000;

const fmtPctFraction = (v, dp = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n * 100).toFixed(dp) + '%';
};
const fmtSignedPts = (v, dp = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '0.0 pts';
  const sign = n > 0 ? '+' : '−';
  return `${sign}${Math.abs(n * 100).toFixed(dp)} pts`;
};

function MetricsTab({
  contractId: _unusedContractId, currency: rawCurrency, cedantId,
  allRows, bumpSummaryVersion,
}) {
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'USD';
  const toast = useGlobalToast();
  const currentYear = new Date().getFullYear();

  // Run controls
  const [targetYear, setTargetYear]     = useState(currentYear);
  const [riskAppetite, setRiskAppetite] = useState('BALANCED');
  const [maxLineSize, setMaxLineSize]   = useState(20);  // slider value, percent
  const [maxCobConc, setMaxCobConc]     = useState(40);  // slider value, percent

  // Data
  const [recSet, setRecSet]                   = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [staging, setStaging]                 = useState([]);
  const [impact, setImpact]                   = useState(null);
  const [initialLoading, setInitialLoading]   = useState(true);
  const [generating, setGenerating]           = useState(false);
  const [committing, setCommitting]           = useState(false);

  const cacheRef = useRef({ ts: 0 });

  // Modal state
  const [warningsModal, setWarningsModal]     = useState(null);
  const [rejectModal, setRejectModal]         = useState(null);
  const [editModal, setEditModal]             = useState(null);
  const [commitModal, setCommitModal]         = useState(false);
  const [discardAllModal, setDiscardAllModal] = useState(false);

  const contractsById = useMemo(() => {
    const m = new Map();
    (allRows || []).forEach(r => { m.set(String(r.contract_id), r); });
    return m;
  }, [allRows]);

  const targetYearRef = useRef(targetYear);
  useEffect(() => { targetYearRef.current = targetYear; }, [targetYear]);

  const refreshData = useCallback(async ({ force = false } = {}) => {
    if (!cedantId) return;
    if (!force && Date.now() - cacheRef.current.ts < METRICS_CACHE_TTL_MS) return;
    cacheRef.current.ts = Date.now();
    try {
      const [latestRes, stagingRes, impactRes] = await Promise.allSettled([
        api.getCedantPortfolioRecsLatest(cedantId).catch(e => {
          if (e instanceof HttpError && e.status === 404) return null;
          throw e;
        }),
        api.getStaging(cedantId),
        api.getStagingImpact(cedantId),
      ]);
      if (latestRes.status === 'fulfilled' && latestRes.value) {
        const { rec_set, recommendations: recs } = latestRes.value;
        const createdAt = rec_set?.created_at ? new Date(rec_set.created_at).getTime() : 0;
        const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
        const yearMatches = Number(rec_set?.target_year) === Number(targetYearRef.current);
        if (ageDays < 7 && yearMatches) {
          setRecSet(rec_set);
          setRecommendations(recs || []);
        } else {
          setRecSet(null);
          setRecommendations([]);
        }
      } else if (latestRes.status === 'fulfilled' && !latestRes.value) {
        setRecSet(null); setRecommendations([]);
      }
      if (stagingRes.status === 'fulfilled') {
        setStaging(stagingRes.value?.items || []);
      }
      if (impactRes.status === 'fulfilled') {
        setImpact(impactRes.value || null);
      }
    } catch (e) {
      console.warn('[MetricsTab] refresh failed', e);
    } finally {
      setInitialLoading(false);
    }
  }, [cedantId]);

  useEffect(() => {
    if (!cedantId) return;
    refreshData({ force: true });
  }, [cedantId, refreshData]);

  const onGenerate = async () => {
    if (!cedantId || generating) return;
    setGenerating(true);
    try {
      const res = await api.generateCedantPortfolioRecs(cedantId, {
        target_year: Number(targetYear),
        risk_appetite: riskAppetite,
        max_line_size_pct: maxLineSize / 100,
        max_cob_concentration_pct: maxCobConc / 100,
      });
      setRecSet(res?.rec_set || null);
      setRecommendations(res?.recommendations || []);
      cacheRef.current.ts = Date.now();
      toast('Recommendations generated.');
    } catch (e) {
      console.error('[MetricsTab] generate failed', e);
      toast(`Failed to generate: ${e?.message || 'error'}`);
    } finally {
      setGenerating(false);
    }
  };

  const stageRec = async (rec, lineSizeFraction, source, acknowledged) => {
    try {
      await api.stageLineChange(cedantId, {
        contract_id: rec.contract_id,
        proposed_line_pct: lineSizeFraction,
        source,
        source_rec_id: rec.rec_id,
        warning_acknowledged: !!acknowledged,
      });
      if (source === 'AI_RECOMMENDATION') {
        setRecommendations(prev => prev.map(r =>
          r.rec_id === rec.rec_id ? { ...r, status: 'STAGED' } : r,
        ));
      }
      await refreshData({ force: true });
      toast('Staged.');
    } catch (e) {
      if (e instanceof HttpError && e.status === 422) {
        setWarningsModal({ rec, lineSize: lineSizeFraction, source });
        return;
      }
      console.error('[MetricsTab] stage failed', e);
      toast(`Failed to stage: ${e?.message || 'error'}`);
    }
  };

  const onStage = (rec) => {
    const ws = Array.isArray(rec.compliance_warnings) ? rec.compliance_warnings : [];
    if (ws.length > 0) {
      setWarningsModal({ rec, lineSize: Number(rec.recommended_line_pct), source: 'AI_RECOMMENDATION' });
    } else {
      stageRec(rec, Number(rec.recommended_line_pct), 'AI_RECOMMENDATION', false);
    }
  };

  const onEditStage = (rec) => setEditModal({ rec, value: Number(rec.recommended_line_pct) * 100 });

  const onReject = (rec) => setRejectModal({ rec, reason: '' });
  const confirmReject = async () => {
    const rec = rejectModal?.rec;
    if (!rec) return;
    try {
      await api.rejectCedantPortfolioRec(rec.rec_id, { reason: rejectModal.reason || undefined });
      setRecommendations(prev => prev.map(r =>
        r.rec_id === rec.rec_id ? { ...r, status: 'REJECTED' } : r,
      ));
      setRejectModal(null);
      toast('Rejected.');
    } catch (e) {
      console.error('[MetricsTab] reject failed', e);
      toast(`Failed to reject: ${e?.message || 'error'}`);
    }
  };

  const onUnstageRec = async (rec) => {
    const staged = staging.find(
      s => s.status === 'STAGED' && String(s.source_rec_id) === String(rec.rec_id),
    );
    if (!staged) {
      // No matching staging row found — refresh to recover state
      await refreshData({ force: true });
      return;
    }
    try {
      await api.discardStagedChange(cedantId, staged.staging_id);
      setRecommendations(prev => prev.map(r =>
        r.rec_id === rec.rec_id ? { ...r, status: 'PENDING' } : r,
      ));
      await refreshData({ force: true });
      toast('Unstaged.');
    } catch (e) {
      toast(`Failed to unstage: ${e?.message || 'error'}`);
    }
  };

  const unstageStagingRow = async (row) => {
    try {
      await api.discardStagedChange(cedantId, row.staging_id);
      if (row.source_rec_id) {
        setRecommendations(prev => prev.map(r =>
          String(r.rec_id) === String(row.source_rec_id) ? { ...r, status: 'PENDING' } : r,
        ));
      }
      await refreshData({ force: true });
      toast('Unstaged.');
    } catch (e) {
      toast(`Failed to unstage: ${e?.message || 'error'}`);
    }
  };

  const commitAll = async () => {
    setCommitting(true);
    try {
      const res = await api.commitStagedChanges(cedantId, {});
      const n = Array.isArray(res?.committed) ? res.committed.length : 0;
      // Flip every staged rec to COMMITTED locally
      setRecommendations(prev => prev.map(r =>
        r.status === 'STAGED' ? { ...r, status: 'COMMITTED' } : r,
      ));
      setCommitModal(false);
      bumpSummaryVersion?.();
      await refreshData({ force: true });
      toast(`${n} change${n === 1 ? '' : 's'} committed.`);
    } catch (e) {
      console.error('[MetricsTab] commit failed', e);
      // Refetch to roll UI state back — cards return to STAGED on failure
      await refreshData({ force: true });
      toast(`Commit failed: ${e?.message || 'error'}`);
    } finally {
      setCommitting(false);
    }
  };

  const discardAll = async () => {
    const ids = staging.filter(s => s.status === 'STAGED').map(s => s.staging_id);
    try {
      await Promise.all(ids.map(id => api.discardStagedChange(cedantId, id)));
      setRecommendations(prev => prev.map(r =>
        r.status === 'STAGED' ? { ...r, status: 'PENDING' } : r,
      ));
      setDiscardAllModal(false);
      await refreshData({ force: true });
      toast(`${ids.length} staged change${ids.length === 1 ? '' : 's'} discarded.`);
    } catch (e) {
      toast(`Discard failed: ${e?.message || 'error'}`);
    }
  };

  // Sort: REJECTED to bottom, others by impact_on_return desc
  const sortedRecs = useMemo(() => {
    return [...recommendations].sort((a, b) => {
      const aRej = String(a.status || '').toUpperCase() === 'REJECTED' ? 1 : 0;
      const bRej = String(b.status || '').toUpperCase() === 'REJECTED' ? 1 : 0;
      if (aRej !== bRej) return aRej - bRej;
      return Number(b.impact_on_return || 0) - Number(a.impact_on_return || 0);
    });
  }, [recommendations]);

  const stagedRows = useMemo(() => staging.filter(s => s.status === 'STAGED'), [staging]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' }}>
      <RunControls
        targetYear={targetYear} setTargetYear={setTargetYear}
        riskAppetite={riskAppetite} setRiskAppetite={setRiskAppetite}
        maxLineSize={maxLineSize} setMaxLineSize={setMaxLineSize}
        maxCobConc={maxCobConc} setMaxCobConc={setMaxCobConc}
        onGenerate={onGenerate}
        generating={generating}
        disabled={!cedantId}
      />

      {recSet?.portfolio_metrics && (
        <PortfolioMetricsBar metrics={recSet.portfolio_metrics} />
      )}

      <SectionTitle count={recommendations.length || null}>
        Recommendations
      </SectionTitle>
      {initialLoading ? (
        <SectionEmpty text="Loading…" />
      ) : recommendations.length === 0 ? (
        <SectionEmpty text="No recommendations yet. Configure the run controls above and click Generate Recommendations." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '0 20px 24px' }}>
          {sortedRecs.map(rec => (
            <RecommendationCard
              key={rec.rec_id}
              rec={rec}
              currency={currency}
              contract={contractsById.get(String(rec.contract_id))}
              onStage={() => onStage(rec)}
              onEditStage={() => onEditStage(rec)}
              onReject={() => onReject(rec)}
              onUnstage={() => onUnstageRec(rec)}
            />
          ))}
        </div>
      )}

      {stagedRows.length > 0 && (
        <StagingSection
          stagedRows={stagedRows}
          impact={impact}
          currency={currency}
          contractsById={contractsById}
          onUnstageRow={unstageStagingRow}
          onCommit={() => setCommitModal(true)}
          onDiscardAll={() => setDiscardAllModal(true)}
        />
      )}

      {warningsModal && (
        <WarningsConfirmModal
          warnings={warningsModal.rec.compliance_warnings || []}
          onCancel={() => setWarningsModal(null)}
          onConfirm={async () => {
            const { rec, lineSize, source } = warningsModal;
            setWarningsModal(null);
            await stageRec(rec, lineSize, source, true);
          }}
        />
      )}

      {editModal && (
        <EditStageModal
          rec={editModal.rec}
          initialPct={editModal.value}
          onCancel={() => setEditModal(null)}
          onConfirm={async (newPct) => {
            const lineSize = newPct / 100;
            const rec = editModal.rec;
            setEditModal(null);
            const ws = Array.isArray(rec.compliance_warnings) ? rec.compliance_warnings : [];
            if (ws.length > 0) {
              setWarningsModal({ rec, lineSize, source: 'MANUAL_OVERRIDE' });
            } else {
              await stageRec(rec, lineSize, 'MANUAL_OVERRIDE', false);
            }
          }}
        />
      )}

      {rejectModal && (
        <RejectConfirmModal
          rec={rejectModal.rec}
          reason={rejectModal.reason}
          onChangeReason={(reason) => setRejectModal(prev => ({ ...prev, reason }))}
          onCancel={() => setRejectModal(null)}
          onConfirm={confirmReject}
        />
      )}

      {commitModal && (
        <CommitConfirmModal
          stagedRows={stagedRows}
          currency={currency}
          contractsById={contractsById}
          onCancel={() => setCommitModal(false)}
          onConfirm={commitAll}
          committing={committing}
        />
      )}

      {discardAllModal && (
        <DiscardAllConfirmModal
          count={stagedRows.length}
          onCancel={() => setDiscardAllModal(false)}
          onConfirm={discardAll}
        />
      )}
    </div>
  );
}

// ── Run Controls ──────────────────────────────────────────────────
function RunControls({
  targetYear, setTargetYear,
  riskAppetite, setRiskAppetite,
  maxLineSize, setMaxLineSize,
  maxCobConc, setMaxCobConc,
  onGenerate, generating, disabled,
}) {
  const labelS = {
    fontSize: 11, fontWeight: 700, letterSpacing: '.08em',
    textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)',
    whiteSpace: 'nowrap',
  };
  return (
    <div style={{
      padding: '16px 20px',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      display: 'flex', flexDirection: 'column', gap: 14, flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>Run Controls</div>
        <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
          Generate AI line-size recommendations subject to your caps.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', columnGap: 16, rowGap: 10, alignItems: 'center' }}>
        <div style={labelS}>Target Year</div>
        <input
          type="number"
          value={targetYear}
          onChange={e => setTargetYear(parseInt(e.target.value, 10) || 0)}
          style={{
            background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 6, height: 32, padding: '0 10px', color: '#fff', fontSize: 13,
            width: 110, fontFamily: 'inherit', outline: 'none',
          }}
        />

        <div style={labelS}>Risk Appetite</div>
        <div style={{ display: 'flex', gap: 0, border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, width: 'fit-content', overflow: 'hidden' }}>
          {RISK_OPTIONS.map((opt, i) => {
            const isActive = riskAppetite === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => setRiskAppetite(opt.key)}
                style={{
                  background: isActive ? 'rgba(34,211,238,0.18)' : 'transparent',
                  border: 'none',
                  borderRight: i < RISK_OPTIONS.length - 1 ? '1px solid rgba(255,255,255,0.15)' : 'none',
                  padding: '7px 14px',
                  fontSize: 12, fontWeight: 700, letterSpacing: '.04em',
                  color: isActive ? '#22d3ee' : 'rgba(255,255,255,0.65)',
                  cursor: 'pointer', transition: 'color .15s, background .15s',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <div style={labelS}>Max Line Size %</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            type="range" min={0} max={50} step={1}
            value={maxLineSize}
            onChange={e => setMaxLineSize(parseInt(e.target.value, 10))}
            style={{ flex: 1, maxWidth: 320, accentColor: '#22d3ee' }}
          />
          <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: '#22d3ee', minWidth: 50, textAlign: 'right' }}>
            {maxLineSize}%
          </div>
        </div>

        <div style={labelS}>Max COB Concentration %</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            type="range" min={0} max={100} step={1}
            value={maxCobConc}
            onChange={e => setMaxCobConc(parseInt(e.target.value, 10))}
            style={{ flex: 1, maxWidth: 320, accentColor: '#22d3ee' }}
          />
          <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: '#22d3ee', minWidth: 50, textAlign: 'right' }}>
            {maxCobConc}%
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
        <button
          type="button"
          className="bbg-btn"
          onClick={onGenerate}
          disabled={generating || disabled}
          style={{
            background: generating ? 'rgba(34,211,238,0.15)' : 'rgba(34,211,238,0.22)',
            border: '1px solid rgba(34,211,238,0.5)',
            color: '#22d3ee', fontWeight: 700, padding: '8px 16px',
            opacity: (generating || disabled) ? 0.6 : 1,
            cursor: (generating || disabled) ? 'wait' : 'pointer',
          }}
        >
          {generating ? '⟳ Running…' : 'Generate Recommendations'}
        </button>
      </div>
    </div>
  );
}

// ── Portfolio metrics summary bar ─────────────────────────────────
function PortfolioMetricsBar({ metrics }) {
  const cells = [
    {
      label: 'Current Expected Return',
      value: fmtPctFraction(metrics?.current_expected_return),
      color: 'rgba(255,255,255,0.85)',
    },
    {
      label: 'Recommended Expected Return',
      value: fmtPctFraction(metrics?.recommended_expected_return),
      color: '#22d3ee',
    },
    (() => {
      const uplift = Number(metrics?.return_uplift_pct ?? 0);
      const c = uplift > 0.05 ? '#4ade80' : uplift < 0 ? '#f87171' : '#facc15';
      return {
        label: 'Return Uplift',
        value: fmtSignedPts(metrics?.return_uplift_pct),
        color: c,
      };
    })(),
    {
      label: 'Diversification',
      value: fmtPctFraction(metrics?.diversification_score),
      color: '#86efac',
    },
  ];
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 12, padding: '14px 20px',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
    }}>
      {cells.map((c, i) => (
        <div key={i} style={{
          padding: '12px 14px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 8,
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '.08em',
            textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)',
            marginBottom: 4,
          }}>{c.label}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: c.color, fontVariantNumeric: 'tabular-nums' }}>
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Recommendation card ───────────────────────────────────────────
function RecommendationCard({ rec, currency, contract, onStage, onEditStage, onReject, onUnstage }) {
  const status = String(rec.status || 'PENDING').toUpperCase();
  const isRejected  = status === 'REJECTED';
  const isStaged    = status === 'STAGED';
  const isCommitted = status === 'COMMITTED';
  const warnings = Array.isArray(rec.compliance_warnings) ? rec.compliance_warnings : [];

  const current     = Number(rec.current_line_pct ?? 0);
  const recommended = Number(rec.recommended_line_pct ?? 0);
  const delta = recommended - current;
  const deltaColor = delta > 0 ? '#4ade80' : delta < 0 ? '#f87171' : 'rgba(255,255,255,0.7)';

  const confidence = Math.max(0, Math.min(1, Number(rec.confidence ?? 0)));
  const impact = Number(rec.impact_on_return ?? 0);
  const impactColor = impact > 0 ? '#4ade80' : impact < 0 ? '#f87171' : 'rgba(255,255,255,0.7)';

  const label = String(contract?.contract_description || `Contract ${String(rec.contract_id).slice(0, 6)}`);
  const ttype = String(contract?.treaty_type || contract?.treatyType || '—');

  const opacity = isRejected ? 0.45 : 1;
  const padding = isRejected ? '8px 14px' : '14px 16px';

  return (
    <div style={{
      opacity, padding,
      background: isStaged
        ? 'rgba(74,222,128,0.06)'
        : isCommitted
        ? 'rgba(255,255,255,0.02)'
        : 'rgba(255,255,255,0.035)',
      border: `1px solid ${isStaged ? 'rgba(74,222,128,0.35)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 10,
      transition: 'opacity .15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 700, color: '#e2e8f0', fontSize: 13 }}>{label}</div>
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 12,
              background: 'rgba(34,211,238,0.12)', color: '#22d3ee',
              border: '1px solid rgba(34,211,238,0.3)', fontWeight: 700, letterSpacing: '.04em',
            }}>{ttype}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', fontWeight: 700, letterSpacing: '.06em' }}>
                CONF
              </div>
              <div style={{ width: 60, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${confidence * 100}%`, height: '100%', background: '#22d3ee' }} />
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', fontVariantNumeric: 'tabular-nums', minWidth: 32 }}>
                {(confidence * 100).toFixed(0)}%
              </div>
            </div>
          </div>
        </div>
        {(isStaged || isCommitted) && (
          <StatusChip kind={isStaged ? 'staged' : 'committed'} />
        )}
      </div>

      {!isRejected && (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'baseline' }}>
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
            Current line:{' '}
            <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{fmtPctFraction(current)}</span>
            <span style={{ margin: '0 6px', color: 'rgba(255,255,255,0.35)' }}>→</span>
            Recommended:{' '}
            <span style={{ color: '#22d3ee', fontWeight: 700 }}>{fmtPctFraction(recommended)}</span>
            <span style={{ color: deltaColor, marginLeft: 8, fontWeight: 600 }}>
              ({fmtSignedPts(delta)})
            </span>
          </div>
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
            Impact on return:{' '}
            <span style={{ color: impactColor, fontWeight: 700 }}>
              {currency} {Math.abs(impact).toLocaleString('en-US', { maximumFractionDigits: 0 })}
              {impact < 0 ? ' (loss)' : ''}
            </span>
          </div>
        </div>
      )}

      {!isRejected && rec.rationale && (
        <div style={{
          marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.65)',
          fontStyle: 'italic', borderLeft: '2px solid rgba(255,255,255,0.12)',
          paddingLeft: 10,
        }}>
          "{rec.rationale}"
        </div>
      )}

      {!isRejected && warnings.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {warnings.map((w, i) => (
            <span key={i} title={w} style={{
              fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 12,
              background: 'rgba(251,191,36,0.15)', color: '#facc15',
              border: '1px solid rgba(251,191,36,0.35)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              maxWidth: 220, cursor: 'help',
            }}>⚠ {w}</span>
          ))}
        </div>
      )}

      {!isRejected && !isCommitted && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          {isStaged ? (
            <button type="button" onClick={onUnstage} style={btnSecondary()}>Unstage</button>
          ) : (
            <>
              <button type="button" onClick={onStage} style={btnPrimary()}>Stage</button>
              <button type="button" onClick={onEditStage} style={btnSecondary()}>Edit &amp; Stage</button>
              <button type="button" onClick={onReject} style={btnDanger()}>Reject</button>
            </>
          )}
        </div>
      )}

      {isRejected && (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
          {label} — rejected
        </div>
      )}
    </div>
  );
}

function StatusChip({ kind }) {
  const cfg = kind === 'staged'
    ? { bg: 'rgba(74,222,128,0.18)', fg: '#4ade80', text: 'Staged' }
    : { bg: 'rgba(148,163,184,0.18)', fg: '#94a3b8', text: 'Committed' };
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase',
      padding: '3px 9px', borderRadius: 12, whiteSpace: 'nowrap',
      background: cfg.bg, color: cfg.fg, border: `1px solid ${cfg.fg}55`,
    }}>{cfg.text}</span>
  );
}

const btnPrimary = () => ({
  background: 'rgba(34,211,238,0.18)', border: '1px solid rgba(34,211,238,0.45)',
  color: '#22d3ee', padding: '6px 12px', borderRadius: 6,
  fontSize: 12, fontWeight: 700, letterSpacing: '.04em', cursor: 'pointer',
});
const btnSecondary = () => ({
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.18)',
  color: 'rgba(255,255,255,0.8)', padding: '6px 12px', borderRadius: 6,
  fontSize: 12, fontWeight: 700, letterSpacing: '.04em', cursor: 'pointer',
});
const btnDanger = () => ({
  background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.35)',
  color: '#f87171', padding: '6px 12px', borderRadius: 6,
  fontSize: 12, fontWeight: 700, letterSpacing: '.04em', cursor: 'pointer',
});

// ── Staging Section (compare + commit) ────────────────────────────
function StagingSection({ stagedRows, impact, currency, contractsById, onUnstageRow, onCommit, onDiscardAll }) {
  const [sortKey, setSortKey] = useState('delta');
  const [sortDir, setSortDir] = useState('desc');

  const sorted = useMemo(() => {
    const out = [...stagedRows];
    const dir = sortDir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      const aV = sortValue(a, sortKey, contractsById);
      const bV = sortValue(b, sortKey, contractsById);
      if (aV == null && bV == null) return 0;
      if (aV == null) return 1;
      if (bV == null) return -1;
      if (typeof aV === 'string') return aV.localeCompare(bV) * dir;
      return (aV - bV) * dir;
    });
    return out;
  }, [stagedRows, sortKey, sortDir, contractsById]);

  const setSort = (key) => {
    if (key === sortKey) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  return (
    <>
      <div style={{
        padding: '14px 20px 6px',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          fontSize: 12, fontWeight: 800, letterSpacing: '.10em',
          textTransform: 'uppercase', color: '#22d3ee',
        }}>Staged Changes — Review &amp; Commit</div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 12,
          background: 'rgba(74,222,128,0.12)', color: '#4ade80',
          border: '1px solid rgba(74,222,128,0.35)',
        }}>{stagedRows.length} change{stagedRows.length === 1 ? '' : 's'} staged</span>
      </div>

      {impact && (
        <PortfolioImpactPanel impact={impact} currency={currency} />
      )}

      <div style={{ margin: '0 20px 14px', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 1000 }}>
          <thead>
            <tr>
              <SortHeader label="Contract & UW Year" k="label" sortKey={sortKey} sortDir={sortDir} onClick={setSort} width={240} align="left" />
              <SortHeader label="Treaty Type" k="treaty_type" sortKey={sortKey} sortDir={sortDir} onClick={setSort} width={140} align="left" />
              <SortHeader label="Source" k="source" sortKey={sortKey} sortDir={sortDir} onClick={setSort} width={120} align="left" />
              <SortHeader label="Current Line" k="current" sortKey={sortKey} sortDir={sortDir} onClick={setSort} width={110} align="right" />
              <SortHeader label="Staged Line" k="proposed" sortKey={sortKey} sortDir={sortDir} onClick={setSort} width={110} align="right" />
              <SortHeader label="Δ pts" k="delta" sortKey={sortKey} sortDir={sortDir} onClick={setSort} width={90} align="right" />
              <SortHeader label="Warnings" k="warnings" sortKey={sortKey} sortDir={sortDir} onClick={setSort} width={90} align="center" />
              <th style={thSortStyle({ align: 'center', width: 120 })}>Action</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => {
              const cob = contractsById.get(String(row.contract_id));
              const year = cob ? getUwYear(cob) : '';
              const cur = Number(row.current_line_pct ?? 0);
              const proposed = Number(row.proposed_line_pct ?? 0);
              const delta = Number(row.delta_pct ?? (proposed - cur));
              const deltaColor = delta > 0 ? '#4ade80' : delta < 0 ? '#f87171' : 'rgba(255,255,255,0.65)';
              const warnings = Array.isArray(row.compliance_warnings) ? row.compliance_warnings : [];
              const tooltip = warnings.length ? warnings.join('\n') : '';
              return (
                <tr key={row.staging_id}>
                  <td style={tdStaging()}>
                    <div style={{ fontWeight: 600, color: '#e2e8f0' }}>{row.contract_label}</div>
                    {year && <div style={{ color: '#22d3ee', fontSize: 11, fontWeight: 700 }}>{year}</div>}
                  </td>
                  <td style={tdStaging()}>{String(row.treaty_type || '—')}</td>
                  <td style={tdStaging()}>
                    <span style={{
                      fontSize: 10, padding: '2px 7px', borderRadius: 10,
                      background: row.source === 'AI_RECOMMENDATION'
                        ? 'rgba(34,211,238,0.12)'
                        : 'rgba(168,85,247,0.12)',
                      color: row.source === 'AI_RECOMMENDATION' ? '#22d3ee' : '#a855f7',
                      border: '1px solid currentColor', fontWeight: 700,
                    }}>{row.source === 'AI_RECOMMENDATION' ? 'AI' : 'Manual'}</span>
                  </td>
                  <td style={{ ...tdStaging(), textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtPctFraction(cur)}</td>
                  <td style={{ ...tdStaging(), textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#22d3ee', fontWeight: 700 }}>{fmtPctFraction(proposed)}</td>
                  <td style={{ ...tdStaging(), textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: deltaColor, fontWeight: 700 }}>{fmtSignedPts(delta)}</td>
                  <td style={{ ...tdStaging(), textAlign: 'center' }}>
                    {warnings.length > 0 ? (
                      <span title={tooltip} style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 12,
                        background: 'rgba(251,191,36,0.15)', color: '#facc15',
                        border: '1px solid rgba(251,191,36,0.35)', cursor: 'help',
                      }}>⚠ {warnings.length}</span>
                    ) : (
                      <span style={{ color: 'rgba(255,255,255,0.35)' }}>—</span>
                    )}
                  </td>
                  <td style={{ ...tdStaging(), textAlign: 'center' }}>
                    <button type="button" onClick={() => onUnstageRow(row)} style={btnSecondary()}>Unstage</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{
        padding: '8px 20px 24px',
        display: 'flex', justifyContent: 'flex-end', gap: 10,
      }}>
        <button type="button" onClick={onDiscardAll} style={btnDanger()}>Discard all</button>
        <button type="button" onClick={onCommit} style={{ ...btnPrimary(), padding: '8px 16px' }}>Review &amp; Commit</button>
      </div>
    </>
  );
}

function sortValue(row, key, contractsById) {
  // contractsById exposed to enable future enrichment (currently unused)
  void contractsById;
  switch (key) {
    case 'label': return String(row.contract_label || '');
    case 'treaty_type': return String(row.treaty_type || '');
    case 'source': return String(row.source || '');
    case 'current': return Number(row.current_line_pct ?? 0);
    case 'proposed': return Number(row.proposed_line_pct ?? 0);
    case 'delta': return Number(row.delta_pct ?? (Number(row.proposed_line_pct ?? 0) - Number(row.current_line_pct ?? 0)));
    case 'warnings': return Array.isArray(row.compliance_warnings) ? row.compliance_warnings.length : 0;
    default: return 0;
  }
}

function thSortStyle({ align = 'left', width }) {
  return {
    padding: '10px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '.07em',
    textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)',
    borderBottom: '1px solid rgba(255,255,255,0.1)', whiteSpace: 'nowrap',
    textAlign: align, width,
  };
}

function SortHeader({ label, k, sortKey, sortDir, onClick, width, align }) {
  const active = sortKey === k;
  const arrow = active ? (sortDir === 'asc' ? '↑' : '↓') : '';
  return (
    <th
      style={{ ...thSortStyle({ align, width }), cursor: 'pointer', userSelect: 'none' }}
      onClick={() => onClick(k)}
    >
      {label} {arrow && <span style={{ color: '#22d3ee' }}>{arrow}</span>}
    </th>
  );
}

function tdStaging() {
  return {
    padding: '8px 10px', verticalAlign: 'middle',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  };
}

function PortfolioImpactPanel({ impact, currency }) {
  const money = v => v == null ? '—' : `${currency} ${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const cur = impact.current || {};
  const stg = impact.staged  || {};
  const dlt = impact.delta   || {};

  const pair = (label, before, after, deltaText, deltaColor) => (
    <div style={{
      padding: '10px 12px',
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 8,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '.08em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)',
        marginBottom: 4,
      }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{before}</div>
        <div style={{ color: 'rgba(255,255,255,0.35)' }}>→</div>
        <div style={{ color: '#22d3ee', fontWeight: 700, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{after}</div>
      </div>
      <div style={{ marginTop: 4, color: deltaColor, fontWeight: 700, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{deltaText}</div>
    </div>
  );

  const pDelta = Number(dlt.premium || 0);
  const tDelta = Number(dlt.technical_result || 0);
  const uplift = Number(dlt.return_uplift_pct || 0);

  return (
    <div style={{
      margin: '0 20px 8px',
      display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
    }}>
      {pair(
        'Premium',
        money(cur.total_premium), money(stg.total_premium),
        `${pDelta >= 0 ? '+' : '−'}${money(Math.abs(pDelta)).replace('—', '0')}`,
        pDelta > 0 ? '#4ade80' : pDelta < 0 ? '#f87171' : 'rgba(255,255,255,0.5)',
      )}
      {pair(
        'Technical Result',
        money(cur.total_technical_result), money(stg.total_technical_result),
        `${tDelta >= 0 ? '+' : '−'}${money(Math.abs(tDelta)).replace('—', '0')}`,
        tDelta > 0 ? '#4ade80' : tDelta < 0 ? '#f87171' : 'rgba(255,255,255,0.5)',
      )}
      {pair(
        'Expected Return',
        fmtPctFraction(cur.expected_return_pct), fmtPctFraction(stg.expected_return_pct),
        fmtSignedPts(uplift),
        uplift > 0 ? '#4ade80' : uplift < 0 ? '#f87171' : 'rgba(255,255,255,0.5)',
      )}
    </div>
  );
}

// ── Modals ────────────────────────────────────────────────────────
function Modal({ title, onClose, children, footer, width = 520 }) {
  return (
    <div
      // Backdrop dismissal is a pointer-only convenience; keyboard users
      // close via the labelled footer buttons (every usage passes some).
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div role="dialog" aria-modal="true" style={{
        background: '#0f1a2e', border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 12, width, maxWidth: 'calc(100vw - 40px)',
        maxHeight: 'calc(100vh - 40px)', display: 'flex', flexDirection: 'column',
        boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
      }}>
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.1)',
          fontWeight: 700, fontSize: 14, color: '#fff',
        }}>{title}</div>
        <div style={{ padding: '16px 18px', overflowY: 'auto', flex: 1 }}>{children}</div>
        {footer && (
          <div style={{
            padding: '12px 18px', borderTop: '1px solid rgba(255,255,255,0.1)',
            display: 'flex', justifyContent: 'flex-end', gap: 8,
          }}>{footer}</div>
        )}
      </div>
    </div>
  );
}

function WarningsConfirmModal({ warnings, onCancel, onConfirm }) {
  return (
    <Modal
      title={`This recommendation has ${warnings.length} compliance warning${warnings.length === 1 ? '' : 's'}.`}
      onClose={onCancel}
      footer={(
        <>
          <button type="button" onClick={onCancel} style={btnSecondary()}>Cancel</button>
          <button type="button" onClick={onConfirm} style={btnPrimary()}>Acknowledge &amp; Stage</button>
        </>
      )}
    >
      <ul style={{ margin: 0, padding: '0 0 0 18px', color: 'rgba(255,255,255,0.75)', fontSize: 13 }}>
        {warnings.map((w, i) => (
          <li key={i} style={{ marginBottom: 6 }}>{w}</li>
        ))}
      </ul>
    </Modal>
  );
}

function EditStageModal({ rec, initialPct, onCancel, onConfirm }) {
  const [value, setValue] = useState(initialPct);
  const lineSizeFraction = (Number(value) || 0) / 100;
  const current = Number(rec.current_line_pct ?? 0);
  const delta = lineSizeFraction - current;
  return (
    <Modal
      title="Edit &amp; Stage"
      onClose={onCancel}
      footer={(
        <>
          <button type="button" onClick={onCancel} style={btnSecondary()}>Cancel</button>
          <button type="button" onClick={() => onConfirm(Number(value) || 0)} style={btnPrimary()}>Stage</button>
        </>
      )}
    >
      <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 12 }}>
        Override the recommended line size. The change is recorded as a manual
        adjustment with lineage to the original recommendation.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="number" step="0.5" min={0} max={100}
          value={value}
          onChange={e => setValue(parseFloat(e.target.value))}
          style={{
            background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 6, height: 36, padding: '0 10px', color: '#fff', fontSize: 15,
            width: 120, fontFamily: 'inherit', outline: 'none',
            fontVariantNumeric: 'tabular-nums',
          }}
        />
        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>%</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
          Δ from current: <span style={{ fontWeight: 700, color: delta > 0 ? '#4ade80' : delta < 0 ? '#f87171' : 'rgba(255,255,255,0.7)' }}>
            {fmtSignedPts(delta)}
          </span>
        </div>
      </div>
    </Modal>
  );
}

function RejectConfirmModal({ rec, reason, onChangeReason, onCancel, onConfirm }) {
  return (
    <Modal
      title="Reject recommendation"
      onClose={onCancel}
      footer={(
        <>
          <button type="button" onClick={onCancel} style={btnSecondary()}>Cancel</button>
          <button type="button" onClick={onConfirm} style={btnDanger()}>Reject</button>
        </>
      )}
    >
      <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13, marginBottom: 10 }}>
        Reject this recommendation. It will be excluded from staging and the rec
        set keeps a record of the decision. Reason is optional.
      </div>
      <textarea
        value={reason}
        onChange={e => onChangeReason(e.target.value)}
        placeholder="Optional reason…"
        rows={4}
        style={{
          width: '100%', padding: '8px 10px', resize: 'vertical',
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.18)',
          borderRadius: 6, color: '#fff', fontFamily: 'inherit', fontSize: 13, outline: 'none',
        }}
      />
      <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
        Contract: {String(rec?.contract_id || '').slice(0, 8)}…
      </div>
    </Modal>
  );
}

function CommitConfirmModal({ stagedRows, currency, contractsById, onCancel, onConfirm, committing }) {
  const n = stagedRows.length;
  return (
    <Modal
      title={`Commit ${n} line-size change${n === 1 ? '' : 's'}?`}
      onClose={committing ? () => {} : onCancel}
      width={620}
      footer={(
        <>
          <button type="button" onClick={onCancel} style={btnSecondary()} disabled={committing}>Cancel</button>
          <button type="button" onClick={onConfirm} style={btnPrimary()} disabled={committing}>
            {committing ? '⟳ Committing…' : 'Commit'}
          </button>
        </>
      )}
    >
      <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 12 }}>
        This will update {n} contract{n === 1 ? '' : 's'}. The change is recorded in the audit log.
      </div>
      <div style={{
        border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8,
        overflow: 'hidden',
      }}>
        {stagedRows.map((row, i) => {
          const cob = contractsById.get(String(row.contract_id));
          const year = cob ? getUwYear(cob) : '';
          const cur = Number(row.current_line_pct ?? 0);
          const proposed = Number(row.proposed_line_pct ?? 0);
          const delta = Number(row.delta_pct ?? (proposed - cur));
          return (
            <div key={row.staging_id} style={{
              padding: '8px 12px', fontSize: 12,
              background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.025)',
              borderBottom: i < stagedRows.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#e2e8f0' }}>
                {row.contract_label}
                {year && <span style={{ marginLeft: 8, color: '#22d3ee', fontWeight: 700, fontSize: 11 }}>{year}</span>}
              </div>
              <div style={{ color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
                {fmtPctFraction(cur)} → <span style={{ color: '#22d3ee', fontWeight: 700 }}>{fmtPctFraction(proposed)}</span>
              </div>
              <div style={{ minWidth: 70, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                color: delta > 0 ? '#4ade80' : delta < 0 ? '#f87171' : 'rgba(255,255,255,0.5)',
                fontWeight: 700 }}>
                {fmtSignedPts(delta)}
              </div>
            </div>
          );
        })}
      </div>
      {currency && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
          Currency: {currency}
        </div>
      )}
    </Modal>
  );
}

function DiscardAllConfirmModal({ count, onCancel, onConfirm }) {
  return (
    <Modal
      title={`Discard ${count} staged change${count === 1 ? '' : 's'}?`}
      onClose={onCancel}
      footer={(
        <>
          <button type="button" onClick={onCancel} style={btnSecondary()}>Cancel</button>
          <button type="button" onClick={onConfirm} style={btnDanger()}>Discard</button>
        </>
      )}
    >
      <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
        All staged changes will be cleared. The underlying recommendations
        return to PENDING and can be re-staged later.
      </div>
    </Modal>
  );
}
