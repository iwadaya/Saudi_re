// src/screens/facultative/home/FacHomeScreen.jsx
// The facultative home page — the fac twin of home/HomeScreen.jsx. Same
// layout and styling (Topbar, hero action pills, 3×3 modelling-overview
// stat grid, premium-by-region bars, filtered work panels, renew modal),
// fed by /api/fac/home-summary and swapped to fac semantics: risks not
// treaties, Proportional/XL fac placements, fac statuses, expiry-driven
// renewals. This is where "Open Facultative" from the module select lands.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../../api';
import { getUserDisplayName } from '../../../utils/auth';
import { formatDate } from '../../../utils/format';
import Topbar from '../../../components/Topbar';
import { logger } from '../../../utils/logger';
import { setActiveFacRiskId } from '../../../hooks/useContractId';
import ProfitabilityInsightsModal from '../../insights/ProfitabilityInsightsModal';

/* ── fac status presentation ── */
const STATUS_LABELS = {
  DRAFT: 'Draft', QUOTED: 'Quoted', REFERRED: 'Referred', BOUND: 'Bound',
  DECLINED: 'Declined', NTU: 'NTU', CANCELLED: 'Cancelled', RENEWED: 'Renewed',
};
function statusClass(key) {
  if (key === 'BOUND' || key === 'RENEWED') return 'status-quoted';
  if (key === 'DECLINED' || key === 'CANCELLED') return 'status-declined';
  if (key === 'NTU') return 'status-offered';
  if (key === 'QUOTED' || key === 'REFERRED') return 'status-pending';
  return '';
}

// Pure row-normaliser for /fac/home-summary rows (module scope — no closure deps).
function normalizeRow(r) {
  const status = String(r?.status || 'DRAFT').toUpperCase();
  return {
    id: r.id, insuredName: r.insured_name || 'Unnamed risk',
    cedantName: r.cedant_name || '–', country: r.country || '',
    facType: r.placement_type === 'NON_PROPORTIONAL' ? 'XL FAC' : 'Proportional FAC',
    status, statusLabel: STATUS_LABELS[status] || status,
    broker: r.broker || '–', cob: r.cob || '–',
    updatedAt: r.updated_at, expiryDate: r.expiry_date, uwYear: r.uw_year,
    facRef: r.fac_ref || null,
    isRenewal: /renewal/i.test(String(r.renewal_or_new || '')),
  };
}

// Compact money for a stat card: 2_000_000 → "2.0M" (USD, our share).
function fmtShortMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '–';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

// Close the modal on Escape — same a11y convention as the treaty home.
function useEscapeKey(enabled, onEscape) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onEscape(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onEscape]);
}

