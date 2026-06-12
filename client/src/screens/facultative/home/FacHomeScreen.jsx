// src/screens/facultative/home/FacHomeScreen.jsx
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUserDisplayName } from '../../../utils/auth';
import api from '../../../api';
import { setActiveFacRiskId } from '../../../hooks/useContractId';

const STATUS_COLORS = {
  DRAFT:    { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.25)', color: 'rgba(148,163,184,0.80)' },
  QUOTED:   { bg: 'rgba(0,212,255,0.10)',   border: 'rgba(0,212,255,0.28)',   color: '#00d4ff' },
  BOUND:    { bg: 'rgba(35,209,139,0.10)',  border: 'rgba(35,209,139,0.28)',  color: '#23d18b' },
  DECLINED: { bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.28)', color: '#f87171' },
  REFERRED: { bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.28)',  color: '#fbbf24' },
  NTU:      { bg: 'rgba(168,85,247,0.10)',  border: 'rgba(168,85,247,0.28)',  color: '#a855f7' },
  RENEWED:  { bg: 'rgba(59,130,246,0.10)',  border: 'rgba(59,130,246,0.28)',  color: '#3b82f6' },
  CANCELLED:{ bg: 'rgba(107,114,128,0.10)', border: 'rgba(107,114,128,0.28)', color: '#6b7280' },
};

const fmt = (v) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

