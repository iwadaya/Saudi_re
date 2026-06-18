import React, { useState, useEffect, useCallback, useId, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { getUserDisplayName, getSession, canAccessApprovals } from '../../utils/auth';
import { formatDate } from '../../utils/format';
import { useAppState } from '../../context/AppContext';
import Topbar, { useViewingUser, setViewingUser } from '../../components/Topbar';
import {
  setActiveContractId,
  setActiveQuoteId,
  clearActiveContractId,
} from '../../hooks/useContractId';
import { exportPortfolioToExcel } from './exportPortfolio';
import { EveryonePanel } from './HomeOwnership';
import ReinsurerAnalysisModal from './ReinsurerAnalysisModal';
import { useViewAllTreaties } from '../../utils/prefs';

/* ── workflow normalisation ── */
const WF = {
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  PENDING_APPROVAL: 'AWAITING_APPROVAL', OFFERED: 'AWAITING_APPROVAL',
  DISPUTE_PENDING: 'AWAITING_APPROVAL', RETURNED: 'DRAFT',
  AWAITING_SIGNED_LINE: 'AWAITING_SIGNED_LINE',
  APPROVED: 'AWAITING_SIGNED_LINE',
  SIGNED: 'SIGNED', BOUND: 'SIGNED', NTU: 'NTU', DECLINED: 'DECLINED',
};
const WF_LABELS = {
  AWAITING_APPROVAL: 'Awaiting approval', AWAITING_SIGNED_LINE: 'Awaiting signed line',
  DISPUTE_PENDING: 'Dispute pending', RETURNED: 'Returned to UW',
  SIGNED: 'Signed', NTU: 'NTU', DECLINED: 'Declined', DRAFT: 'Draft',
};
function normWf(row) {
  const s = String(row?.uw_status || row?.uwStatus || row?.status || '').trim().toUpperCase();
  const key = WF[s] || 'DRAFT';
  return { key, label: WF_LABELS[key] || 'Draft' };
}
function isNpType(type, category) {
  const t = String(type || '').toUpperCase();
  // Guard against String(null)="null" — only trust category if it's a real value
  const rawC = (category && category !== 'null' && category !== 'NULL') ? String(category) : '';
  const c = rawC.toUpperCase();
  return c.includes('NON') || t.includes('XL') || t.includes('EXCESS') || t.includes('STOP LOSS') || t.includes('STOP_LOSS') || t.includes('CAT') || /\bNP\b/.test(t);
}
function statusClass(key) {
  if (key === 'SIGNED') return 'status-quoted';
  if (key === 'DECLINED') return 'status-declined';
  if (key === 'NTU') return 'status-offered';
  if (key === 'AWAITING_APPROVAL' || key === 'AWAITING_SIGNED_LINE') return 'status-pending';
  return '';
}

// Pure row-normaliser. No closure deps → module scope rather than a
// useCallback in the component. The recType param distinguishes treaty
// rows from quote rows since the workflow-status mapping differs.
function normalizeRow(r, recType = 'TREATY') {
  const wf = recType === 'TREATY' ? normWf(r) : { key: String(r?.status || 'DRAFT').toUpperCase(), label: r?.status || 'Draft' };
  return {
    id: r.id, cedantName: r.name || r.cedantName || r.cedant || 'Unnamed',
    country: r.country || '', treatyType: r.treaty_type || r.treatyType || 'Treaty',
    treatyCategory: r.treaty_category || r.treatyCategory || '',
    status: wf.key, statusLabel: wf.label, broker: r.broker || '–', cob: r.cob || '–',
    updatedAt: r.updated_at || r.updatedAt, renewalDate: r.renewal_date || r.renewalDate,
    uwYear: r.uw_year || r.uwYear, recordType: recType, isQuote: recType === 'QUOTE',
    isRenewal: !!(r.parent_contract_id), cedantId: r.cedant_id || r.cedantId,
    quoteRef: r.quote_ref || r.quoteRef || null,
    quoteVersion: r.quote_version || r.quoteVersion || null,
  };
}

// Close the modal on Escape — standard a11y expectation, missing from
// every screen-level modal in this file. `enabled` lets us skip wiring
// the listener while the modal is closed.
function useEscapeKey(enabled, onEscape) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onEscape(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onEscape]);
}

