// src/screens/facultative/summary/FacSummary.jsx
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useFacRiskId } from '../../../hooks/useContractId';

const ROUTE_KEY = 'FAC_SUMMARY';
const fmt = v => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'; };
const fmtPct = v => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(2) + '%' : '—'; };
const fmtRate = v => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(4) + '‰' : '—'; };

function Row({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: 12, color: 'rgba(148,163,184,0.55)' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: color || 'rgba(226,232,240,0.85)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}
function Sec({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(0,212,255,0.55)', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{title}</div>
      {children}
    </div>
  );
}

const ALLOWED_TRANSITIONS = {
  DRAFT: ['QUOTED', 'DECLINED', 'NTU'],
  QUOTED: ['BOUND', 'DECLINED', 'NTU', 'DRAFT'],
  REFERRED: ['QUOTED', 'DECLINED', 'NTU'],
  BOUND: ['CANCELLED'],
};

export default function FacSummary() {
  const riskId = useFacRiskId();
  const navigate = useNavigate();
  const [risk, setRisk] = useState(null);
  const [pricing, setPricing] = useState(null);
  const [losses, setLosses] = useState([]);
  const [linkedTreaties, setLinkedTreaties] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!riskId) return;
    setLoading(true);
    try {
      const [r, p, lo, lt] = await Promise.all([
        api.facGetRisk(riskId), api.facGetPricing(riskId),
        api.facGetLosses(riskId), api.facGetLinkedTreaties(riskId),
      ]);
      setRisk(r); setPricing(p); setLosses(lo || []); setLinkedTreaties(lt || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [riskId]);

  useEffect(() => { load(); }, [load]);

  const handleStatusChange = async (newStatus) => {
    try {
      await api.facUpdateRisk(riskId, { status: newStatus });
      load();
    } catch (e) { console.error(e); }
  };

  if (loading || !risk) return <WizardLayout routeKey={ROUTE_KEY} title="Summary" headerPill="FACULTATIVE"><div style={{ padding: 40, textAlign: 'center', color: 'rgba(148,163,184,0.40)' }}>Loading…</div></WizardLayout>;

  const transitions = ALLOWED_TRANSITIONS[risk.status] || [];
  const isProp = risk.placement_type === 'PROPORTIONAL';

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Summary & Approval" headerPill={risk.fac_ref || 'FACULTATIVE'}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '8px 0 40px' }}>

        {/* Status bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, padding: 16, background: 'rgba(8,14,30,0.60)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.45)' }}>Current Status</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: risk.status === 'BOUND' ? '#23d18b' : risk.status === 'DECLINED' ? '#f87171' : '#00d4ff', marginTop: 2 }}>{risk.status}</div>
          </div>
          <div style={{ flex: 1 }} />
          {transitions.map(s => (
            <button key={s} onClick={() => handleStatusChange(s)} style={{
              appearance: 'none', border: '1px solid rgba(148,163,184,0.20)', borderRadius: 8,
              padding: '7px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              background: s === 'BOUND' ? 'rgba(35,209,139,0.12)' : s === 'DECLINED' ? 'rgba(248,113,113,0.10)' : 'rgba(8,16,40,0.45)',
              color: s === 'BOUND' ? '#23d18b' : s === 'DECLINED' ? '#f87171' : 'rgba(226,232,240,0.80)',
            }}>→ {s}</button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div>
            <Sec title="Risk Identity">
              <Row label="Reference" value={risk.fac_ref} color="#00d4ff" />
              <Row label="Insured" value={risk.insured_name} />
              <Row label="Cedant" value={risk.cedant_name || '—'} />
              <Row label="Broker" value={risk.broker_name || '—'} />
              <Row label="Country" value={risk.country_name || '—'} />
              <Row label="Class" value={risk.cob_name || '—'} />
              <Row label="Occupation" value={risk.nature_of_business || '—'} />
            </Sec>

            <Sec title="Policy Period">
              <Row label="Inception" value={risk.inception_date ? risk.inception_date.substring(0, 10) : '—'} />
              <Row label="Expiry" value={risk.expiry_date ? risk.expiry_date.substring(0, 10) : '—'} />
              <Row label="UW Year" value={risk.uw_year || '—'} />
            </Sec>

            <Sec title="Sums Insured">
              <Row label="PD SI" value={fmt(risk.pd_sum_insured)} />
              <Row label="BI SI" value={fmt(risk.bi_sum_insured)} />
              <Row label="Total SI" value={fmt(risk.total_sum_insured)} color="#00d4ff" />
              <Row label="PML" value={`${fmtPct(risk.pml_pct)} = ${fmt(risk.pml_amount)}`} />
              <Row label="MFL" value={`${fmtPct(risk.mfl_pct)} = ${fmt(risk.mfl_amount)}`} />
            </Sec>
          </div>

          <div>
            <Sec title="Placement">
              <Row label="Type" value={isProp ? 'Proportional' : 'Non-Proportional'} />
              {isProp ? <>
                <Row label="Cedant Retention" value={fmtPct(risk.cedant_retention_pct)} />
                <Row label="RI Share" value={fmtPct(risk.ri_share_pct)} />
                <Row label="Our Share" value={fmtPct(risk.our_share_pct)} />
              </> : <>
                <Row label="Retention" value={fmt(risk.np_retention)} />
                <Row label="Limit" value={fmt(risk.np_limit)} />
                <Row label="Our Share" value={fmtPct(risk.np_our_share_pct)} />
              </>}
              <Row label="Commission" value={fmtPct(risk.commission_pct)} />
              <Row label="Brokerage" value={fmtPct(risk.brokerage_pct)} />
            </Sec>

            <Sec title="Pricing">
              {pricing ? <>
                <Row label="Market Rate" value={fmtRate(pricing.market_rate_per_mille)} />
                <Row label="Actuarial Rate" value={fmtRate(pricing.actuarial_rate_per_mille)} />
                <Row label="Blend Weights" value={`${pricing.market_weight_pct || 50}% / ${pricing.actuarial_weight_pct || 50}%`} />
                <Row label="Blended Rate" value={fmtRate(pricing.blended_rate_per_mille)} color="#fbbf24" />
                <Row label="UW Adjustment" value={`${pricing.uw_adjustment_pct || 0}%`} />
                <Row label="Final Rate" value={fmtRate(pricing.final_rate_per_mille)} color="#23d18b" />
                <Row label="Final Premium" value={fmt(pricing.final_premium)} color="#23d18b" />
              </> : <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.35)' }}>No pricing saved yet.</div>}
            </Sec>

            <Sec title="Loss History">
              <Row label="Total Losses" value={String(losses.length)} />
              <Row label="Total FGU Incurred" value={fmt(losses.reduce((s, l) => s + (Number(l.fgu_paid) || 0) + (Number(l.fgu_outstanding) || 0), 0))} color="#fbbf24" />
            </Sec>

            {linkedTreaties.length > 0 && (
              <Sec title="Linked Treaties">
                {linkedTreaties.slice(0, 5).map(t => (
                  <Row key={t.contract_id} label={`${t.uw_year} ${t.treaty_type_name || ''}`} value={t.status} />
                ))}
              </Sec>
            )}
          </div>
        </div>

        {/* Back to portfolio */}
        <div style={{ marginTop: 32, textAlign: 'center' }}>
          <button onClick={() => navigate('/fac')} style={{
            appearance: 'none', border: '1px solid rgba(148,163,184,0.18)',
            background: 'rgba(8,16,40,0.45)', color: 'rgba(226,232,240,0.80)',
            borderRadius: 8, padding: '10px 24px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}>← Back to Fac Portfolio</button>
        </div>
      </div>
    </WizardLayout>
  );
}
