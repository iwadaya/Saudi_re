// src/screens/facultative/deductibles/FacDeductibles.jsx
import { useCallback, useMemo, useState } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { useFacRiskId } from '../../../hooks/useContractId';
import { numOrNull, formatWithCommasDecimal, sanitizeNumber, cleanNum } from '../../../utils/format';

const ROUTE_KEY = 'FAC_DEDUCTIBLES';

function FR({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 10, alignItems: 'center', minHeight: 36 }}>
      <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.7)' }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

export default function FacDeductibles() {
  const riskId = useFacRiskId();
  const [f, setF] = useState({ deductible_amount: '', deductible_description: '' });
  // Checklist items: [{ clause_code, clause_name, is_mandatory, is_checked, comments, ... }]
  const [checklist, setChecklist] = useState([]);

  const hydrateRisk = useCallback((r) => {
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

  const { save: saveDeductibles, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetRisk,
    save: saveRisk,
    currentState: () => f,
    onLoaded: hydrateRisk,
    errorLabel: 'Deductibles',
  });

  // ── Clauses checklist — independent entity, independent save ──────────
  // Load left-joins the clause master so every clause appears even before
  // the underwriter has touched the form (server already does this).
  const hydrateChecklist = useCallback((data) => {
    setChecklist(Array.isArray(data?.items) ? data.items : []);
  }, []);

  const saveChecklist = useCallback(
    (id, items) => api.facSaveClausesChecklist(id, {
      items: (items || []).map((it) => ({
        clause_code: it.clause_code,
        is_checked:  Boolean(it.is_checked),
        comments:    it.comments || null,
      })),
    }),
    [],
  );

  const { save: saveChecklistAction, markDirty: markChecklistDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetClausesChecklist,
    save: saveChecklist,
    currentState: () => checklist,
    onLoaded: hydrateChecklist,
    errorLabel: 'Clauses Checklist',
  });

  // Combined save: both entities flushed before WizardLayout advances.
  // Either failure blocks navigation (returns false).
  const save = useCallback(async () => {
    const a = await saveDeductibles();
    const b = await saveChecklistAction();
    return Boolean(a) && Boolean(b);
  }, [saveDeductibles, saveChecklistAction]);

  const set = (k, v) => { setF(prev => ({ ...prev, [k]: v })); markDirty(); };

  const setChecklistRow = useCallback((code, patch) => {
    setChecklist((prev) => prev.map((row) => (
      row.clause_code === code ? { ...row, ...patch } : row
    )));
    markChecklistDirty();
  }, [markChecklistDirty]);

  // Count of mandatory clauses that the underwriter has not ticked yet.
  // Shown as a red dot + chip in the section header; never blocks save.
  const missingMandatory = useMemo(
    () => checklist.filter((c) => c.is_mandatory && !c.is_checked).length,
    [checklist],
  );

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Deductibles & Terms" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '8px 0 40px' }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(var(--accent-blue-rgb),0.75)', marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--hairline)' }}>Deductible Structure</div>

        <FR label="Deductible Amount">
          <input className="fi" type="text" inputMode="decimal" value={formatWithCommasDecimal(f.deductible_amount)} onChange={e => set('deductible_amount', sanitizeNumber(e.target.value))} placeholder="0" />
        </FR>
        <FR label="Description / Schedule">
          <textarea className="fi" value={f.deductible_description} onChange={e => set('deductible_description', e.target.value)} rows={5}
            style={{ width: '100%', resize: 'vertical' }}
            placeholder={"e.g.\nFire & Allied Perils: 1% of SI, min USD 50,000\nNatural Catastrophe: 2% of SI, min USD 100,000\nMachinery Breakdown: USD 25,000 each & every loss\nBusiness Interruption: 60 days waiting period"} />
        </FR>

        <div style={{ marginTop: 28, padding: 16, background: 'rgba(var(--accent-blue-rgb),0.04)', border: '1px solid rgba(var(--accent-blue-rgb),0.12)', borderRadius: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(var(--accent-blue-rgb),0.80)', marginBottom: 6 }}>Deductible Guidance</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
            Deductibles should reflect the cedant&apos;s retention appetite and the nature of the risk. Common structures include flat monetary amounts per occurrence, percentage of sum insured with minimum/maximum amounts, and time-based waiting periods for BI covers. NatCat deductibles are typically higher than standard fire perils.
          </div>
        </div>

        {/* ── Clauses & Exclusions checklist ── */}
        <div style={{ marginTop: 32, paddingBottom: 6, borderBottom: '1px solid var(--hairline)',
                       display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase',
                        color: 'rgba(var(--accent-blue-rgb),0.75)' }}>
            Clauses &amp; Exclusions Checklist
          </div>
          {missingMandatory > 0 && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                          padding: '3px 10px', borderRadius: 20,
                          background: 'rgba(var(--accent-rose-rgb),0.10)',
                          border: '1px solid rgba(var(--accent-rose-rgb),0.30)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--accent-rose)' }} />
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.10em',
                             color: 'var(--accent-rose)', textTransform: 'uppercase' }}>
                {missingMandatory} mandatory missing
              </span>
            </div>
          )}
        </div>

        {checklist.length === 0 ? (
          <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.7)', padding: '14px 0' }}>
            Loading clause catalogue…
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
            <thead>
              <tr style={{ background: 'var(--table-head-bg)' }}>
                {['Clause', 'Mandatory', 'Checked', 'Comments'].map((h) => (
                  <th key={h} style={{ padding: '8px 10px',
                                       textAlign: h === 'Checked' || h === 'Mandatory' ? 'center' : 'left',
                                       fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                                       textTransform: 'uppercase', color: 'var(--muted)',
                                       borderBottom: '1px solid var(--hairline)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {checklist.map((row) => {
                const missing = row.is_mandatory && !row.is_checked;
                return (
                  <tr key={row.clause_code} style={{ borderBottom: '1px solid var(--hairline)' }}>
                    <td style={{ padding: '8px 10px', fontSize: 12,
                                  color: 'rgba(var(--text-rgb),0.85)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {missing && <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--accent-rose)', flexShrink: 0 }} />}
                        <div>
                          <div>{row.clause_name}</div>
                          <div style={{ fontSize: 10, color: 'rgba(var(--text-rgb),0.7)', marginTop: 1 }}>
                            {row.clause_code}{row.clause_category ? ` · ${row.clause_category}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'center', fontSize: 11,
                                  color: row.is_mandatory ? 'var(--accent-amber)' : 'rgba(var(--text-rgb),0.5)' }}>
                      {row.is_mandatory ? 'Mandatory' : 'Optional'}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                      <input type="checkbox" checked={Boolean(row.is_checked)}
                             onChange={(e) => setChecklistRow(row.clause_code, { is_checked: e.target.checked })}
                             style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }} />
                    </td>
                    <td style={{ padding: '4px 10px' }}>
                      <input className="fi" value={row.comments || ''}
                             onChange={(e) => setChecklistRow(row.clause_code, { comments: e.target.value })}
                             placeholder="Sub-limit / wording note…"
                             style={{ fontSize: 12, width: '100%' }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </WizardLayout>
  );
}
