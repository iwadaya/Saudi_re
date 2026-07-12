// src/screens/facultative/coverage_structure/FacCoverageStructure.jsx
import { useCallback, useEffect, useState } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { useFacRiskId } from '../../../hooks/useContractId';

const ROUTE_KEY = 'FAC_COVERAGE_STRUCTURE';
const numOrNull = v => { const c = String(v ?? '').replace(/,/g,'').trim(); if (!c) return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
const cleanNum = v => { if (v == null || v === '') return ''; const n = Number(v); if (!Number.isFinite(n)) return String(v); return n === Math.floor(n) ? String(Math.floor(n)) : String(n); };
const fmtComma = v => { const d = String(v ?? '').replace(/[^\d]/g,''); return d ? Number(d).toLocaleString('en-US') : ''; };
const stripDigits = v => String(v ?? '').replace(/[^\d]/g,'');

function FR({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 10, alignItems: 'center', minHeight: 36 }}>
      <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.55)' }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}
function Sec({ title, children }) {
  return <>
    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(var(--accent-blue-rgb),0.75)', marginTop: 28, marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--hairline)' }}>{title}</div>
    {children}
  </>;
}

const INITIAL = {
  placement_type: 'PROPORTIONAL',
  cedant_retention_pct: '', ri_share_pct: '', our_share_pct: '',
  np_retention: '', np_limit: '', np_our_share_pct: '',
  commission_pct: '', brokerage_pct: '', taxes_pct: '',
  original_premium: '', ri_premium: '', original_rate: '',
};

export default function FacCoverageStructure() {
  const riskId = useFacRiskId();
  const [f, setF] = useState(INITIAL);

  const hydrate = useCallback((r) => {
    setF({
      placement_type: r.placement_type || 'PROPORTIONAL',
      cedant_retention_pct: cleanNum(r.cedant_retention_pct) || '',
      ri_share_pct: cleanNum(r.ri_share_pct) || '',
      our_share_pct: cleanNum(r.our_share_pct) || '',
      np_retention: cleanNum(r.np_retention) || '',
      np_limit: cleanNum(r.np_limit) || '',
      np_our_share_pct: cleanNum(r.np_our_share_pct) || '',
      commission_pct: cleanNum(r.commission_pct) || '',
      brokerage_pct: cleanNum(r.brokerage_pct) || '',
      taxes_pct: cleanNum(r.taxes_pct) || '',
      original_premium: cleanNum(r.original_premium) || '',
      ri_premium: cleanNum(r.ri_premium) || '',
      original_rate: cleanNum(r.original_rate) || '',
    });
  }, []);

  const persist = useCallback((id, state) => api.facUpdateRisk(id, {
    placement_type: state.placement_type,
    cedant_retention_pct: numOrNull(state.cedant_retention_pct),
    ri_share_pct: numOrNull(state.ri_share_pct),
    our_share_pct: numOrNull(state.our_share_pct),
    np_retention: numOrNull(state.np_retention),
    np_limit: numOrNull(state.np_limit),
    np_our_share_pct: numOrNull(state.np_our_share_pct),
    commission_pct: numOrNull(state.commission_pct),
    brokerage_pct: numOrNull(state.brokerage_pct),
    taxes_pct: numOrNull(state.taxes_pct),
    original_premium: numOrNull(state.original_premium),
    ri_premium: numOrNull(state.ri_premium),
    original_rate: numOrNull(state.original_rate),
  }), []);

  const { save, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetRisk,
    save: persist,
    currentState: () => f,
    onLoaded: hydrate,
    errorLabel: 'Coverage structure',
  });

  const set = useCallback((k, v) => { setF(prev => ({ ...prev, [k]: v })); markDirty(); }, [markDirty]);
  const isProp = f.placement_type === 'PROPORTIONAL';

  // Auto-calc RI share = 100 − retention
  useEffect(() => {
    if (isProp && f.cedant_retention_pct !== '') {
      const ret = numOrNull(f.cedant_retention_pct) || 0;
      set('ri_share_pct', String(Math.max(0, 100 - ret)));
    }
  }, [f.cedant_retention_pct, isProp, set]);

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Placement Structure" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '8px 0 40px' }}>

        <Sec title="Placement Type">
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {['PROPORTIONAL', 'NON_PROPORTIONAL'].map(t => (
              <button key={t} onClick={() => set('placement_type', t)} style={{
                appearance: 'none', cursor: 'pointer', padding: '8px 20px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                border: f.placement_type === t ? '1px solid rgba(var(--accent-blue-rgb),0.50)' : '1px solid var(--stroke-soft)',
                background: f.placement_type === t ? 'rgba(var(--accent-blue-rgb),0.10)' : 'var(--control-bg)',
                color: f.placement_type === t ? 'var(--accent-blue)' : 'var(--muted)',
              }}>{t === 'PROPORTIONAL' ? 'Proportional (QS)' : 'Non-Proportional (XL)'}</button>
            ))}
          </div>
        </Sec>

        {isProp ? (
          <Sec title="Proportional Structure">
            <FR label="Cedant Retention %"><PctInput value={f.cedant_retention_pct} onChange={v => set('cedant_retention_pct', v)} style={{ width: 100 }} /></FR>
            <FR label="RI Share %"><PctInput value={f.ri_share_pct} onChange={() => {}} readOnly style={{ width: 100, opacity: 0.6 }} /></FR>
            <FR label="Our Share %"><PctInput value={f.our_share_pct} onChange={v => set('our_share_pct', v)} style={{ width: 100 }} placeholder="Of the RI portion" /></FR>
          </Sec>
        ) : (
          <Sec title="Non-Proportional Structure">
            <FR label="Retention / Priority"><input className="fi" type="text" inputMode="numeric" value={fmtComma(f.np_retention)} onChange={e => set('np_retention', stripDigits(e.target.value))} /></FR>
            <FR label="Limit (xs Retention)"><input className="fi" type="text" inputMode="numeric" value={fmtComma(f.np_limit)} onChange={e => set('np_limit', stripDigits(e.target.value))} /></FR>
            <FR label="Our Share %"><PctInput value={f.np_our_share_pct} onChange={v => set('np_our_share_pct', v)} style={{ width: 100 }} /></FR>
          </Sec>
        )}

        <Sec title="Commission & Costs">
          <FR label="Commission %"><PctInput value={f.commission_pct} onChange={v => set('commission_pct', v)} style={{ width: 100 }} /></FR>
          <FR label="Brokerage %"><PctInput value={f.brokerage_pct} onChange={v => set('brokerage_pct', v)} style={{ width: 100 }} /></FR>
          <FR label="Taxes %"><PctInput value={f.taxes_pct} onChange={v => set('taxes_pct', v)} style={{ width: 100 }} /></FR>
        </Sec>

        <Sec title="Original Premium">
          <FR label="Original Rate (‰)"><input className="fi" type="number" value={f.original_rate} onChange={e => set('original_rate', e.target.value)} min={0} step={0.001} style={{ width: 120 }} placeholder="Rate per mille" /></FR>
          <FR label="Original Premium (100%)"><input className="fi" type="text" inputMode="numeric" value={fmtComma(f.original_premium)} onChange={e => set('original_premium', stripDigits(e.target.value))} placeholder="Cedant's gross premium" /></FR>
          <FR label="RI Premium (Our Share)"><input className="fi" type="text" inputMode="numeric" value={fmtComma(f.ri_premium)} onChange={e => set('ri_premium', stripDigits(e.target.value))} placeholder="Our reinsurance premium" /></FR>
        </Sec>
      </div>
    </WizardLayout>
  );
}
