import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../../api';
import { useAppState } from '../../../context/AppContext';
import { useContractId } from '../../../hooks/useContractId';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { useGlobalToast } from '../../../hooks/useToast';
import { getUserDisplayName } from '../../../utils/auth';

const ROUTE_KEY = 'PROP_FINAL_BIND';

const fmt = v => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'; };
const fmtPct = v => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(2) + '%' : '—'; };

const TERMINAL_STATES = new Set(['SIGNED', 'NTU', 'DECLINED']);

function normalizeStatus(s) {
  if (!s) return 'DRAFT';
  const u = String(s).toUpperCase();
  if (u === 'RETURNED' || u === 'OFFERED' || u === 'PENDING') return 'DRAFT';
  return u;
}

function Row({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: 12, color: 'rgba(148,163,184,0.55)' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: color || 'rgba(226,232,240,0.85)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(0,212,255,0.55)', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{title}</div>
      {children}
    </div>
  );
}

function StatusBadge({ status }) {
  const palette = {
    SIGNED:               { bg: 'rgba(74,222,128,0.10)', fg: '#23d18b', label: '✅ Signed' },
    NTU:                  { bg: 'rgba(249,115,22,0.10)', fg: '#fb923c', label: '🚫 NTU' },
    DECLINED:             { bg: 'rgba(248,113,113,0.10)', fg: '#f87171', label: '❌ Declined' },
    AWAITING_SIGNED_LINE: { bg: 'rgba(96,165,250,0.10)', fg: '#60a5fa', label: '✍ Awaiting Signed Line' },
    AWAITING_APPROVAL:    { bg: 'rgba(251,191,36,0.10)', fg: '#fbbf24', label: '⏳ Awaiting Approval' },
    APPROVED:             { bg: 'rgba(74,222,128,0.06)', fg: '#4ade80', label: '✓ Approved' },
    DRAFT:                { bg: 'rgba(148,163,184,0.10)', fg: 'rgba(226,232,240,0.85)', label: '○ Draft' },
  };
  const p = palette[status] || palette.DRAFT;
  return (
    <span style={{ background: p.bg, color: p.fg, fontWeight: 800, padding: '4px 10px', borderRadius: 6, fontSize: 12, letterSpacing: '.04em' }}>{p.label}</span>
  );
}