/* ── Shared sub-components (mirroring the treaty home) ── */
function StatCard({ label, value, sub }) {
  return (<div className="stat-card"><div className="stat-label">{label}</div><div className="stat-value">{value ?? '–'}</div>{sub && <div className="stat-sub">{sub}</div>}</div>);
}
function RegionBar({ name, actual, target }) {
  const pct = target > 0 ? Math.min(100, (actual / target) * 100) : 0;
  const endColor = pct >= 100 ? '#4ade80' : pct >= 75 ? '#00d4ff' : pct >= 50 ? '#a78bfa' : '#6366f1';
  const achievedColor = pct >= 100 ? 'var(--accent)' : pct >= 75 ? 'var(--accent-blue)' : 'var(--muted)';
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

function RiskRow({ item, onOpen, onDelete }) {
  return (
    <div className="draft-row" style={{ cursor: 'default' }}>
      <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
        role="button" tabIndex={0}
        onClick={() => onOpen(item)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item); }
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div className="draft-title" style={{ color: 'var(--text)', fontWeight: 600 }}>{item.insuredName}</div>
          {item.facRef && (
            <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 10, background: 'rgba(var(--accent-blue-rgb),0.12)', border: '1px solid rgba(var(--accent-blue-rgb),0.30)', color: 'var(--accent-blue)', fontWeight: 700, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
              {item.facRef}
            </span>
          )}
        </div>
        <div className="draft-sub" style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 2 }}>
          {item.country ? `${item.country} · ` : ''}{item.uwYear ? `${item.uwYear} · ` : ''}Cedant: {item.cedantName} · Class: {item.cob}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <div className={`draft-meta ${statusClass(item.status)}`}>
            {item.statusLabel} · {item.facType} · {item.expiryDate ? `Expires ${formatDate(item.expiryDate)}` : item.updatedAt ? formatDate(item.updatedAt) : 'New'}
          </div>
          {item.isRenewal && (
            <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 10, background: 'rgba(var(--accent-blue-rgb),0.12)', border: '1px solid rgba(var(--accent-blue-rgb),0.30)', color: 'var(--accent-blue)', fontWeight: 700, whiteSpace: 'nowrap' }}>
              🔄 Renewal
            </span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
        {onDelete && item.status === 'DRAFT' && (
          <button type="button" className="btn-bare" title="Delete draft" aria-label="Delete draft"
            onClick={(e) => { e.stopPropagation(); onDelete(item); }}
            style={{ color: 'rgba(var(--accent-rose-rgb),0.55)', fontSize: 13 }}>✕</button>
        )}
        <button type="button" className="draft-open btn-bare" onClick={() => onOpen(item)}>Open →</button>
      </div>
    </div>
  );
}

/* ── Filter Bar ── */
function FilterBar({ countries, cedants, countryFilter, cedantFilter, onCountryChange, onCedantChange }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--hairline)', flexWrap: 'wrap' }}>
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
function FilteredPanel({ title, badge, items, loading, emptyMsg, onOpen, badgeStyle, onDelete }) {
  const [countryFilter, setCountryFilter] = useState('');
  const [cedantFilter, setCedantFilter] = useState('');

  const panelCountries = useMemo(() => [...new Set(items.map(i => i.country).filter(Boolean))].sort(), [items]);
  const panelCedants = useMemo(() => {
    let list = items;
    if (countryFilter) list = list.filter(i => i.country === countryFilter);
    return [...new Set(list.map(i => i.cedantName).filter(c => c && c !== '–'))].sort();
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
            <span style={{ fontSize: 10, color: 'var(--accent-amber)', marginRight: 4 }}>{filtered.length}/{items.length}</span>
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
            : filtered.map(d => <RiskRow key={d.id} item={d} onOpen={onOpen} onDelete={onDelete} />)}
      </div>
    </section>
  );
}

