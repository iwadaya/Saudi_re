// src/screens/facultative/risk_detail/RelatedTreatiesSection.jsx
// Related-treaties linker, extracted from FacRiskDetail. Independent entity that
// links to fac_treaty_link via its own endpoints. No behaviour change.
import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../../api';
import { FR, SectionTitle } from './FacRiskDetail.parts.jsx';

// ────────────────────────────────────────────────────────────────────────────
// Related Treaties section
//
// Independent entity — links to fac_treaty_link via its own endpoints,
// not folded into the risk's useScreenSave payload. Disabled until the
// risk has both a cedant and a fac_cob_id, since the eligible-treaties
// query keys on those two columns.
// ────────────────────────────────────────────────────────────────────────────
const LINK_TYPE_OPTIONS = [
  ['VOLUNTARY_OVER_TREATY',   'Voluntary — over the treaty'],
  ['OBLIGATORY_OUTSIDE_TREATY', 'Obligatory — outside the treaty'],
  ['FAC_INSTEAD_OF_TREATY',   'Fac instead of treaty'],
  ['INFORMATIONAL',           'Informational only'],
];
const LINK_TYPE_LABEL = Object.fromEntries(LINK_TYPE_OPTIONS);
const LINK_TYPE_COLOR = {
  VOLUNTARY_OVER_TREATY:    '#00d4ff',
  OBLIGATORY_OUTSIDE_TREATY:'#fbbf24',
  FAC_INSTEAD_OF_TREATY:    '#a855f7',
  INFORMATIONAL:            'rgba(148,163,184,0.75)',
};