export default function PropFinalBind() {
  const { state: appState } = useAppState();
  const contractId = useContractId();
  const navigate = useNavigate();
  const showToast = useGlobalToast();
  const actorName = useMemo(() => getUserDisplayName(), []);
  const td = appState.propTreatyDetail || {};
  const cid = contractId || td.contractId;

  const [loading, setLoading] = useState(true);
  const [contract, setContract] = useState({});
  const [pricing, setPricing] = useState({});
  const [trail, setTrail] = useState([]);
  const [status, setStatus] = useState('DRAFT');
  const [writtenLine, setWrittenLine] = useState('');
  const [signedLinePct, setSignedLinePct] = useState('');
  const [ntuReason, setNtuReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!cid) { setLoading(false); return; }
    setLoading(true);
    try {
      const [c, p, t] = await Promise.all([
        api.getContract(cid).catch(() => ({})),
        api.getPricing(cid).catch(() => ({})),
        api.getApprovalTrail(cid).catch(() => []),
      ]);
      const hdr = c?.header || c || {};
      setContract(c || {});
      setPricing(p || {});
      setTrail(Array.isArray(t) ? t : []);
      const st = normalizeStatus(hdr.status || p?.outputs?.offer_status || p?.outputs?.status);
      setStatus(st);
      if (p?.outputs?.offer_line) setWrittenLine(String(p.outputs.offer_line));
      const sl = hdr.signed_line_pct ?? p?.outputs?.signed_line_pct;
      if (sl) setSignedLinePct(String(sl));
    } catch (e) {
      console.error('PropFinalBind load failed:', e);
    }
    setLoading(false);
  }, [cid]);

  useEffect(() => { load(); }, [load]);

  const writtenNum = parseFloat(String(writtenLine || '').replace(/%/g, '').trim());
  const signedNum = parseFloat(String(signedLinePct || '').replace(/%/g, '').trim());
  const writtenPct = Number.isFinite(writtenNum) ? writtenNum / 100 : 0;
  const signedPct = Number.isFinite(signedNum) ? signedNum / 100 : 0;
  const signedOver = writtenPct > 0 && signedPct > writtenPct;

  const det = contract?.detail || {};
  const hdr = contract?.header || {};
  const epi = Number(td?.quotaShareEpi || det?.quota_share_epi || 0) + Number(td?.surplusEpi || det?.surplus_epi || 0);
  const limit = Number(td?.surplusLimit || det?.surplus_limit || 0);
  const ccy = hdr?.currency_code || td?.currency || 'USD';
  const cedant = hdr?.cedant_name || td?.cedant || '—';
  const uwYear = hdr?.uw_year || td?.uwYear || '—';

  const signedPremium = Math.round(epi * signedPct);
  const signedLimit = Math.round(limit * signedPct);
  const writtenPremium = Math.round(epi * writtenPct);

  const canSign = status === 'AWAITING_SIGNED_LINE' && signedNum > 0 && !signedOver && !busy;
  const canNtu = status === 'AWAITING_SIGNED_LINE' && !busy;

  const handleMarkSigned = async () => {
    if (!Number.isFinite(signedNum) || signedNum <= 0) {
      showToast('Enter a non-zero signed line %.');
      return;
    }
    if (signedOver) {
      showToast(`Signed line cannot exceed written line (${writtenLine}%).`);
      return;
    }
    setBusy(true);
    try {
      await api.markOfferSigned(cid, { signed_line_pct: signedLinePct, _actor: actorName });
      await load();
      showToast('Treaty marked Signed.');
    } catch (e) {
      showToast('Failed to mark signed: ' + (e?.message || 'Server error'));
    }
    setBusy(false);
  };

  const handleMarkNtu = async () => {
    if (signedNum > 0 && !window.confirm('A signed line is entered. Mark as NTU anyway?')) return;
    if (!ntuReason.trim() && !window.confirm('Mark NTU without a reason?')) return;
    setBusy(true);
    try {
      await api.markOfferNTU(cid, { reason: ntuReason || '', _actor: actorName });
      await load();
      showToast('Treaty marked NTU.');
    } catch (e) {
      showToast('Failed to mark NTU: ' + (e?.message || 'Server error'));
    }
    setBusy(false);
  };

  if (loading) {
    return (
      <WizardLayout routeKey={ROUTE_KEY} title="Final Bind" headerPill="PROPORTIONAL TREATY: FINAL BIND">
        <div style={{ padding: 40, textAlign: 'center', color: 'rgba(148,163,184,0.40)' }}>Loading…</div>
      </WizardLayout>
    );
  }

  if (!cid) {
    return (
      <WizardLayout routeKey={ROUTE_KEY} title="Final Bind" headerPill="PROPORTIONAL TREATY: FINAL BIND">
        <div style={{ padding: 40, textAlign: 'center', color: 'rgba(148,163,184,0.55)' }}>
          No active treaty. Open a treaty from the dashboard first.
        </div>
      </WizardLayout>
    );
  }

  const money = (v) => `${fmt(v)} ${ccy}`;
  const isTerminal = TERMINAL_STATES.has(status);
  const isPreApproval = status === 'DRAFT' || status === 'AWAITING_APPROVAL';

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Final Bind" headerPill="PROPORTIONAL TREATY: FINAL BIND">
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '8px 0 40px' }}>

        {/* Status header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24, padding: 16, background: 'rgba(8,14,30,0.60)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.45)' }}>Treaty Status</div>
            <div style={{ marginTop: 4 }}><StatusBadge status={status} /></div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.55)' }}>{cedant}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#00d4ff' }}>UW {uwYear}</div>
          </div>
        </div>

        {/* Pre-approval guidance */}
        {isPreApproval && (
          <div style={{ padding: 16, background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 10, marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', marginBottom: 4 }}>Pricing approval required first</div>
            <div style={{ fontSize: 12, color: 'rgba(226,232,240,0.65)' }}>
              The treaty must reach <b>Awaiting Signed Line</b> before it can be bound.
              Return to the Pricing screen to submit for approval.
            </div>
            <button
              type="button"
              onClick={() => navigate('/prop/pricing')}
              style={{ marginTop: 10, appearance: 'none', border: '1px solid rgba(251,191,36,0.45)', background: 'rgba(251,191,36,0.08)', color: '#fbbf24', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >← Back to Pricing</button>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* Left: terms */}
          <div>
            <Section title="Treaty Identity">
              <Row label="Cedant" value={cedant} />
              <Row label="UW Year" value={uwYear} />
              <Row label="Currency" value={ccy} />
              <Row label="Treaty Type" value={hdr?.treaty_type_name || td?.treatyType || '—'} />
            </Section>

            <Section title="100% Terms">
              <Row label="100% EPI" value={money(epi)} />
              <Row label="100% Limit" value={money(limit)} />
              <Row label="QS Cession %" value={fmtPct(td?.quotaSharePct ?? det?.quota_share_pct)} />
              <Row label="Surplus Lines" value={fmt(td?.surplusLines ?? det?.surplus_lines)} />
            </Section>

            <Section title="Pricing Snapshot">
              {pricing?.outputs ? (
                <>
                  <Row label="Technical Loss Ratio" value={fmtPct(pricing.outputs.technical_lr_pct)} />
                  <Row label="Combined Ratio" value={fmtPct(pricing.outputs.combined_ratio_pct)} />
                  <Row label="UW Margin" value={fmtPct(pricing.outputs.uw_margin_pct)} color="#fbbf24" />
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.40)' }}>No pricing outputs saved.</div>
              )}
            </Section>
          </div>

          {/* Right: signed line + actions */}
          <div>
            <Section title="Signed Line Capture">
              <Row label="Written Line" value={writtenLine ? `${writtenLine}%` : '—'} />
              <Row label="Written Premium" value={writtenPct > 0 ? money(writtenPremium) : '—'} />

              <div style={{ marginTop: 14, padding: 14, border: `1px solid ${isTerminal ? 'rgba(74,222,128,0.25)' : status === 'AWAITING_SIGNED_LINE' ? 'rgba(96,165,250,0.30)' : 'rgba(148,163,184,0.18)'}`, borderRadius: 10, background: isTerminal ? 'rgba(74,222,128,0.04)' : status === 'AWAITING_SIGNED_LINE' ? 'rgba(96,165,250,0.04)' : 'rgba(8,14,30,0.40)', opacity: isPreApproval ? 0.55 : 1 }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.10em', textTransform: 'uppercase', color: status === 'AWAITING_SIGNED_LINE' ? '#60a5fa' : 'rgba(148,163,184,0.55)', marginBottom: 8 }}>
                  {status === 'SIGNED' ? 'Signed Line' : 'Signed Line Received from Market'}
                </div>
                <PctInput
                  value={signedLinePct}
                  onChange={(v) => { if (status === 'AWAITING_SIGNED_LINE') setSignedLinePct(v); }}
                  placeholder="0.0%"
                  readOnly={status !== 'AWAITING_SIGNED_LINE'}
                  style={{ width: '100%', fontSize: 22, padding: '8px 10px', background: 'rgba(8,14,30,0.55)', color: '#fff', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, boxSizing: 'border-box', ...(status !== 'AWAITING_SIGNED_LINE' ? { cursor: 'not-allowed', opacity: 0.7 } : {}) }}
                />
                {signedNum > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <Row label="Signed Premium" value={money(signedPremium)} color="#60a5fa" />
                    <Row label="Signed Limit" value={money(signedLimit)} color={signedOver ? '#f87171' : '#23d18b'} />
                  </div>
                )}
                {signedOver && (
                  <div style={{ marginTop: 8, fontSize: 11, color: '#f87171' }}>
                    ⚠ Signed line cannot exceed written line ({writtenLine}%).
                  </div>
                )}
              </div>

              {status === 'AWAITING_SIGNED_LINE' && (
                <>
                  <textarea
                    rows={2}
                    value={ntuReason}
                    onChange={(e) => setNtuReason(e.target.value)}
                    placeholder="NTU reason (optional)…"
                    style={{ width: '100%', boxSizing: 'border-box', marginTop: 10, padding: '8px 10px', background: 'rgba(8,14,30,0.55)', color: 'rgba(226,232,240,0.85)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button
                      type="button"
                      onClick={handleMarkSigned}
                      disabled={!canSign}
                      style={{ flex: 2, appearance: 'none', border: '1px solid rgba(35,209,139,0.45)', background: canSign ? 'rgba(35,209,139,0.18)' : 'rgba(35,209,139,0.06)', color: '#23d18b', borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 800, cursor: canSign ? 'pointer' : 'not-allowed', opacity: canSign ? 1 : 0.5 }}
                    >✓ Mark Signed</button>
                    <button
                      type="button"
                      onClick={handleMarkNtu}
                      disabled={!canNtu}
                      style={{ flex: 1, appearance: 'none', border: '1px solid rgba(249,115,22,0.45)', background: 'rgba(249,115,22,0.08)', color: '#fb923c', borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 800, cursor: canNtu ? 'pointer' : 'not-allowed', opacity: canNtu ? 1 : 0.5 }}
                    >🚫 NTU</button>
                  </div>
                </>
              )}

              {isTerminal && (
                <div style={{ marginTop: 12, padding: 12, border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, background: 'rgba(8,14,30,0.45)', fontSize: 12, color: 'rgba(148,163,184,0.55)' }}>
                  Treaty is in a terminal state ({status}). This screen is read-only.
                </div>
              )}
            </Section>
          </div>
        </div>

        {/* Approval trail */}
        {trail.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(0,212,255,0.55)', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>Approval Trail</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {trail.map((ev, i) => {
                const reason = ev?.payload?.reason || ev?.payload?.comment || ev?.comment || null;
                const linePct = ev?.payload?.line_pct || null;
                return (
                  <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontSize: 12, color: 'rgba(226,232,240,0.85)' }}>{String(ev.event_type || '').replace(/_/g, ' ')}</span>
                        {ev.actor && <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.55)' }}>by {ev.actor}</span>}
                        {linePct && <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.55)' }}>· Line {linePct}%</span>}
                        {ev.created_at && <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.40)', marginLeft: 'auto' }}>{new Date(ev.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
                      </div>
                      {reason && <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.55)', marginTop: 2, fontStyle: 'italic' }}>"{reason}"</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </WizardLayout>
  );
}