/* ── Shared sub-components ── */
function StatCard({ label, value, sub }) {
  return (<div className="stat-card"><div className="stat-label">{label}</div><div className="stat-value">{value ?? '–'}</div>{sub && <div className="stat-sub">{sub}</div>}</div>);
}
function RegionBar({ name, actual, target }) {
  const pct = target > 0 ? Math.min(100, (actual / target) * 100) : 0;
  // Gradient end colour based on progress
  const endColor = pct >= 100 ? '#4ade80' : pct >= 75 ? '#00d4ff' : pct >= 50 ? '#a78bfa' : '#6366f1';
  const achievedColor = pct >= 100 ? '#4ade80' : pct >= 75 ? '#00d4ff' : 'rgba(148,163,184,0.65)';
  return (
    <div className="region-card">
      <div className="region-top">
        <div className="region-name">{name}</div>
        <div className="region-values">{actual}M / {target}M</div>
      </div>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${Math.max(2, pct)}%`, background: `linear-gradient(90deg, #22c55e, ${endColor})` }} />
      </div>
      <div className="region-achieved" style={{ color: achievedColor }}>{Math.round(pct)}% achieved</div>
    </div>
  );
}
const ROLE_COLORS_MINI = { CE:'#a78bfa', CU:'#fbbf24', TD:'#60a5fa', TM:'#2dd4bf', TUW:'#23d18b' };

function DraftRow({ item, onOpen, onAllocate, canAllocate, viewingOther }) {
  const wf = normWf(item);
  const ownerName = item.assignedToName;
  const ownerRole = item.assignedToRole;
  const ownerColor = ROLE_COLORS_MINI[ownerRole] || '#94a3b8';

  return (
    <div className="draft-row" style={{ cursor:'default' }}>
      <div style={{ flex:1, minWidth:0, cursor: viewingOther ? 'default' : 'pointer' }}
        role="button" tabIndex={viewingOther ? -1 : 0}
        onClick={() => !viewingOther && onOpen(item)}
        onKeyDown={(e) => {
          if (viewingOther) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item); }
        }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <div className="draft-title" style={{ color: '#f8fafc', fontWeight: 600 }}>{item.cedantName || 'Untitled'}</div>
          {item.isQuote && (
            <span style={{ fontSize:9, padding:'1px 6px', borderRadius:10, background:'rgba(251,191,36,0.12)', border:'1px solid rgba(251,191,36,0.35)', color:'#fbbf24', fontWeight:700, whiteSpace:'nowrap' }}>
              📋 QUOTE{item.quoteRef ? ` · ${item.quoteRef}` : ''}
            </span>
          )}
        </div>
        <div className="draft-sub" style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 2 }}>
          {item.country ? `${item.country} · ` : ''}{item.uwYear ? `${item.uwYear} · ` : ''}Broker: {item.broker || '–'} · COB: {item.cob || '–'}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:2 }}>
          <div className={`draft-meta ${statusClass(wf.key)}`}>{wf.label} · {item.treatyType || '–'} · {item.updatedAt ? formatDate(item.updatedAt) : 'New'}</div>
          {item.isRenewal && (
            <span style={{ fontSize:9, padding:'1px 6px', borderRadius:10, background:'rgba(96,165,250,0.12)', border:'1px solid rgba(96,165,250,0.30)', color:'#60a5fa', fontWeight:700, whiteSpace:'nowrap' }}>
              🔄 Renewal
            </span>
          )}
          {ownerName && (
            <span style={{ fontSize:9, padding:'1px 6px', borderRadius:10, background:`${ownerColor}18`, border:`1px solid ${ownerColor}35`, color:ownerColor, fontWeight:700, whiteSpace:'nowrap' }}>
              {ownerName}
            </span>
          )}
        </div>
      </div>
      <div style={{ display:'flex', gap:6, flexShrink:0, alignItems:'center' }}>
        {viewingOther && canAllocate && (
          <button onClick={() => onAllocate(item)} style={{ padding:'4px 10px', borderRadius:6, border:'1px solid rgba(35,209,139,0.45)', background:'rgba(35,209,139,0.10)', color:'#23d18b', fontSize:11, fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' }}>
            + Allocate
          </button>
        )}
        {!viewingOther && (
          <div className="draft-open" role="button" tabIndex={0}
            onClick={() => onOpen(item)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item); }
            }}
            style={{ cursor:'pointer' }}>Open →</div>
        )}
      </div>
    </div>
  );
}

