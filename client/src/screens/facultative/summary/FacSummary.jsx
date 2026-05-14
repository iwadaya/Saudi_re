// src/screens/facultative/summary/FacSummary.jsx
//
// Read-only summary of the risk, the engine output the underwriter
// saw on the Pricing screen, and the capacity decision. Three fields
// are editable here — capacity_proposed_pct, accepted_rate_pm and the
// UW note — all persisting to fac_pricing via the existing save
// endpoint (migration 084 added the columns).
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useFacRiskId } from '../../../hooks/useContractId';
import { useScreenSave } from '../../../hooks/useScreenSave';

const ROUTE_KEY = 'FAC_SUMMARY';

const numOrNull = (v) => {
  const c = String(v ?? '').replace(/,/g, '').trim();
  if (!c) return null;
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
};
const fmt0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
};
const fmt4 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(4) : '—';
};
const fmtPct = (frac) => {
  const n = Number(frac);
  return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '—';
};

// Grade band colouring per the prompt: A-C green, D-F amber, G-I orange, J-K red.
function gradeColor(grade) {
  if (!grade) return 'rgba(148,163,184,0.55)';
  if (['A', 'B', 'C'].includes(grade)) return '#23d18b';
  if (['D', 'E', 'F'].includes(grade)) return '#fbbf24';
  if (['G', 'H', 'I'].includes(grade)) return '#f97316';
  if (['J', 'K'].includes(grade))      return '#f87171';
  return 'rgba(148,163,184,0.55)';
}