export default function FacHomeScreen() {
  const navigate = useNavigate();
  const name = getUserDisplayName() || 'Underwriter';

  const [risks, setRisks] = useState([]);
  const [kpis, setKpis] = useState({ total_risks: 0, bound: 0, quoted: 0, in_progress: 0, declined: 0, bound_premium: 0, bound_si: 0 });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);

  const statuses = ['ALL', 'DRAFT', 'QUOTED', 'BOUND', 'REFERRED', 'DECLINED', 'NTU'];

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const params = {};
      if (statusFilter !== 'ALL') params.status = statusFilter;
      if (search) params.search = search;
      const [risksData, kpisData] = await Promise.all([
        api.facListRisks(params),
        api.facGetKpis(),
      ]);
      setRisks(risksData);
      setKpis(kpisData);
    } catch (e) {
      console.error('Fac home load error:', e);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => { load(); }, [load]);

  // Debounced search
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const handleNewRisk = async (placementType, isQuote = false) => {
    try {
      const risk = await api.facCreateRisk({
        insured_name: 'New Risk',
        placement_type: placementType,
        status: 'DRAFT',
      });
      setActiveFacRiskId(risk.fac_risk_id, { quote: isQuote });
      navigate('/fac/risk/detail', { state: { facRiskId: risk.fac_risk_id } });
    } catch (e) {
      console.error('Create fac risk error:', e);
    }
  };

  const [showRenewModal, setShowRenewModal] = useState(false);

  const handleRenew = (riskId) => {
    setActiveFacRiskId(riskId, { quote: true });
    navigate('/fac/risk/detail', { state: { facRiskId: riskId } });
  };

  const handleOpenRisk = (riskId) => {
    setActiveFacRiskId(riskId);
    navigate('/fac/risk/detail', { state: { facRiskId: riskId } });
  };

  const kpiCards = [
    { label: 'Total Risks',  value: kpis.total_risks,  color: 'rgba(226,232,240,0.9)' },
    { label: 'Bound',        value: kpis.bound,         color: '#23d18b' },
    { label: 'Quoted',       value: kpis.quoted,        color: '#00d4ff' },
    { label: 'In Progress',  value: kpis.in_progress,   color: '#fbbf24' },
  ];

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #070d1c 0%, #050a14 100%)',
      color: 'rgba(226,232,240,0.92)',
      fontFamily: 'var(--font-sans)',
    }}>

      {/* Topbar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 24px', height: 56,
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: 'rgba(7,13,28,0.90)',
        position: 'sticky', top: 0, zIndex: 50,
        backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, #23d18b, #0aa36a)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 900, color: '#08140e',
            boxShadow: '0 0 14px rgba(35,209,139,0.35)',
          }}>U3</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '.12em', color: 'rgba(226,232,240,0.95)' }}>THE UNIVERSE™</div>
            <div style={{ fontSize: 9, color: 'rgba(0,212,255,0.65)', letterSpacing: '.08em' }}>FACULTATIVE</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => navigate('/select')} style={{
            appearance: 'none', border: '1px solid rgba(148,163,184,0.18)',
            background: 'rgba(8,16,40,0.45)', color: 'rgba(226,232,240,0.90)',
            borderRadius: 999, padding: '7px 14px', fontSize: 11, fontWeight: 650,
            cursor: 'pointer',
          }}>← Switch Product</button>
        </div>
      </div>

      {/* Main */}
      <div style={{ padding: '24px 28px 60px', maxWidth: 1300, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Facultative Portfolio</div>
          <div style={{ fontSize: 13, color: 'rgba(148,163,184,0.55)' }}>Individual risk submissions · {name}</div>
        </div>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          {kpiCards.map(k => (
            <div key={k.label} style={{
              background: 'rgba(8,14,30,0.70)', border: '1px solid rgba(255,255,255,0.09)',
              borderRadius: 14, padding: '16px 20px',
            }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.50)', marginBottom: 6 }}>{k.label}</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: k.color }}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
          <button onClick={() => handleNewRisk('PROPORTIONAL')} style={{
            appearance: 'none', border: 'none', cursor: 'pointer',
            background: 'linear-gradient(135deg, #23d18b, #0aa36a)',
            color: '#08140e', borderRadius: 10, padding: '12px 22px',
            fontSize: 12, fontWeight: 800, boxShadow: '0 0 16px rgba(35,209,139,0.25)',
          }}><span style={{ fontSize: 14, marginRight: 6 }}>+</span> Price Facultative Risk</button>
          <button onClick={() => handleNewRisk('PROPORTIONAL', true)} style={{
            appearance: 'none', border: '1px solid rgba(251,191,36,0.40)', cursor: 'pointer',
            background: 'rgba(251,191,36,0.08)',
            color: '#fbbf24', borderRadius: 10, padding: '12px 22px',
            fontSize: 12, fontWeight: 800,
          }}><span style={{ fontSize: 14, marginRight: 6 }}>+</span> Quote Risk</button>
          <button onClick={() => setShowRenewModal(true)} style={{
            appearance: 'none', border: '1px solid rgba(168,85,247,0.40)', cursor: 'pointer',
            background: 'rgba(168,85,247,0.08)',
            color: '#a855f7', borderRadius: 10, padding: '12px 22px',
            fontSize: 12, fontWeight: 800,
          }}><span style={{ fontSize: 14, marginRight: 6 }}>↻</span> Renew Risk</button>
        </div>

        {/* Search + filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={searchInput} onChange={e => setSearchInput(e.target.value)}
            placeholder="Search insured, ref, class, country…"
            style={{
              flex: 1, minWidth: 240, background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.09)', borderRadius: 8,
              color: 'rgba(226,232,240,0.90)', fontSize: 12, padding: '9px 14px',
              outline: 'none',
            }}
          />
          {statuses.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)} style={{
              appearance: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 700,
              letterSpacing: '.06em', padding: '7px 14px', borderRadius: 999,
              border: statusFilter === s ? '1px solid rgba(35,209,139,0.45)' : '1px solid rgba(148,163,184,0.18)',
              background: statusFilter === s ? 'rgba(35,209,139,0.10)' : 'rgba(8,16,40,0.45)',
              color: statusFilter === s ? '#23d18b' : 'rgba(148,163,184,0.70)',
            }}>{s}</button>
          ))}
        </div>

        {/* Risks table */}
        <div style={{ background: 'rgba(8,14,30,0.70)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 14, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(148,163,184,0.40)', fontSize: 12 }}>Loading…</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(5,8,16,0.85)' }}>
                  {['Reference', 'Insured', 'Type', 'Class', 'Country', 'Sum Insured', 'RI Premium', 'Inception', 'Status', ''].map(h => (
                    <th key={h} style={{
                      padding: '11px 16px', textAlign: h === 'Sum Insured' || h === 'RI Premium' ? 'right' : 'left',
                      fontSize: 9, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase',
                      color: 'rgba(148,163,184,0.55)', borderBottom: '1px solid rgba(255,255,255,0.08)',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {risks.length === 0 && (
                  <tr><td colSpan={10} style={{ padding: 40, textAlign: 'center', color: 'rgba(148,163,184,0.35)', fontSize: 12 }}>
                    No risks found. Use the buttons above to create your first submission.
                  </td></tr>
                )}
                {risks.map((r) => {
                  const deleteDraft = async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete ${r.fac_ref || 'this draft'}?`)) return;
                    try { await api.facDeleteRisk(r.fac_risk_id); load(); } catch (err) { console.error(err); }
                  };
                  const sc = STATUS_COLORS[r.status] || STATUS_COLORS.DRAFT;
                  const typePill = r.placement_type === 'NON_PROPORTIONAL'
                    ? { label: 'XL', bg: 'rgba(14,165,233,0.10)', border: 'rgba(14,165,233,0.30)', color: '#0ea5e9' }
                    : { label: 'QS', bg: 'rgba(35,209,139,0.10)', border: 'rgba(35,209,139,0.30)', color: '#23d18b' };
                  return (
                    <tr key={r.fac_risk_id}
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      onClick={() => handleOpenRisk(r.fac_risk_id)}>
                      <td style={{ padding: '12px 16px', fontWeight: 700, color: '#00d4ff', fontSize: 12, fontFamily: 'var(--font-mono)' }}>{r.fac_ref || '—'}</td>
                      <td style={{ padding: '12px 16px', fontWeight: 600, color: 'rgba(226,232,240,0.90)' }}>{r.insured_name}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{
                          padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 800,
                          background: typePill.bg, border: `1px solid ${typePill.border}`, color: typePill.color,
                        }}>{typePill.label}</span>
                      </td>
                      <td style={{ padding: '12px 16px', color: 'rgba(148,163,184,0.70)' }}>{r.cob_name || '—'}</td>
                      <td style={{ padding: '12px 16px', color: 'rgba(148,163,184,0.70)' }}>{r.country_name || '—'}</td>
                      <td style={{ padding: '12px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'rgba(226,232,240,0.80)' }}>{fmt(r.total_sum_insured)}</td>
                      <td style={{ padding: '12px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#23d18b', fontWeight: 600 }}>{fmt(r.ri_premium)}</td>
                      <td style={{ padding: '12px 16px', color: 'rgba(148,163,184,0.60)', fontSize: 12 }}>{r.inception_date ? r.inception_date.substring(0, 10) : '—'}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center',
                          padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 800, letterSpacing: '.06em',
                          background: sc.bg, border: `1px solid ${sc.border}`, color: sc.color,
                        }}>{r.status}</span>
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {r.status === 'DRAFT' && (
                          <span title="Delete draft" role="button" tabIndex={0} aria-label="Delete draft"
                            onClick={deleteDraft}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); deleteDraft(e); }
                            }}
                            style={{ cursor: 'pointer', color: 'rgba(248,113,113,0.50)', fontSize: 14, marginRight: 8, transition: 'color .15s' }}
                            onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                            onMouseLeave={e => e.currentTarget.style.color = 'rgba(248,113,113,0.50)'}>✕</span>
                        )}
                        <span style={{ color: 'rgba(148,163,184,0.40)', fontSize: 16 }}>›</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Renew Modal */}
      {showRenewModal && (
        <div className="modal-backdrop" role="presentation" style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={e => e.target === e.currentTarget && setShowRenewModal(false)}>
          <div className="glass" role="dialog" aria-modal="true" style={{
            background: 'rgba(12,20,40,0.98)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 18, padding: '28px 32px', width: 480, maxHeight: '70vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: 'rgba(226,232,240,0.92)', marginBottom: 6 }}>Renew Facultative Risk</div>
                <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.50)' }}>Select a bound risk to renew</div>
              </div>
              <button type="button" onClick={() => setShowRenewModal(false)} aria-label="Close" style={{ appearance: 'none', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: 'rgba(226,232,240,0.72)', borderRadius: 10, width: 34, height: 34, fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>✕</button>
            </div>
            {risks.filter(r => r.status === 'BOUND').length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'rgba(148,163,184,0.40)', fontSize: 12 }}>No bound risks available to renew</div>
            ) : (
              risks.filter(r => r.status === 'BOUND').map(r => (
                <div key={r.fac_risk_id} role="button" tabIndex={0}
                  onClick={() => { setShowRenewModal(false); handleRenew(r.fac_risk_id); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setShowRenewModal(false);
                      handleRenew(r.fac_risk_id);
                    }
                  }}
                  style={{
                    padding: '12px 16px', borderRadius: 10, cursor: 'pointer', marginBottom: 6,
                    border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(8,14,30,0.60)',
                  }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(168,85,247,0.40)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#00d4ff', fontFamily: 'var(--font-mono)' }}>{r.fac_ref}</div>
                  <div style={{ fontSize: 13, color: 'rgba(226,232,240,0.85)', marginTop: 2 }}>{r.insured_name}</div>
                  <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.50)', marginTop: 2 }}>{r.cob_name || '—'} · {r.country_name || '—'} · SI: {fmt(r.total_sum_insured)}</div>
                </div>
              ))
            )}
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button onClick={() => setShowRenewModal(false)} style={{
                appearance: 'none', border: '1px solid rgba(148,163,184,0.20)', background: 'transparent',
                color: 'rgba(226,232,240,0.70)', borderRadius: 8, padding: '8px 18px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