/* ── Filter Bar ── */
function FilterBar({ countries, cedants, countryFilter, cedantFilter, onCountryChange, onCedantChange }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
      <select className="form-input" style={{ flex: '1 1 140px', fontSize: 11, padding: '5px 8px', minWidth: 0 }}
        value={countryFilter} onChange={e => { onCountryChange(e.target.value); onCedantChange(''); }}>
        <option value="">All Countries</option>
        {countries.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      <select className="form-input" style={{ flex: '1 1 160px', fontSize: 11, padding: '5px 8px', minWidth: 0 }}
        value={cedantFilter} onChange={e => onCedantChange(e.target.value)}>
        <option value="">All Cedants</option>
        {cedants.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>
  );
}

/* ── Filtered Panel ── */
function FilteredPanel({ title, badge, items, loading, emptyMsg, onOpen, badgeStyle, onAllocate, canAllocate, viewingOther }) {
  const [countryFilter, setCountryFilter] = useState('');
  const [cedantFilter, setCedantFilter] = useState('');

  const panelCountries = useMemo(() => [...new Set(items.map(i => i.country).filter(Boolean))].sort(), [items]);
  const panelCedants = useMemo(() => {
    let list = items;
    if (countryFilter) list = list.filter(i => i.country === countryFilter);
    return [...new Set(list.map(i => i.cedantName).filter(Boolean))].sort();
  }, [items, countryFilter]);

  const filtered = useMemo(() => {
    let list = items;
    if (countryFilter) list = list.filter(i => i.country === countryFilter);
    if (cedantFilter) list = list.filter(i => i.cedantName === cedantFilter);
    return list;
  }, [items, countryFilter, cedantFilter]);

  return (
    <section className="panel glass">
      <div className="panel-head">
        <div className="panel-title">{title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {filtered.length !== items.length && (
            <span style={{ fontSize: 10, color: '#fbbf24', marginRight: 4 }}>{filtered.length}/{items.length}</span>
          )}
          <div className="pill-mini" style={badgeStyle || {}}>{badge}</div>
        </div>
      </div>
      <FilterBar
        countries={panelCountries} cedants={panelCedants}
        countryFilter={countryFilter} cedantFilter={cedantFilter}
        onCountryChange={setCountryFilter} onCedantChange={setCedantFilter}
      />
      <div className="draft-body" style={{ maxHeight: 260, overflowY: 'auto' }}>
        {loading && items.length === 0
          ? <div className="muted" style={{ padding: 12 }}>Loading…</div>
          : filtered.length === 0
            ? <div className="muted" style={{ padding: 12 }}>{emptyMsg}</div>
            : filtered.map(d => <DraftRow key={d.id} item={d} onOpen={onOpen} onAllocate={onAllocate} canAllocate={canAllocate} viewingOther={viewingOther} />)}
      </div>
    </section>
  );
}

/* ── Renewal Wizard Modal ── */
function RenewalModal({ open, onClose, onRenew }) {
  const fid = useId(); // prefix for the wizard field ids (label ↔ control)
  const [countries, setCountries] = useState([]);
  const [cedants, setCedants] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [selCountry, setSelCountry] = useState('');
  const [selCedant, setSelCedant] = useState('');
  const [selContract, setSelContract] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setSelCountry(''); setSelCedant(''); setSelContract('');
    setCedants([]); setContracts([]); setError(''); setBusy(true);
    api.getRefListItems('country').then(c => setCountries(c || []))
      .catch(() => setError('Could not load countries.'))
      .finally(() => setBusy(false));
  }, [open]);

  const handleCountry = async (id) => {
    setSelCountry(id); setSelCedant(''); setSelContract('');
    setContracts([]); setCedants([]); setError('');
    if (!id) return;
    setBusy(true);
    try { setCedants(await api.listCedants({ countryId: id }) || []); } catch { setError('Could not load cedants.'); }
    setBusy(false);
  };
  const handleCedant = async (id) => {
    setSelCedant(id); setSelContract(''); setContracts([]); setError('');
    if (!id) return;
    setBusy(true);
    try {
      // Use direct endpoint — returns ALL statuses so signed/NTU contracts are renewable
      const rows = await api.listTreaties({ cedant_id: id, limit: 200 });
      // Sort by uw_year desc (newest first)
      setContracts(Array.isArray(rows) ? rows.sort((a,b) => (b.uw_year||0)-(a.uw_year||0)) : []);
    } catch { setError('Could not load contracts.'); }
    setBusy(false);
  };
  const doRenew = async () => {
    if (!selContract) return;
    setBusy(true); setError('');
    try {
      const res = await api.renewContract(selContract);
      if (res?.id) { onRenew(res.id, res.is_np); onClose(); } else throw new Error('No ID returned');
    } catch (e) { setError('Renewal failed: ' + (e?.message || 'Unknown error')); }
    setBusy(false);
  };

  // Backdrop / escape close the modal, but only when nothing's in flight —
  // otherwise a stray click cancels work the user is waiting on.
  const safeClose = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useEscapeKey(open, safeClose);

  if (!open) return null;
  return (
    <div className="renew-modal is-ready">
      {/* Backdrop dismissal is a pointer-only convenience; keyboard users
          close via Escape (useEscapeKey above) or the labelled ✕ button. */}
      <div className="renew-backdrop" role="presentation" onClick={safeClose} />
      <div className="renew-panel glass" role="dialog" aria-modal="true">
        <div className="renew-head"><div><div className="renew-kicker">RENEWAL WIZARD</div><div className="renew-title">Renew Treaty</div></div><button className="renew-x" onClick={safeClose} aria-label="Close" disabled={busy}>✕</button></div>
        <div className="renew-steps">
          <div className={`renew-step ${selCountry ? 'done' : 'active'}`}><span className="dot" /><span>Country</span></div>
          <div className={`renew-step ${selCedant ? 'done' : selCountry ? 'active' : ''}`}><span className="dot" /><span>Cedant</span></div>
          <div className={`renew-step ${selContract ? 'done' : selCedant ? 'active' : ''}`}><span className="dot" /><span>Contract</span></div>
        </div>
        <div className="renew-body">
          {error && <div className="renew-alert">{error}</div>}
          <div className="renew-field"><label className="renew-label" htmlFor={`${fid}-country`}>1) Select Country</label><div className="renew-control">
            <select id={`${fid}-country`} className="renew-select" value={selCountry} onChange={e => handleCountry(e.target.value)} disabled={busy}>
              <option value="">Select Country...</option>{countries.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div></div>
          <div className="renew-field"><label className="renew-label" htmlFor={`${fid}-cedant`}>2) Select Cedant</label><div className="renew-control">
            <select id={`${fid}-cedant`} className="renew-select" value={selCedant} onChange={e => handleCedant(e.target.value)} disabled={!selCountry || busy}>
              <option value="">Select Cedant...</option>{cedants.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div></div>
          <div className="renew-field"><label className="renew-label" htmlFor={`${fid}-contract`}>3) Select Contract</label><div className="renew-control">
            <select id={`${fid}-contract`} className="renew-select" value={selContract} onChange={e => setSelContract(e.target.value)} disabled={!selCedant || busy}>
              <option value="">Select Contract to Renew...</option>
              {contracts.map(c => {
                const status = c.uw_status || c.status || '';
                const statusLabel = status === 'SIGNED' ? ' ✓ Signed' : status === 'NTU' ? ' NTU' : status === 'DRAFT' ? ' Draft' : status ? ` ${status}` : '';
                const type = c.treaty_type_name || c.treaty_type || '';
                const desc = c.contract_description ? ` — ${c.contract_description}` : '';
                return <option key={c.id||c.contract_id} value={c.id||c.contract_id}>
                  {c.uw_year || '—'} · {type}{desc}{statusLabel}
                </option>;
              })}
            </select></div></div>
          <div className="renew-note"><div className="renew-note-title">What happens next?</div><div className="renew-note-text">A new <b>DRAFT</b> is created for the next underwriting year. Limits/structures/profiles are copied, while loss history &amp; pricing are reset for fresh analysis.</div></div>
          <div className="renew-actions"><button className="renew-btn renew-btn--ghost" onClick={safeClose} disabled={busy}>Cancel</button><button className="renew-btn renew-btn--primary" disabled={!selContract || busy} onClick={doRenew}>{busy ? 'Working...' : 'Create Renewal Draft'}</button></div>
        </div>
      </div>
    </div>
  );
}