/* ── Renew Fac Risk Modal — pick a bound risk to renew ── */
function FacRenewModal({ open, onClose, boundRisks, onRenew }) {
  useEscapeKey(open, onClose);
  if (!open) return null;
  return (
    <div className="renew-modal is-ready">
      {/* Backdrop dismissal is a pointer-only convenience; keyboard users
          close via Escape (useEscapeKey above) or the labelled ✕ button. */}
      <div className="renew-backdrop" role="presentation" onClick={onClose} />
      <div className="renew-panel glass" role="dialog" aria-modal="true">
        <div className="renew-head"><div><div className="renew-kicker">RENEWAL</div><div className="renew-title">Renew Fac Risk</div></div><button className="renew-x" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="renew-body">
          <div className="renew-field" style={{ display: 'block' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>Select a bound risk to renew</div>
            {boundRisks.length === 0
              ? <div className="muted" style={{ padding: 12 }}>No bound risks available to renew.</div>
              : boundRisks.map(r => (
                <button type="button" key={r.id} className="btn-bare" onClick={() => onRenew(r)}
                  style={{ display: 'block', width: '100%', padding: '10px 14px', borderRadius: 10, marginBottom: 6, border: '1px solid var(--hairline)', background: 'var(--surface-2)' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)' }}>{r.facRef || '—'}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>{r.insuredName}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    {r.cob} · {r.country || '—'} · {r.facType}{r.expiryDate ? ` · Expires ${formatDate(r.expiryDate)}` : ''}
                  </div>
                </button>
              ))}
          </div>
          <div className="renew-note"><div className="renew-note-title">What happens next?</div><div className="renew-note-text">The bound risk opens as a <b>renewal quote</b> — mark it as a Renewal on the Risk Detail screen and set the expiring reference so the renewal comparison can find its predecessor.</div></div>
          <div className="renew-actions"><button className="renew-btn renew-btn--ghost" onClick={onClose}>Cancel</button></div>
        </div>
      </div>
    </div>
  );
}

/* ── Renewal confirmation (Upcoming Renewals panel click) ── */
function FacRenewConfirmModal({ candidate, onConfirm, onCancel }) {
  useEscapeKey(!!candidate, onCancel);
  if (!candidate) return null;
  return (
    <div className="renew-modal is-ready">
      <div className="renew-backdrop" role="presentation" onClick={onCancel} />
      <div className="renew-panel glass" role="dialog" aria-modal="true" style={{ maxWidth: 460 }}>
        <div className="renew-head">
          <div>
            <div className="renew-kicker">RENEW FAC RISK</div>
            <div className="renew-title">Do you want to renew this risk?</div>
          </div>
          <button className="renew-x" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="renew-body">
          <div className="renew-field" style={{ display: 'block' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
              {candidate.country || '—'} · {candidate.uwYear || '—'}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
              {candidate.insuredName}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {candidate.facType} · Class: {candidate.cob} · Cedant: {candidate.cedantName}
            </div>
            <div style={{ fontSize: 12, color: 'var(--accent-amber)', marginTop: 6 }}>
              Expiry date: {candidate.expiryDate ? formatDate(candidate.expiryDate) : '—'}
            </div>
          </div>
          <div className="renew-note">
            <div className="renew-note-title">What happens next?</div>
            <div className="renew-note-text">The bound risk opens as a <b>renewal quote</b> — mark it as a Renewal and set the expiring reference on the Risk Detail screen.</div>
          </div>
          <div className="renew-actions">
            <button className="renew-btn renew-btn--ghost" onClick={onCancel}>Cancel</button>
            <button className="renew-btn renew-btn--primary" onClick={onConfirm}>Yes, Renew</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════ MAIN SCREEN ══════════════════════ */
export default function FacHomeScreen() {
  const navigate = useNavigate();

  const [data, setData] = useState({ drafts: [], quotes: [], renewals: [], submitted: [], region_premiums: [], stats: {} });
  const [loading, setLoading] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const dataRef = useRef(data);
  // Token bumped on every load() call — a slow reply can never clobber a
  // fresher one (same guard as the treaty home).
  const loadToken = useRef(0);
  const [showRenewal, setShowRenewal] = useState(false);
  const [renewalCandidate, setRenewalCandidate] = useState(null);
  const [showInsights, setShowInsights] = useState(false);

  const load = useCallback(async (quiet = false) => {
    const cur = dataRef.current;
    const hasData = (cur.drafts?.length ?? 0) > 0
                 || (cur.quotes?.length ?? 0) > 0
                 || (cur.renewals?.length ?? 0) > 0
                 || (cur.submitted?.length ?? 0) > 0;
    if (!hasData && !quiet) setLoading(true);
    setBackgroundRefreshing(true);
    const myToken = ++loadToken.current;
    try {
      const raw = await api.facHomeSummary();
      if (myToken !== loadToken.current) return;
      const next = {
        drafts:    (raw?.drafts    || []).map(normalizeRow),
        quotes:    (raw?.quotes    || []).map(normalizeRow),
        renewals:  (raw?.renewals  || []).map(normalizeRow),
        submitted: (raw?.submitted || []).map(normalizeRow),
        region_premiums: raw?.region_premiums || [],
        stats: raw?.stats || {},
      };
      dataRef.current = next;
      React.startTransition(() => setData(next));
    } catch (e) {
      if (myToken === loadToken.current) logger.warn('Fac home load:', e);
    } finally {
      if (myToken === loadToken.current) {
        setLoading(false);
        setBackgroundRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    load();
    // Pause the 60s background poll while the tab is hidden, catch up on return.
    const tick = () => { if (!document.hidden) load(true); };
    const iv = setInterval(tick, 60000);
    const onVisible = () => { if (!document.hidden) load(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const st = data.stats;

  const startNew = async (placementType, isQuote = false) => {
    try {
      const risk = await api.facCreateRisk({
        insured_name: 'New Risk',
        placement_type: placementType,
        status: 'DRAFT',
      });
      setActiveFacRiskId(risk.fac_risk_id, { quote: isQuote });
      navigate('/fac/risk/detail', { state: { facRiskId: risk.fac_risk_id } });
    } catch (e) {
      logger.error('Create fac risk error:', e);
    }
  };

  const openItem = (item) => {
    setActiveFacRiskId(item.id);
    navigate('/fac/risk/detail', { state: { facRiskId: item.id } });
  };

  // Renewing opens the bound risk in quote mode (the Risk Detail screen's
  // renewal flow takes it from there) — same behaviour the old fac home had.
  const handleRenew = (item) => {
    setActiveFacRiskId(item.id, { quote: true });
    navigate('/fac/risk/detail', { state: { facRiskId: item.id } });
  };

  const deleteDraft = async (item) => {
    if (!confirm(`Delete ${item.facRef || 'this draft'}?`)) return;
    try { await api.facDeleteRisk(item.id); load(true); } catch (err) { logger.error(err); }
  };

  // Bound risks for the renew picker: the upcoming-renewals window plus any
  // other bound risks from the history list, de-duplicated.
  const boundRisks = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const r of [...data.renewals, ...data.submitted]) {
      if (r.status !== 'BOUND' || seen.has(r.id)) continue;
      seen.add(r.id); out.push(r);
    }
    return out;
  }, [data.renewals, data.submitted]);

  const regions = useMemo(() => {
    const REGION_BUDGET = 10; // $10M fac budget per region — smaller book than treaty
    const REGION_ORDER = ['Middle East', 'Africa', 'Asia', 'Europe', 'Americas'];
    const rows = data?.region_premiums || [];
    return REGION_ORDER.map(name => {
      const row = rows.find(r => r.region_bucket === name);
      const actual = row ? +(Number(row.total_epi) / 1e6).toFixed(1) : 0;
      return { name, actual, target: REGION_BUDGET };
    });
  }, [data?.region_premiums]);

  return (
    <div className="app-shell grid-bg HOME_PAGE">
      <Topbar title="MODELLING TOOL" subtitle="Facultative risk pricing & modelling workspace" actions={<>
        <button className="topbar-pill" onClick={() => navigate('/fac/dashboard')}>Dashboard</button>
        <button className="topbar-pill" onClick={() => setShowInsights(true)}>Portfolio Intelligence</button>
        <button className="topbar-pill" onClick={() => navigate('/select')}>← Switch Product</button>
      </>} />
      <main className="workspace"><div className="container container--full">
        <div className="crumb glass">
          <span className="dot" style={backgroundRefreshing ? { background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)' } : {}} />
          <span className="crumb-text">WORKSPACE: FACULTATIVE HOME</span>
          {backgroundRefreshing && <span style={{ fontSize: 9, color: 'rgba(var(--accent-rgb),0.75)', marginLeft: 6, letterSpacing: '.06em' }}>SYNCING</span>}
        </div>
        <section className="hero glass">
          <div className="hero-top"><div className="welcome-row"><span className="welcome-pill">WELCOME</span><h1 className="welcome-title">{getUserDisplayName() || 'Underwriter'}</h1></div>
            <div className="welcome-sub">This is your facultative workspace hub. Price a new fac risk, renew a risk and quote fac risks.</div></div>
          <div className="hero-actions">
            <button className="action-pill action-pill--primary" onClick={() => startNew('PROPORTIONAL')}><span className="plus">+</span> Assess Proportional Fac Risk</button>
            <button className="action-pill action-pill--primary" onClick={() => startNew('NON_PROPORTIONAL')}><span className="plus">+</span> Assess XL Fac Risk</button>
            <button className="action-pill action-pill--primary" onClick={() => setShowRenewal(true)}><span className="plus">+</span> Renew Fac Risk</button>
            <button className="action-pill action-pill--primary" onClick={() => startNew('PROPORTIONAL', true)}><span className="plus">+</span> Quote Fac Risk</button>
          </div>
        </section>
        <div className="dash-grid dash-grid--home">
          <section className="panel glass panel-equal" data-section="overview">
            <div className="panel-head"><div className="panel-title">MODELLING OVERVIEW</div><div className="pill-mini">LIVE FAC RISK METRICS</div></div>
            <div className="cards-3x3">
              <StatCard label="RISKS MODELLED" value={st.total || 0} sub="All fac risks" />
              <StatCard label="QUOTED" value={st.quoted || 0} sub="Quoted to cedant" />
              <StatCard label="REFERRED" value={st.referred || 0} sub="Referred for review" />
              <StatCard label="BOUND" value={st.bound || 0} sub="On risk" />
              <StatCard label="NTU" value={st.ntu || 0} sub="Not Taken Up" />
              <StatCard label="DECLINED" value={st.declined || 0} sub="Declined" />
              <StatCard label="DRAFTS" value={st.drafts || 0} sub="Work in progress" />
              <StatCard label="BOUND PREMIUM" value={fmtShortMoney(st.bound_premium || 0)} sub="Our share · USD" />
              <StatCard label="UPCOMING RENEWALS" value={data.renewals.length} sub="Next 60 days" />
            </div>
            <div className="divider" />
            <div className="region-head"><div className="region-title">PREMIUM BY REGION</div><div className="region-mini">ACTUAL / TARGET</div></div>
            <div className="region-row">{regions.map(r => <RegionBar key={r.name} {...r} />)}</div>
          </section>
          <div className="panel-col">
            <FilteredPanel title="DRAFT FAC RISKS" badge="WORK IN PROGRESS" items={data.drafts}
              loading={loading} emptyMsg="No drafts. Click + to start." onOpen={openItem} onDelete={deleteDraft} />

            <FilteredPanel title="FAC QUOTES" badge="QUOTED / REFERRED" items={data.quotes}
              loading={loading} emptyMsg="No quotes in progress." onOpen={openItem} />

            <FilteredPanel title="UPCOMING RENEWALS" badge="NEXT 60 DAYS" items={data.renewals}
              loading={loading} emptyMsg="No renewals due." onOpen={setRenewalCandidate} />

            <FilteredPanel title="SUBMITTED & HISTORY" badge="BOUND / NTU / DECLINED" items={data.submitted}
              loading={loading} emptyMsg="No submitted risks yet." onOpen={openItem} />
          </div>
        </div>
      </div></main>
      <FacRenewModal open={showRenewal} onClose={() => setShowRenewal(false)} boundRisks={boundRisks}
        onRenew={(r) => { setShowRenewal(false); handleRenew(r); }} />
      <FacRenewConfirmModal candidate={renewalCandidate}
        onConfirm={() => { const c = renewalCandidate; setRenewalCandidate(null); if (c) handleRenew(c); }}
        onCancel={() => setRenewalCandidate(null)} />
      <ProfitabilityInsightsModal open={showInsights} onClose={() => setShowInsights(false)} scope="fac" />
    </div>
  );
}