function Row({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0',
                   borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: 12, color: 'rgba(148,163,184,0.60)' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600,
                     color: color || 'rgba(226,232,240,0.85)',
                     fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function Sec({ title, color, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em',
                    textTransform: 'uppercase', color: color || 'rgba(0,212,255,0.55)',
                    marginBottom: 10, paddingBottom: 6,
                    borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{title}</div>
      {children}
    </div>
  );
}

export default function FacSummary() {
  const riskId = useFacRiskId();
  const navigate = useNavigate();

  const [risk, setRisk]           = useState(null);
  const [pricing, setPricing]     = useState(null);
  const [locations, setLocations] = useState([]);
  const [scoringTables, setScoringTables] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [auditEvents, setAuditEvents] = useState([]);
  const [actionBusy, setActionBusy] = useState(null);   // 'submit' | 'decline' | 'bind'
  const [declineModal, setDeclineModal] = useState({ open: false, reason: '', error: '' });
  const [actionMessage, setActionMessage] = useState(null); // { kind, text }
  // Three editable fields owned by this screen (persist to fac_pricing).
  const [edits, setEdits] = useState({
    capacity_proposed_pct: '',
    accepted_rate_pm: '',
    uw_note: '',
  });
  // Snapshot of pricing keys the save endpoint requires to preserve the
  // engine output already stored on the row (the schema validates the
  // full payload — we don't want to wipe the engine snapshot when a
  // user just edits the UW note).
  const pricingSnapshot = useRef(null);

  // Reference data loaders: scoring tables for the territorial cap lookup.
  useEffect(() => {
    api.facGetScoringTables().then(setScoringTables).catch(console.error);
  }, []);

  const load = useCallback(async () => {
    if (!riskId) return;
    setLoading(true);
    try {
      const [r, p, locs, ae] = await Promise.all([
        api.facGetRisk(riskId),
        api.facGetPricing(riskId),
        api.facGetLocations(riskId),
        api.facGetAuditEvents(riskId).catch(() => ({ events: [] })),
      ]);
      setRisk(r);
      setPricing(p);
      pricingSnapshot.current = p || null;
      setLocations(locs || []);
      setAuditEvents(ae?.events || []);
      setEdits({
        capacity_proposed_pct: p?.capacity_proposed_pct != null ? String(p.capacity_proposed_pct) : '',
        accepted_rate_pm:      p?.accepted_rate_pm      != null ? String(p.accepted_rate_pm)      : '',
        uw_note:               p?.uw_note || '',
      });
    } catch (e) { console.error('[FacSummary] load failed:', e); }
    setLoading(false);
  }, [riskId]);

  useEffect(() => { load(); }, [load]);

  // ── Editable-field save (the three Summary-owned fields) ─────────────
  // Preserves the engine snapshot already in pricingSnapshot so we don't
  // overwrite valid engine output with nulls on a partial save.
  const savePricingPatch = useCallback(
    async (id, state) => {
      const snap = pricingSnapshot.current || {};
      const payload = {
        ...snap,
        capacity_proposed_pct: numOrNull(state.capacity_proposed_pct),
        accepted_rate_pm:      numOrNull(state.accepted_rate_pm),
        uw_note:               state.uw_note || null,
      };
      // Strip computed / non-input columns the save endpoint doesn't
      // want to read back from the snapshot. ui_state may be a row from
      // a JOIN; coerce to a plain object.
      delete payload.pricing_id;
      delete payload.fac_risk_id;
      delete payload.created_at;
      delete payload.updated_at;
      const out = await api.facSavePricing(id, payload);
      pricingSnapshot.current = out;
      setPricing(out);
      return out;
    },
    [],
  );

  const { save, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: async () => null,  // hydration happens via the main load() above
    save: savePricingPatch,
    currentState: () => edits,
    onLoaded: () => {},
    errorLabel: 'Summary',
  });

  const setEdit = useCallback((key, val) => {
    setEdits((prev) => ({ ...prev, [key]: val }));
    markDirty();
  }, [markDirty]);

  // ── Derived figures ──────────────────────────────────────────────────
  const { topLocation, totalSar, totalPdSar, totalBiSar, carrierTopSi, carrierAllSi } = useMemo(() => {
    let topSar = 0;
    let topRow = null;
    let pdSar = 0; let biSar = 0;
    let cTop = 0; let cAll = 0;
    for (const l of locations) {
      const pd = Number(l.pd_si) || 0;
      const bi = Number(l.bi_si) || 0;
      const tot = pd + bi;
      // Carrier share — we save the same fraction on both pd/bi via the
      // location screen; take whichever is present.
      const share = Number(l.carrier_pd_share_pct ?? l.carrier_bi_share_pct) || 0;
      pdSar += pd; biSar += bi;
      cAll += tot * share;
      if (tot > topSar) {
        topSar = tot;
        topRow = l;
        cTop = tot * share;
      }
    }
    return {
      topLocation: topRow,
      totalSar: pdSar + biSar,
      totalPdSar: pdSar,
      totalBiSar: biSar,
      carrierTopSi: cTop,
      carrierAllSi: cAll,
    };
  }, [locations]);

  const territorialCap = useMemo(() => {
    if (!risk?.cedant_region || !scoringTables?.territorial_capacity) return null;
    const row = scoringTables.territorial_capacity.find((t) => t.region === risk.cedant_region);
    return row ? Number(row.max_capacity) : null;
  }, [risk, scoringTables]);

  if (loading || !risk) {
    return (
      <WizardLayout routeKey={ROUTE_KEY} title="Summary & Approval" headerPill="FACULTATIVE">
        <div style={{ padding: 40, textAlign: 'center', color: 'rgba(148,163,184,0.40)' }}>Loading…</div>
      </WizardLayout>
    );
  }

  // Empty state — engine score is the gate that lets the summary render.
  const pricingComplete = pricing && pricing.underwriting_score != null;
  if (!pricingComplete) {
    return (
      <WizardLayout routeKey={ROUTE_KEY} title="Summary & Approval" headerPill={risk.bound_reference || risk.fac_ref || 'FACULTATIVE'}>
        <div style={{ maxWidth: 540, margin: '60px auto', padding: 30,
                       background: 'rgba(251,191,36,0.06)',
                       border: '1px solid rgba(251,191,36,0.25)',
                       borderRadius: 12, textAlign: 'center' }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em',
                        textTransform: 'uppercase', color: '#fbbf24', marginBottom: 8 }}>
            Pricing incomplete
          </div>
          <div style={{ fontSize: 13, color: 'rgba(226,232,240,0.85)', marginBottom: 16 }}>
            The Summary screen needs a computed underwriting score before it
            can render. Open the Pricing screen, pick the factor selections,
            and the engine will fill in the rest.
          </div>
          <button onClick={() => navigate(`/fac/${riskId}/pricing`)} style={{
            appearance: 'none', border: '1px solid rgba(0,212,255,0.30)',
            background: 'rgba(0,212,255,0.10)', color: '#00d4ff',
            borderRadius: 8, padding: '10px 24px', fontSize: 12, fontWeight: 700,
            cursor: 'pointer',
          }}>← Return to Pricing</button>
        </div>
      </WizardLayout>
    );
  }

  const grade = pricing.capacity_grade;
  const headerRef = risk.bound_reference || risk.fac_ref || 'FACULTATIVE';

  // ── Workflow actions ────────────────────────────────────────────────
  // Each handler flushes any pending edits first, then hits the workflow
  // endpoint, then reloads so the screen reflects the new status.
  async function withAction(name, fn) {
    setActionBusy(name);
    setActionMessage(null);
    try {
      await save();          // flush capacity_proposed_pct / accepted_rate_pm / uw_note
      const result = await fn();
      await load();          // pull fresh risk + audit events
      return result;
    } catch (err) {
      console.error(`[FacSummary:${name}]`, err);
      setActionMessage({ kind: 'error', text: err?.message || `${name} failed` });
      return null;
    } finally {
      setActionBusy(null);
    }
  }

  const onSaveDraft = () => withAction('save', async () => {
    setActionMessage({ kind: 'ok', text: 'Draft saved.' });
  });

  const onSubmitForApproval = () => withAction('submit', async () => {
    const r = await api.facSubmitForApproval(riskId, {});
    if (r?.routed_to_senior) {
      setActionMessage({ kind: 'info', text: 'Routed to senior underwriter for sign-off.' });
    } else {
      setActionMessage({ kind: 'ok', text: 'Submitted — status is now QUOTED.' });
    }
    return r;
  });

  const onConfirmDecline = async () => {
    const reason = (declineModal.reason || '').trim();
    if (reason.length < 5) {
      setDeclineModal((m) => ({ ...m, error: 'Reason must be at least 5 characters.' }));
      return;
    }
    setDeclineModal((m) => ({ ...m, error: '' }));
    await withAction('decline', async () => {
      await api.facDecline(riskId, { reason });
      setDeclineModal({ open: false, reason: '', error: '' });
      setActionMessage({ kind: 'info', text: 'Risk declined.' });
    });
  };

  const onBind = () => withAction('bind', async () => {
    const r = await api.facBind(riskId, {});
    if (r?.bound_reference) {
      setActionMessage({ kind: 'ok', text: `Bound: ${r.bound_reference}.` });
    }
    return r;
  });

  // Pull signature info from the audit events (FAC_SUBMITTED, FAC_BOUND,
  // FAC_DECLINED). The senior slot stays empty until a peer/arbiter
  // table is added — for now, REFERRED is the only signal the risk is
  // sitting with a senior.
  const submittedEvent = auditEvents.find((e) => e.event_type === 'FAC_SUBMITTED');
  const closingEvent   = auditEvents.find((e) => e.event_type === 'FAC_BOUND' || e.event_type === 'FAC_DECLINED');

  const canSubmit = !!pricing && pricing.underwriting_score != null && actionBusy == null;
  const canBind   = risk.status === 'QUOTED' && actionBusy == null;
  const canDecline = ['DRAFT', 'QUOTED', 'REFERRED'].includes(risk.status) && actionBusy == null;

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Summary & Approval" headerPill={headerRef}
                  onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '8px 0 60px' }}>

        {/* ── 1. Risk Snapshot ── */}
        <Sec title="Risk Snapshot">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div>
              <Row label="Cedant"             value={risk.cedant_name || '—'} />
              <Row label="Insured"            value={risk.insured_name || '—'} />
              <Row label="Region"             value={risk.cedant_region || '—'} />
              <Row label="Country / Zone"     value={risk.risk_country_zone || risk.country_name || '—'} />
              <Row label="Occupancy"          value={risk.occupancy_name || '—'} />
            </div>
            <div>
              <Row label="Hazard Grade"       value={risk.hazard_grade_override ?? '—'} />
              <Row label="Multi-Location"     value={risk.multi_location_flag ? 'Yes' : 'No'} />
              <Row label="Multi-Occupancy"    value={risk.multi_occupancy_flag ? 'Yes' : 'No'} />
              <Row label="Inception / Expiry" value={`${risk.inception_date ? String(risk.inception_date).substring(0,10) : '—'} → ${risk.expiry_date ? String(risk.expiry_date).substring(0,10) : '—'}`} />
              <Row label="Renewal / New"      value={risk.renewal_or_new || '—'} />
            </div>
          </div>
        </Sec>

        {/* ── 2. Underwriting Score Panel ── */}
        <Sec title="Underwriting Score">
          <div style={{ display: 'grid', gridTemplateColumns: '180px 80px 1fr', gap: 16,
                         alignItems: 'center', padding: '14px 18px',
                         background: 'rgba(8,14,30,0.40)', border: '1px solid rgba(255,255,255,0.08)',
                         borderRadius: 10 }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                            textTransform: 'uppercase', color: 'rgba(148,163,184,0.45)' }}>Score</div>
              <div style={{ fontSize: 32, fontWeight: 900, color: '#e2e8f0',
                            fontVariantNumeric: 'tabular-nums' }}>
                {Number(pricing.underwriting_score).toFixed(2)}
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                            textTransform: 'uppercase', color: 'rgba(148,163,184,0.45)' }}>Grade</div>
              <div style={{ fontSize: 36, fontWeight: 900, color: gradeColor(grade) }}>
                {grade || '—'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                            textTransform: 'uppercase', color: 'rgba(148,163,184,0.45)' }}>Action</div>
              <div style={{ marginTop: 4 }}>
                <span style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 20,
                               background: `${gradeColor(grade)}26`, border: `1px solid ${gradeColor(grade)}66`,
                               color: gradeColor(grade), fontSize: 11, fontWeight: 800,
                               letterSpacing: '.08em' }}>
                  {pricing.uw_action || '—'}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.60)', marginTop: 8 }}>
                Scheme {pricing.bi_rate_pm ? 'WITH_BI' : 'WITHOUT_BI'} ·
                {' '}Market vs Tech {fmtPct(pricing.market_vs_tech_pct)} ({pricing.market_vs_tech_band || '—'})
              </div>
            </div>
          </div>
        </Sec>

        {/* ── 3. Capacity Panel ── */}
        <Sec title="Capacity" color="rgba(168,85,247,0.55)">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div>
              <Row label="Territorial Cap (SAR)"        value={fmt0(territorialCap)} />
              <Row label="Top Location SI (SAR)"        value={fmt0(topLocation ? (Number(topLocation.pd_si) || 0) + (Number(topLocation.bi_si) || 0) : null)} />
              <Row label="Top Location PML (SAR)"       value={fmt0((Number(topLocation?.pd_si) || 0) * (Number(topLocation?.pd_pml_pct) || 0) + (Number(topLocation?.bi_si) || 0) * (Number(topLocation?.bi_pml_pct) || 0))} />
              <Row label="Max Capacity (engine)"        value={`${fmtPct(pricing.max_capacity_pct)} = ${fmt0(pricing.max_capacity_sar)}`} color="#a855f7" />
            </div>
            <div>
              <Row label="Carrier Exposure — Top Loc."  value={fmt0(carrierTopSi)} color="#23d18b" />
              <Row label="Carrier Exposure — All Locs." value={fmt0(carrierAllSi)} color="#23d18b" />
              <Row label="Total PD / BI SAR"            value={`${fmt0(totalPdSar)} / ${fmt0(totalBiSar)}`} />
              <Row label="Total SAR SI"                 value={fmt0(totalSar)} />
              <Row label="Premium Expected"             value={fmt0(pricing.expected_premium)} color="#23d18b" />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, alignItems: 'center' }}>
            <div style={{ fontSize: 12, color: 'rgba(168,85,247,0.70)', fontWeight: 700 }}>
              Capacity Proposed %
            </div>
            <input className="fi" type="number" min={0} max={1} step={0.0001}
                   value={edits.capacity_proposed_pct}
                   onChange={(e) => setEdit('capacity_proposed_pct', e.target.value)}
                   placeholder="e.g. 0.15 = 15% of the layer"
                   style={{ width: 200, fontSize: 12 }} />
          </div>
        </Sec>

        {/* ── 4. Rate Panel ── */}
        <Sec title="Rate" color="rgba(35,209,139,0.55)">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div>
              <Row label="Technical Rate (‰, no NatCat)" value={fmt4(pricing.technical_rate_pm)} />
              <Row label="Total Rate (‰)"                value={fmt4(pricing.total_rate_pm)} />
              <Row label="Final Net Rate (‰)"            value={fmt4(pricing.final_net_rate_pm)} />
              <Row label="Final Gross Rate (‰)"          value={fmt4(pricing.final_gross_rate_pm)} color="#23d18b" />
            </div>
            <div>
              <Row label="Market vs Tech %"   value={fmtPct(pricing.market_vs_tech_pct)} />
              <Row label="Market vs Tech Band" value={pricing.market_vs_tech_band || '—'} />
              <Row label="Technical Premium"  value={fmt0(pricing.technical_premium)} />
              <Row label="Expected Premium"   value={fmt0(pricing.expected_premium)} color="#23d18b" />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, alignItems: 'center' }}>
            <div style={{ fontSize: 12, color: 'rgba(35,209,139,0.70)', fontWeight: 700 }}>
              Accepted Rate (‰)
            </div>
            <input className="fi" type="number" min={0} step={0.0001}
                   value={edits.accepted_rate_pm}
                   onChange={(e) => setEdit('accepted_rate_pm', e.target.value)}
                   placeholder="The rate actually agreed with the cedant"
                   style={{ width: 200, fontSize: 12 }} />
          </div>
        </Sec>

        {/* ── 5. UW Note ── */}
        <Sec title="Underwriter Note">
          <textarea className="fi" rows={4} value={edits.uw_note}
                    onChange={(e) => setEdit('uw_note', e.target.value)}
                    placeholder="Narrative on the proposed terms, conditions, or exceptions…"
                    style={{ width: '100%', resize: 'vertical', fontSize: 12 }} />
        </Sec>

        {/* ── 6. Reference Numbers ── */}
        <Sec title="Reference Numbers">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <Row label="FAC Reference"      value={risk.fac_ref || '—'} color="#00d4ff" />
            <Row label="Expiring Reference" value={risk.expiring_reference || '—'} />
            <Row label="Bound Reference"    value={risk.bound_reference || '—'} color={risk.bound_reference ? '#23d18b' : 'rgba(148,163,184,0.40)'} />
            <Row label="Status"             value={risk.status} color={risk.status === 'BOUND' ? '#23d18b' : risk.status === 'DECLINED' ? '#f87171' : '#00d4ff'} />
          </div>
        </Sec>

        {/* ── Action bar ── */}
        <div style={{ marginTop: 20, padding: '14px 16px',
                       background: 'rgba(8,14,30,0.50)',
                       border: '1px solid rgba(255,255,255,0.08)',
                       borderRadius: 12 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <ActionButton onClick={onSaveDraft} busy={actionBusy === 'save'} kind="neutral">
              Save Draft
            </ActionButton>
            <ActionButton onClick={onSubmitForApproval} busy={actionBusy === 'submit'} disabled={!canSubmit}
                          kind="primary" title={!canSubmit ? 'Pricing must be complete.' : undefined}>
              Submit for Approval
            </ActionButton>
            <ActionButton onClick={() => setDeclineModal({ open: true, reason: '', error: '' })}
                          busy={actionBusy === 'decline'} disabled={!canDecline} kind="danger"
                          title={!canDecline ? `Cannot decline from status ${risk.status}.` : undefined}>
              Decline
            </ActionButton>
            <ActionButton onClick={onBind} busy={actionBusy === 'bind'} disabled={!canBind}
                          kind="success"
                          title={!canBind ? `Bind requires status QUOTED (current: ${risk.status}).` : undefined}>
              Bind
            </ActionButton>
            <div style={{ flex: 1 }} />
            {actionMessage && (
              <div style={{ fontSize: 11, fontWeight: 700, padding: '6px 12px', borderRadius: 6,
                            background: actionMessage.kind === 'error' ? 'rgba(248,113,113,0.10)'
                                      : actionMessage.kind === 'info'  ? 'rgba(0,212,255,0.10)'
                                      : 'rgba(35,209,139,0.10)',
                            color: actionMessage.kind === 'error' ? '#f87171'
                                 : actionMessage.kind === 'info'  ? '#00d4ff' : '#23d18b' }}>
                {actionMessage.text}
              </div>
            )}
          </div>

          {/* Signature panel — read-only stubs filled from audit events. */}
          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <SignatureSlot title="Underwriter" event={submittedEvent} fallback="Not yet submitted." />
            <SignatureSlot title="Senior UW / CUO" event={closingEvent}
                           fallback={risk.status === 'REFERRED' ? 'Awaiting senior sign-off.' : 'Not yet counter-signed.'} />
          </div>
        </div>

        {/* Back to portfolio */}
        <div style={{ marginTop: 20, textAlign: 'center' }}>
          <button onClick={() => navigate('/fac')} style={{
            appearance: 'none', border: '1px solid rgba(148,163,184,0.18)',
            background: 'rgba(8,16,40,0.45)', color: 'rgba(226,232,240,0.80)',
            borderRadius: 8, padding: '10px 24px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}>← Back to Fac Portfolio</button>
        </div>

        {/* ── Decline modal ── */}
        {declineModal.open && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
                         zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
               onClick={() => setDeclineModal({ open: false, reason: '', error: '' })}>
            <div onClick={(e) => e.stopPropagation()}
                 style={{ width: 480, padding: 22, background: '#0f1729',
                          border: '1px solid rgba(248,113,113,0.30)', borderRadius: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '.10em',
                            textTransform: 'uppercase', color: '#f87171', marginBottom: 10 }}>
                Decline Risk
              </div>
              <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.70)', marginBottom: 12 }}>
                Provide a reason (at least 5 characters). This will be recorded
                in the audit log and set the risk status to <strong>DECLINED</strong>.
              </div>
              <textarea className="fi" rows={4} value={declineModal.reason}
                        onChange={(e) => setDeclineModal((m) => ({ ...m, reason: e.target.value, error: '' }))}
                        placeholder="e.g. Beyond mandate; loss ratio history above threshold; …"
                        style={{ width: '100%', resize: 'vertical', fontSize: 12 }} />
              {declineModal.error && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#f87171' }}>{declineModal.error}</div>
              )}
              <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setDeclineModal({ open: false, reason: '', error: '' })}
                        style={{ appearance: 'none', border: '1px solid rgba(148,163,184,0.20)',
                                  background: 'transparent', color: 'rgba(226,232,240,0.80)',
                                  borderRadius: 6, padding: '8px 18px', fontSize: 12, fontWeight: 700,
                                  cursor: 'pointer' }}>Cancel</button>
                <button onClick={onConfirmDecline} disabled={actionBusy === 'decline'}
                        style={{ appearance: 'none', border: '1px solid rgba(248,113,113,0.40)',
                                  background: 'rgba(248,113,113,0.10)', color: '#f87171',
                                  borderRadius: 6, padding: '8px 18px', fontSize: 12, fontWeight: 700,
                                  cursor: 'pointer' }}>Confirm Decline</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </WizardLayout>
  );
}