export default function RelatedTreatiesSection({ riskId, hasCedant, hasCob }) {
  const enabled = Boolean(riskId && hasCedant && hasCob);
  const [eligible, setEligible] = useState([]);
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    contract_id: '', link_type: 'VOLUNTARY_OVER_TREATY',
    capacity_used: '', notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const [e, l] = await Promise.all([
        api.facGetEligibleTreaties(riskId).catch(() => ({ treaties: [] })),
        api.facGetTreatyLinks(riskId).catch(() => ({ links: [] })),
      ]);
      setEligible(e?.treaties || []);
      setLinks(l?.links || []);
    } finally {
      setLoading(false);
    }
  }, [enabled, riskId]);

  useEffect(() => { reload(); }, [reload]);

  // Drop already-linked treaties from the picker — selecting one twice
  // would just bounce off the UNIQUE constraint.
  const pickerOptions = useMemo(() => {
    const linkedIds = new Set(links.map((l) => l.contract_id));
    return eligible.filter((t) => !linkedIds.has(t.contract_id));
  }, [eligible, links]);

  async function onSaveDraft() {
    if (!draft.contract_id) return;
    setSaving(true);
    setToast(null);
    try {
      const payload = {
        contract_id: draft.contract_id,
        link_type:   draft.link_type,
        capacity_used: draft.capacity_used === '' ? null : Number(String(draft.capacity_used).replace(/,/g, '')),
        notes:       draft.notes || null,
      };
      await api.facCreateTreatyLink(riskId, payload);
      setAdding(false);
      setDraft({ contract_id: '', link_type: 'VOLUNTARY_OVER_TREATY', capacity_used: '', notes: '' });
      await reload();
    } catch (e) {
      // Server returns 409 DUPLICATE_LINK / 422 NOT_ELIGIBLE — both
      // surface here as a non-2xx fetch error with the body inside.
      const msg = e?.body?.error || e?.message || 'Failed to save treaty link';
      setToast({ kind: 'error', text: msg });
    }
    setSaving(false);
  }

  async function onUnlink(link) {
    const ok = typeof window !== 'undefined'
      ? window.confirm(`Unlink "${link.contract_label}"?`) : true;
    if (!ok) return;
    try {
      await api.facDeleteTreatyLink(riskId, link.link_id);
      await reload();
    } catch (e) {
      setToast({ kind: 'error', text: e?.message || 'Failed to unlink' });
    }
  }

  return (
    <>
      <SectionTitle>Related Treaties</SectionTitle>
      {!enabled ? (
        <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.7)', padding: '8px 0' }}>
          Select a cedant and a class of business above to surface eligible treaties.
        </div>
      ) : loading ? (
        <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.7)', padding: '8px 0' }}>
          Loading eligible treaties…
        </div>
      ) : (
        <>
          {/* Empty state */}
          {links.length === 0 && !adding && (
            <div style={{ padding: '14px 16px', background: 'var(--control-bg)',
                           border: '1px solid var(--hairline)', borderRadius: 10 }}>
              <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.75)', marginBottom: 8 }}>
                {eligible.length === 0
                  ? 'No eligible treaties found for this cedant + class in the policy window.'
                  : `${eligible.length} eligible treaty${eligible.length === 1 ? '' : 'ies'} found for this cedant + class.`}
              </div>
              {eligible.length > 0 && (
                <button onClick={() => setAdding(true)} style={{
                  appearance: 'none', border: '1px solid rgba(var(--accent-blue-rgb),0.30)',
                  background: 'rgba(var(--accent-blue-rgb),0.08)', color: 'var(--accent-blue)',
                  borderRadius: 6, padding: '6px 14px', fontSize: 11, fontWeight: 700,
                  cursor: 'pointer',
                }}>Link one</button>
              )}
            </div>
          )}

          {/* List existing links */}
          {links.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {links.map((l) => (
                <div key={l.link_id} style={{ padding: '10px 14px',
                                                background: 'var(--control-bg)',
                                                border: '1px solid var(--hairline)',
                                                borderRadius: 10,
                                                borderLeft: `3px solid ${LINK_TYPE_COLOR[l.link_type] || '#94a3b8'}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'rgba(var(--text-rgb),0.90)' }}>
                      {l.contract_label}
                    </span>
                    <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 9, fontWeight: 800,
                                    letterSpacing: '.10em',
                                    background: `${LINK_TYPE_COLOR[l.link_type] || '#94a3b8'}1f`,
                                    border: `1px solid ${LINK_TYPE_COLOR[l.link_type] || '#94a3b8'}66`,
                                    color: LINK_TYPE_COLOR[l.link_type] || 'rgba(148,163,184,0.85)' }}>
                      {LINK_TYPE_LABEL[l.link_type] || l.link_type}
                    </span>
                    {l.capacity_used != null && (
                      <span style={{ fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                        cap used: {Number(l.capacity_used).toLocaleString('en-US')}
                      </span>
                    )}
                    <div style={{ flex: 1 }} />
                    <span role="button" tabIndex={0}
                          onClick={() => onUnlink(l)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onUnlink(l); }
                          }}
                          style={{ cursor: 'pointer', color: 'var(--accent-rose)', fontSize: 11, fontWeight: 600 }}>
                      Unlink
                    </span>
                  </div>
                  {l.notes && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic',
                                    marginTop: 4 }}>
                      “{l.notes}”
                    </div>
                  )}
                </div>
              ))}
              {!adding && pickerOptions.length > 0 && (
                <button onClick={() => setAdding(true)} style={{
                  alignSelf: 'flex-start', appearance: 'none', border: '1px dashed rgba(var(--accent-blue-rgb),0.30)',
                  background: 'rgba(var(--accent-blue-rgb),0.05)', color: 'var(--accent-blue)',
                  borderRadius: 6, padding: '6px 14px', fontSize: 11, fontWeight: 700,
                  cursor: 'pointer', marginTop: 6,
                }}>+ Link another treaty</button>
              )}
            </div>
          )}

          {/* Inline panel */}
          {adding && (
            <div style={{ marginTop: 10, padding: '14px 16px',
                           background: 'rgba(var(--accent-blue-rgb),0.04)',
                           border: '1px solid rgba(var(--accent-blue-rgb),0.25)', borderRadius: 10 }}>
              <FR label="Treaty">
                <select className="fi" value={draft.contract_id}
                        onChange={(e) => setDraft((d) => ({ ...d, contract_id: e.target.value }))}>
                  <option value="">— Select an eligible treaty —</option>
                  {pickerOptions.map((t) => (
                    <option key={t.contract_id} value={t.contract_id}>{t.label}</option>
                  ))}
                </select>
              </FR>
              <FR label="Link Type">
                <select className="fi" value={draft.link_type}
                        onChange={(e) => setDraft((d) => ({ ...d, link_type: e.target.value }))}>
                  {LINK_TYPE_OPTIONS.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </FR>
              <FR label="Capacity Used" hint="Optional — SAR amount written into this treaty">
                <input className="fi" type="text" inputMode="numeric"
                       value={draft.capacity_used}
                       onChange={(e) => setDraft((d) => ({ ...d, capacity_used: e.target.value }))}
                       placeholder="e.g. 2,500,000" style={{ width: 200 }} />
              </FR>
              <FR label="Notes">
                <textarea className="fi" rows={2} value={draft.notes}
                          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                          placeholder="Why this treaty was used / not used…"
                          style={{ width: '100%', resize: 'vertical', fontSize: 12 }} />
              </FR>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                <button onClick={() => { setAdding(false); setToast(null); }}
                        style={{ appearance: 'none', border: '1px solid var(--stroke-soft)',
                                  background: 'transparent', color: 'rgba(var(--text-rgb),0.80)',
                                  borderRadius: 6, padding: '6px 14px', fontSize: 11,
                                  cursor: 'pointer' }}>Cancel</button>
                <button onClick={onSaveDraft} disabled={!draft.contract_id || saving}
                        style={{ appearance: 'none', border: '1px solid rgba(var(--accent-rgb),0.40)',
                                  background: 'rgba(var(--accent-rgb),0.10)', color: 'var(--accent)',
                                  borderRadius: 6, padding: '6px 14px', fontSize: 11, fontWeight: 700,
                                  cursor: (!draft.contract_id || saving) ? 'not-allowed' : 'pointer',
                                  opacity: (!draft.contract_id || saving) ? 0.5 : 1 }}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}

          {toast && (
            <div style={{ marginTop: 8, padding: '6px 12px', fontSize: 11,
                           background: toast.kind === 'error' ? 'rgba(var(--accent-rose-rgb),0.08)' : 'rgba(var(--accent-rgb),0.08)',
                           border: `1px solid ${toast.kind === 'error' ? 'rgba(var(--accent-rose-rgb),0.30)' : 'rgba(var(--accent-rgb),0.30)'}`,
                           color: toast.kind === 'error' ? 'var(--accent-rose)' : 'var(--accent)',
                           borderRadius: 6 }}>
              {toast.text}
            </div>
          )}
        </>
      )}
    </>
  );
}