/* ── Renewal Confirmation Modal (Upcoming Renewals panel click) ── */
function RenewalConfirmModal({ candidate, busy, error, onConfirm, onCancel }) {
  // Escape key closes when not busy. Hook is called unconditionally so the
  // listener subscription tracks the open/closed transition cleanly.
  useEscapeKey(!!candidate && !busy, onCancel);
  if (!candidate) return null;
  const renewalDate = candidate.renewalDate
    ? formatDate(candidate.renewalDate)
    : '—';
  return (
    <div className="renew-modal is-ready">
      {/* Backdrop dismissal is a pointer-only convenience; keyboard users
          close via Escape (useEscapeKey above) or the labelled ✕ button. */}
      <div className="renew-backdrop" role="presentation" onClick={busy ? undefined : onCancel} />
      <div className="renew-panel glass" role="dialog" aria-modal="true" style={{ maxWidth: 460 }}>
        <div className="renew-head">
          <div>
            <div className="renew-kicker">RENEW TREATY</div>
            <div className="renew-title">Do you want to renew this treaty?</div>
          </div>
          <button className="renew-x" onClick={onCancel} aria-label="Close" disabled={busy}>✕</button>
        </div>
        <div className="renew-body">
          {error && <div className="renew-alert">{error}</div>}
          <div className="renew-field" style={{ display: 'block' }}>
            <div style={{ fontSize: 11, color: '#cbd5e1', marginBottom: 4 }}>
              {candidate.country || '—'} · {candidate.uwYear || '—'}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#f8fafc' }}>
              {candidate.cedantName || 'Untitled'}
            </div>
            <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 2 }}>
              {candidate.treatyType || '—'} · COB: {candidate.cob || '—'}
            </div>
            <div style={{ fontSize: 12, color: '#fbbf24', marginTop: 6 }}>
              Renewal date: {renewalDate}
            </div>
          </div>
          <div className="renew-note">
            <div className="renew-note-title">What happens next?</div>
            <div className="renew-note-text">A new <b>DRAFT</b> is created for the next underwriting year. Limits/structures/profiles are copied; loss history &amp; pricing are reset for fresh analysis.</div>
          </div>
          <div className="renew-actions">
            <button className="renew-btn renew-btn--ghost" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="renew-btn renew-btn--primary" disabled={busy} onClick={onConfirm}>
              {busy ? 'Working...' : 'Yes, Renew'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════ MAIN SCREEN ══════════════════════ */
export default function HomeScreen() {
  const navigate = useNavigate();
  const { resetFlow } = useAppState();
  const session = getSession();
  const myLevel  = session?.hierarchyLevel || 5;
  // Treaty scope is driven by the per-user "View treaties" preference in
  // Settings (Topbar), not a control on this screen. viewAll=true → everyone's
  // treaties (scope='all', non-owned rows render read-only); false → mine.
  const [viewAll] = useViewAllTreaties();
  const scope = viewAll ? 'all' : 'mine';

  const [data, setData] = useState({ drafts: [], submitted: [], renewals: [], quotes: [], region_premiums: [], stats: {} });
  const [loading, setLoading] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  // Ref so load() can check for existing data without needing data in its dep array
  const dataRef = React.useRef({ drafts: [], submitted: [], renewals: [], quotes: [], region_premiums: [], stats: {} });
  // Token bumped on every load() call. The async handler aborts if the token
  // moves before its response lands — prevents a slow reply from clobbering
  // a fresher one (e.g. user toggles viewingUser mid-flight).
  const loadToken = React.useRef(0);
  const [showRenewal, setShowRenewal] = useState(false);
  // Upcoming-renewals click → confirm-and-renew flow
  const [renewalCandidate, setRenewalCandidate] = useState(null);
  const [renewBusy, setRenewBusy] = useState(false);
  const [renewError, setRenewError] = useState('');
  const [packBusy, setPackBusy] = useState(false);
  const [showReinsurerAnalysis, setShowReinsurerAnalysis] = useState(false);
  // Profile viewer state
  const viewingUser = useViewingUser(); // synced from Topbar dropdown
  const [allocMsg, setAllocMsg]     = useState('');
  // Cancel any pending alloc-message timeout on unmount (or when a new
  // message is shown). Without this, a clicked allocation that resolves
  // after the user navigates away would call setState on an unmounted tree.
  const allocMsgTimer = useRef(null);
  const showAllocMsg = useCallback((msg) => {
    setAllocMsg(msg);
    if (allocMsgTimer.current) clearTimeout(allocMsgTimer.current);
    allocMsgTimer.current = setTimeout(() => setAllocMsg(''), 4000);
  }, []);
  useEffect(() => () => { if (allocMsgTimer.current) clearTimeout(allocMsgTimer.current); }, []);

  const load = useCallback(async (forUserId = null, quiet = false) => {
    // Only show full spinner when there is genuinely no data yet (true first load).
    // Uses a ref so this check never forces load() to be recreated on every data change.
    const cur = dataRef.current;
    const hasData = (cur.drafts?.length ?? 0) > 0
                 || (cur.submitted?.length ?? 0) > 0
                 || (cur.renewals?.length ?? 0) > 0
                 || (cur.quotes?.length ?? 0) > 0;
    if (!hasData && !quiet) setLoading(true);
    setBackgroundRefreshing(true);
    const myToken = ++loadToken.current;
    try {
      const raw = forUserId
        ? await api.getHomeSummaryFor(forUserId)
        : await api.getHomeSummary({ scope });
      // A newer load has been kicked off while we awaited — drop this reply.
      if (myToken !== loadToken.current) return;
      const next = {
        drafts:    (raw?.drafts    || []).map(r => normalizeRow(r)),
        submitted: (raw?.submitted || []).map(r => normalizeRow(r)),
        renewals:  (raw?.renewals  || []).map(r => normalizeRow(r)),
        quotes:    (raw?.quotes    || []).map(r => normalizeRow(r, 'QUOTE')),
        region_premiums: raw?.region_premiums || [],
        stats: raw?.stats || {},
      };
      // startTransition: tells React this update is non-urgent — browser
      // can paint the current frame first, preventing layout thrash
      dataRef.current = next;
      React.startTransition(() => setData(next));
    } catch (e) {
      if (myToken === loadToken.current) console.warn('Home load:', e);
    } finally {
      if (myToken === loadToken.current) {
        setLoading(false);
        setBackgroundRefreshing(false);
      }
    }
  }, [scope]); // dataRef + loadToken are refs; normalizeRow is module-level



  useEffect(() => {
    load(viewingUser?.user_id || null);
    // Pause the 60s background poll while the tab is hidden — no point
    // hammering the API for a screen the user can't see, and the load on
    // visibility change below catches them up the moment they return.
    const tick = () => { if (!document.hidden) load(viewingUser?.user_id || null, true); };
    const iv = setInterval(tick, 60000);
    const onVisible = () => { if (!document.hidden) load(viewingUser?.user_id || null, true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, viewingUser]);

  const doAllocate = async (item) => {
    try {
      const fn = item.isQuote ? api.allocateQuote : api.allocateContract;
      await fn(item.id, `Allocated from ${viewingUser?.role_name || 'team member'}`);
      showAllocMsg(`✓ ${item.cedantName} allocated to you`);
      load(viewingUser?.user_id || null);
    } catch (e) {
      showAllocMsg(`✗ ${e.message || 'Could not allocate'}`);
    }
  };

  const st = data.stats;
  const pendingCount = Number(st.waiting_approval || 0);

  const startNew = (mode) => { resetFlow({ quote: false, mode }); clearActiveContractId(); navigate(mode === 'NP' ? '/np/treaty-detail' : '/prop/treaty-detail'); };
  const startQuote = () => { resetFlow({ quote: true, mode: 'NP' }); clearActiveContractId(); navigate('/np/treaty-detail'); };
  const openItem = (item) => {
    const isNp = item.isQuote || isNpType(item.treatyType, item.treatyCategory);
    // Set localStorage BEFORE resetFlow to avoid race with React state batching
    if (item.isQuote) setActiveQuoteId(item.id);
    else              setActiveContractId(item.id);
    resetFlow({ quote: item.isQuote, mode: isNp ? 'NP' : 'PROP' });
    // Submitted/approved/signed quotes should open at final pricing, not treaty detail
    const ADVANCED_STATUSES = ['AWAITING_APPROVAL','AWAITING_SIGNED_LINE','SIGNED','NTU','DECLINED','APPROVED'];
    const itemStatus = String(item.status || '').toUpperCase();
    const isAdvanced = ADVANCED_STATUSES.includes(itemStatus);
    if (item.isQuote && isAdvanced) {
      navigate('/np/final-quote', { state: { contractId: item.id } });
    } else if (isAdvanced) {
      // Contract past approval (e.g. AWAITING_SIGNED_LINE) → go straight to the
      // pricing screen where the Sign/NTU offer modal auto-opens. Mirrors the
      // ApprovalsScreen open() routing.
      navigate(isNp ? '/np/final-pricing' : '/prop/pricing', { state: { contractId: item.id } });
    } else {
      navigate(isNp ? '/np/treaty-detail' : '/prop/treaty-detail', { state: { contractId: item.id } });
    }
  };
  const handleRenewalDone = (newId, isNp) => {
    setActiveContractId(newId);
    resetFlow({ quote: false, mode: isNp ? 'NP' : 'PROP' });
    // Preserve viewing-other context — otherwise the cached `data` quietly
    // flips to "your own" home for the next visit to this screen.
    load(viewingUser?.user_id || null);
    navigate(isNp ? '/np/treaty-detail' : '/prop/treaty-detail', { state: { contractId: newId } });
  };
  const confirmRenewalCandidate = async () => {
    if (!renewalCandidate) return;
    setRenewBusy(true); setRenewError('');
    try {
      const res = await api.renewContract(renewalCandidate.id);
      if (!res?.id) throw new Error('No ID returned');
      setRenewalCandidate(null);
      handleRenewalDone(res.id, res.is_np);
    } catch (e) {
      setRenewError('Renewal failed: ' + (e?.message || 'Unknown error'));
    } finally {
      setRenewBusy(false);
    }
  };
  const cancelRenewalCandidate = () => {
    if (renewBusy) return;
    setRenewalCandidate(null);
    setRenewError('');
  };
  // Reset any stale error from a previous failed attempt so the new
  // candidate doesn't open with someone else's red banner.
  const openRenewalCandidate = useCallback((item) => {
    setRenewError('');
    setRenewalCandidate(item);
  }, []);

  const regions = useMemo(() => {
    const REGION_BUDGET = 100; // $100M budget per region
    const REGION_ORDER = ['Middle East', 'Africa', 'Asia', 'Europe', 'Americas'];
    const rows = data?.region_premiums || [];
    return REGION_ORDER.map(name => {
      const row = rows.find(r => r.region_bucket === name);
      const actual = row ? Math.round(Number(row.total_epi) / 1e6) : 0;
      return { name, actual, target: REGION_BUDGET };
    });
  }, [data?.region_premiums]);

  const downloadRenewalPack = async () => {
    if (packBusy) return;
    setPackBusy(true);
    try {
      const blob = await api.getRenewalPackBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `renewal-pack-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Renewal pack export failed: ' + (e?.message || 'Server error'));
    } finally {
      setPackBusy(false);
    }
  };

  return (
    <div className="app-shell grid-bg HOME_PAGE">
      <Topbar title="MODELLING TOOL" subtitle="Reinsurance treaty pricing & modelling workspace" actions={<>
        <button className="topbar-pill" onClick={() => navigate('/dashboard')}>Dashboard</button>
        <button className="topbar-pill" onClick={() => setShowReinsurerAnalysis(true)}>Reinsurer Analysis</button>
        <button className="topbar-pill" onClick={downloadRenewalPack} disabled={packBusy}>
          {packBusy ? 'Building…' : 'Renewal Pack'}
        </button>
        <button className="topbar-pill" onClick={() => navigate('/benchmark')}>⚡ Quick Benchmark</button>
        <button className="topbar-pill" onClick={() => navigate('/workbench')}>Workbench</button>
        <button className="topbar-pill" onClick={() => {
          exportPortfolioToExcel().catch(e => console.error('Portfolio export failed:', e));
        }}>↓ Export Portfolio</button>
        {canAccessApprovals() && pendingCount > 0 && <button className="topbar-pill" onClick={() => navigate('/approvals')}>Approvals ({pendingCount})</button>}
      </>} />
      <main className="workspace"><div className="container container--full">
        {viewingUser && (
          <div style={{ padding:'8px 14px', borderRadius:10, background:'rgba(96,165,250,0.08)', border:'1px solid rgba(96,165,250,0.25)', marginBottom:12, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
            <span style={{ fontSize:12, color:'rgba(255,255,255,0.70)' }}>
              Viewing <strong style={{ color:'#60a5fa' }}>{viewingUser.role_name}</strong>'s work
            </span>
            {allocMsg && <span style={{ fontSize:12, fontWeight:700, color: allocMsg.startsWith('✓')?'#4ade80':'#f87171' }}>{allocMsg}</span>}
            <span style={{ fontSize:10, color:'rgba(255,255,255,0.35)', marginLeft:'auto' }}>
              {viewingUser.hierarchy_level >= myLevel ? '✓ You can allocate DRAFT items from this user' : '— View only (they outrank you)'}
            </span>
            <button onClick={() => { setViewingUser(null); setAllocMsg(''); }} style={{ marginLeft:'auto', fontSize:10, color:'rgba(255,255,255,0.40)', background:'none', border:'none', cursor:'pointer', padding:'2px 6px' }}>✕ Back to my work</button>
          </div>
        )}

        <div className="crumb glass">
          <span className="dot" style={backgroundRefreshing ? { background: '#23d18b', boxShadow: '0 0 6px #23d18b' } : {}} />
          <span className="crumb-text">{viewingUser ? `VIEWING: ${(viewingUser.role_name || '').toUpperCase()}` : 'WORKSPACE: HOME PAGE'}</span>
          {backgroundRefreshing && <span style={{ fontSize: 9, color: 'rgba(35,209,139,0.6)', marginLeft: 6, letterSpacing: '.06em' }}>SYNCING</span>}
        </div>
        <section className="hero glass">
          <div className="hero-top"><div className="welcome-row"><span className="welcome-pill">WELCOME</span><h1 className="welcome-title">{getUserDisplayName() || 'Underwriter'}</h1></div>
            <div className="welcome-sub">This is your modelling workspace hub. Model a new treaty, renew a treaty and quote treaties.</div></div>
          <div className="hero-actions">
            <button className="action-pill action-pill--primary" onClick={() => startNew('PROP')}><span className="plus">+</span> Assess Proportional Treaty</button>
            <button className="action-pill action-pill--primary" onClick={() => startNew('NP')}><span className="plus">+</span> Assess Non-Proportional Treaty</button>
            <button className="action-pill action-pill--primary" onClick={() => setShowRenewal(true)}><span className="plus">+</span> Renew Treaty <span style={{ marginLeft: 8, fontSize: 9, background: 'rgba(255,255,255,0.2)', padding: '2px 6px', borderRadius: 4 }}>NEW</span></button>
            <button className="action-pill action-pill--primary" onClick={startQuote}><span className="plus">+</span> Quote Treaty</button>
          </div>
        </section>
        <div className="dash-grid dash-grid--home">
          <section className="panel glass panel-equal" data-section="overview">
            <div className="panel-head"><div className="panel-title">MODELLING OVERVIEW</div><div className="pill-mini">LIVE TREATY METRICS</div></div>
            <div className="cards-3x3">
              <StatCard label="TREATIES MODELLED" value={st.total || 0} sub="All treaties" />
              <StatCard label="WAITING FOR APPROVAL" value={st.waiting_approval || 0} sub="Chief UW review" />
              <StatCard label="WAITING FOR SIGNED LINE" value={st.waiting_signed_line || 0} sub="Pending market response" />
              <StatCard label="SIGNED" value={st.signed || 0} sub="Complete" />
              <StatCard label="NTU" value={st.ntu || 0} sub="Not Taken Up" />
              <StatCard label="DECLINED" value={st.declined || 0} sub="Declined" />
              <StatCard label="DRAFTS" value={st.drafts || 0} sub="Work in progress" />
              <StatCard label="QUOTES" value={data.quotes.length} sub="All quotes" />
              <StatCard label="UPCOMING RENEWALS" value={data.renewals.length} sub="Next 60 days" />
            </div>
            <div className="divider" />
            <div className="region-head"><div className="region-title">PREMIUM BY REGION</div><div className="region-mini">ACTUAL / TARGET</div></div>
            <div className="region-row">{regions.map(r => <RegionBar key={r.name} {...r} />)}</div>
          </section>
          <div className="panel-col">
            {scope === 'all' ? (
              <EveryonePanel onOpen={openItem} />
            ) : (
              <>
                <FilteredPanel title={viewingUser ? `${(viewingUser.role_name || 'USER').toUpperCase()} DRAFTS` : "MY DRAFT TREATIES"} badge="WORK IN PROGRESS" items={data.drafts}
                  loading={loading} emptyMsg={viewingUser ? "No drafts." : "No drafts. Click + to start."} onOpen={openItem}
                  onAllocate={doAllocate} canAllocate={viewingUser && viewingUser.hierarchy_level >= myLevel} viewingOther={!!viewingUser} />

                <FilteredPanel title={viewingUser ? `${(viewingUser.role_name || 'USER').toUpperCase()} QUOTES` : "MY QUOTES"} badge="IN PROGRESS" items={data.quotes}
                  loading={loading} emptyMsg="No quotes." onOpen={openItem}
                  onAllocate={doAllocate} canAllocate={viewingUser && viewingUser.hierarchy_level >= myLevel} viewingOther={!!viewingUser} />

                <FilteredPanel title="UPCOMING RENEWALS" badge="NEXT 60 DAYS" items={data.renewals}
                  loading={loading} emptyMsg="No renewals due." onOpen={openRenewalCandidate} viewingOther={!!viewingUser} />

                <FilteredPanel title={viewingUser ? `${(viewingUser.role_name || 'USER').toUpperCase()} HISTORY` : "SUBMITTED & HISTORY"} badge="WAITING / SIGNED / NTU / DECLINED" items={data.submitted}
                  loading={loading} emptyMsg="No submitted treaties yet." onOpen={openItem} viewingOther={!!viewingUser} />
              </>
            )}
          </div>
        </div>
      </div></main>
      <RenewalModal open={showRenewal} onClose={() => setShowRenewal(false)} onRenew={handleRenewalDone} />
      <ReinsurerAnalysisModal open={showReinsurerAnalysis} onClose={() => setShowReinsurerAnalysis(false)} />
      <RenewalConfirmModal
        candidate={renewalCandidate}
        busy={renewBusy}
        error={renewError}
        onConfirm={confirmRenewalCandidate}
        onCancel={cancelRenewalCandidate}
      />
    </div>
  );
}
