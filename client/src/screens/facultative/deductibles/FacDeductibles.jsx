// src/screens/facultative/deductibles/FacDeductibles.jsx
import { useCallback, useState } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { useFacRiskId } from '../../../hooks/useContractId';

const ROUTE_KEY = 'FAC_DEDUCTIBLES';
const numOrNull = v => { const c = String(v ?? '').replace(/,/g,'').trim(); if (!c) return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
const cleanNum = v => { if (v == null || v === '') return ''; const n = Number(v); if (!Number.isFinite(n)) return String(v); return n === Math.floor(n) ? String(Math.floor(n)) : String(n); };
const fmtComma = v => { const d = String(v ?? '').replace(/[^\d]/g,''); return d ? Number(d).toLocaleString('en-US') : ''; };
const stripDigits = v => String(v ?? '').replace(/[^\d]/g,'');

function FR({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 10, alignItems: 'center', minHeight: 36 }}>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

export default function FacDeductibles() {
  const riskId = useFacRiskId();
  const [f, setF] = useState({ deductible_amount: '', deductible_description: '' });

  const hydrate = useCallback((r) => {
    setF({
      deductible_amount: cleanNum(r.deductible_amount) || '',
      deductible_description: r.deductible_description || '',
    });
  }, []);

  const saveRisk = useCallback(
    (id, state) => api.facUpdateRisk(id, {
      deductible_amount: numOrNull(state.deductible_amount),
      deductible_description: state.deductible_description,
    }),
    [],
  );

  const { save, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetRisk,
    save: saveRisk,
    currentState: () => f,
    onLoaded: hydrate,
    errorLabel: 'Deductibles',
  });

  const set = (k, v) => { setF(prev => ({ ...prev, [k]: v })); markDirty(); };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Deductibles & Terms" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '8px 0 40px' }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(0,212,255,0.55)', marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>Deductible Structure</div>

        <FR label="Deductible Amount">
          <input className="fi" type="text" inputMode="numeric" value={fmtComma(f.deductible_amount)} onChange={e => set('deductible_amount', stripDigits(e.target.value))} placeholder="0" />
        </FR>
        <FR label="Description / Schedule">
          <textarea className="fi" value={f.deductible_description} onChange={e => set('deductible_description', e.target.value)} rows={5}
            style={{ width: '100%', resize: 'vertical' }}
            placeholder={"e.g.\nFire & Allied Perils: 1% of SI, min USD 50,000\nNatural Catastrophe: 2% of SI, min USD 100,000\nMachinery Breakdown: USD 25,000 each & every loss\nBusiness Interruption: 60 days waiting period"} />
        </FR>

        <div style={{ marginTop: 28, padding: 16, background: 'rgba(0,212,255,0.04)', border: '1px solid rgba(0,212,255,0.12)', borderRadius: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(0,212,255,0.60)', marginBottom: 6 }}>Deductible Guidance</div>
          <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.55)', lineHeight: 1.7 }}>
            Deductibles should reflect the cedant's retention appetite and the nature of the risk. Common structures include flat monetary amounts per occurrence, percentage of sum insured with minimum/maximum amounts, and time-based waiting periods for BI covers. NatCat deductibles are typically higher than standard fire perils.
          </div>
        </div>
      </div>
    </WizardLayout>
  );
}