function ActionButton({ onClick, disabled, busy, kind, children, title }) {
  const palettes = {
    neutral: { border: 'rgba(148,163,184,0.30)', bg: 'rgba(8,16,40,0.45)', color: 'rgba(226,232,240,0.85)' },
    primary: { border: 'rgba(0,212,255,0.40)',   bg: 'rgba(0,212,255,0.10)', color: '#00d4ff' },
    success: { border: 'rgba(35,209,139,0.40)',  bg: 'rgba(35,209,139,0.10)', color: '#23d18b' },
    danger:  { border: 'rgba(248,113,113,0.40)', bg: 'rgba(248,113,113,0.10)', color: '#f87171' },
  };
  const p = palettes[kind] || palettes.neutral;
  const isDisabled = disabled || busy;
  return (
    <button onClick={onClick} disabled={isDisabled} title={title}
            style={{
              appearance: 'none', border: `1px solid ${p.border}`,
              background: p.bg, color: p.color,
              borderRadius: 8, padding: '8px 18px', fontSize: 12, fontWeight: 700,
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              opacity: isDisabled ? 0.45 : 1,
            }}>
      {busy ? '…' : children}
    </button>
  );
}

function SignatureSlot({ title, event, fallback }) {
  const empty = !event;
  return (
    <div style={{ padding: '10px 14px', background: empty ? 'rgba(8,14,30,0.30)' : 'rgba(35,209,139,0.05)',
                   border: '1px dashed', borderColor: empty ? 'rgba(148,163,184,0.20)' : 'rgba(35,209,139,0.30)',
                   borderRadius: 8 }}>
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                    textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: 4 }}>
        {title}
      </div>
      {empty ? (
        <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.45)', fontStyle: 'italic' }}>{fallback}</div>
      ) : (
        <div style={{ fontSize: 12 }}>
          <div style={{ color: '#e2e8f0', fontWeight: 700 }}>{event.actor || 'Unknown'}</div>
          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
            {event.event_type.replace('FAC_', '').toLowerCase()} · {new Date(event.created_at).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}
