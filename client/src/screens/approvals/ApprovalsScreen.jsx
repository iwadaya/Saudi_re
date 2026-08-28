import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { performLogout } from '../../utils/logout';
import { api } from '../../api';
import { useAppState } from '../../context/AppContext';
import { useGlobalToast } from '../../hooks/useToast';
import { setActiveContractId, setActiveQuoteId } from '../../hooks/useContractId';
import { getUserDisplayName } from '../../utils/auth';

export default function ApprovalsScreen() {
  const navigate = useNavigate();
  const showToast = useGlobalToast();
  const { resetFlow } = useAppState();
  const [serverPending, setServerPending] = useState([]);
  const [serverDecided, setServerDecided] = useState([]);
  const [loadingServer, setLoadingServer] = useState(true);
  const [tick, setTick] = useState(0);
  const [decisionBusy, setDecisionBusy] = useState('');
  const [declineTarget, setDeclineTarget] = useState(null);
  const [declineReason, setDeclineReason] = useState('');

  const fetchFromServer = useCallback(async () => {
    setLoadingServer(true);
    try {
      const [pendingContracts, decidedContracts, allQuotes] = await Promise.all([
        api.listContracts({ status: 'AWAITING_APPROVAL' }).catch(() => []),
        api.listContracts({ status: 'APPROVED,DECLINED,SIGNED,NTU,BOUND,AWAITING_SIGNED_LINE' }).catch(() => []),
        api.listQuotes({}).catch(() => []),
      ]);
      const toArr = r => Array.isArray(r) ? r : (r?.rows || r?.contracts || r?.quotes || []);
      const contracts = toArr(pendingContracts);
      const decided   = toArr(decidedContracts);
      const quotes    = toArr(allQuotes);

      // Quotes awaiting approval
      const pendingQuotes = quotes.filter(q =>
        ['AWAITING_APPROVAL','DISPUTE_PENDING'].includes(String(q.status || '').toUpperCase())
      ).map(q => ({ ...q, _isQuote: true }));

      // Quotes in terminal/decided states
      const decidedQuotes = quotes.filter(q =>
        ['AWAITING_SIGNED_LINE','APPROVED','SIGNED','DECLINED','NTU','BOUND'].includes(String(q.status || '').toUpperCase())
      ).map(q => ({ ...q, _isQuote: true }));

      setServerPending([...contracts, ...pendingQuotes]);
      setServerDecided([...decided, ...decidedQuotes]);
    } catch {}
    setLoadingServer(false);
  }, []);

  useEffect(() => { fetchFromServer(); }, [fetchFromServer, tick]);

  const enrich = (item) => {
    const isQuote = !!item._isQuote;
    const cid = String(item.contract_id || item.quote_id || item.id || '');
    const treatyType = item.treaty_type_name || item.treaty_type || item.treatyType || '';
    const rawCat = item.treaty_category || item.treatyCategory || '';
    // Guard against String(null) = "null" — only use if it's a real non-empty value
    const treatyCategory = rawCat && rawCat !== 'null' && rawCat !== 'NULL'
      ? String(rawCat).toUpperCase() : '';
    const isNp = isQuote
      || !!item.has_np_details
      || treatyCategory.includes('NON')
      || /XL|CAT\s*XL|NP\b|EXCESS|NON.PROP|STOP.LOSS/i.test(treatyType);
    return {
      contractId: cid,
      isQuote,
      isNp,
      product: isQuote ? 'NP QUOTE' : (isNp ? 'NP' : 'PROP'),
      title: item.name || item.cedant_name || item.cedantName || `${isQuote ? 'Quote' : 'Contract'} ${cid.slice(-6)}`,
      quoteRef: item.quote_ref || null,
      quoteVersion: item.quote_version || null,
      submittedBy: item.submitted_by || item.assigned_to_name || 'Underwriter',
      submittedAt: item.updated_at || '',
      status: item.uw_status || item.status || 'PENDING',
      linePct: item.written_line_pct || item.offer_line || null,
      decisionBy: item.decisionBy || item.decision_by || '',
      decisionComment: item.decisionComment || item.decision_comment || '',
    };
  };

  const pending = serverPending.map(enrich);
  const decided = serverDecided.map(enrich);

  const open = async (item) => {
    try {
      // Set localStorage FIRST — before resetFlow clears React state.
      // This ensures useContractId() reads the correct ID on first render
      // regardless of React batching timing.
      if (item.isQuote) {
        setActiveQuoteId(item.contractId);
        resetFlow({ quote: true, mode: 'NP' });
        navigate('/np/final-quote', { state: { contractId: item.contractId } });
      } else {
        setActiveContractId(item.contractId);
        resetFlow({ quote: false, mode: item.isNp ? 'NP' : 'PROP' });
        navigate(item.isNp ? '/np/final-pricing' : '/prop/pricing', { state: { contractId: item.contractId } });
      }
    } catch {
      showToast('Could not open this item.');
      setTick(n => n + 1);
    }
  };

  const rawId = (item) => String(item.contract_id || item.quote_id || item.id || item.contractId || '');

  // Move a row into the DECIDED column with the status the SERVER reported —
  // never a fabricated one — attributed to the authenticated user who acted.
  const moveToDecided = useCallback((item, status, reason = '') => {
    const id = item.contractId;
    const decidedAt = new Date().toISOString();
    const decidedRow = {
      ...item,
      ...(item.isQuote ? { quote_id: id } : { contract_id: id }),
      status,
      uw_status: status,
      updated_at: decidedAt,
      decisionBy: getUserDisplayName(),
      decisionComment: reason,
    };
    setServerPending(prev => prev.filter(row => rawId(row) !== id));
    setServerDecided(prev => [decidedRow, ...prev.filter(row => rawId(row) !== id)]);
  }, []);

  const approve = async (item) => {
    const key = `approve:${item.contractId}`;
    setDecisionBusy(key);
    try {
      const res = await api.markOfferApproved(item.contractId, { _actor: getUserDisplayName() }, item.isQuote ? { quote: true } : undefined);
      // The server reports where the offer actually landed: a peer approval on
      // a two-approver offer is NOT final (nextStatus stays AWAITING_APPROVAL),
      // and a split decision raises a dispute. Only a finalized decision moves
      // the row to DECIDED — with the server's status, not a hardcoded one.
      const nextStatus = String(res?.nextStatus || res?.next_status || '').toUpperCase();
      if (nextStatus === 'AWAITING_APPROVAL') {
        showToast('Approval recorded — awaiting a second approval.');
        setTick(n => n + 1);
      } else if (nextStatus === 'DISPUTE_PENDING') {
        showToast('Split decision — this offer now requires arbitration.');
        setTick(n => n + 1);
      } else {
        // Final outcome (AWAITING_SIGNED_LINE, or DECLINED when a senior split
        // resolved against approval). Older single-approver endpoints return no
        // nextStatus — an accepted approval there means awaiting signed line.
        moveToDecided(item, nextStatus || 'AWAITING_SIGNED_LINE');
      }
    } catch (e) {
      showToast(`Approval failed: ${e?.message || 'Server error'}`);
    } finally {
      setDecisionBusy('');
    }
  };

  const confirmDecline = async () => {
    if (!declineTarget) return;
    const reason = declineReason.trim();
    if (!reason) {
      showToast('Enter a decline reason.');
      return;
    }
    const item = declineTarget;
    const key = `decline:${item.contractId}`;
    setDecisionBusy(key);
    try {
      const actorName = getUserDisplayName();
      await api.declineContract(item.contractId, reason, item.isQuote ? { quote: true, body: { reason, _actor: actorName } } : { body: { reason, _actor: actorName } });
      moveToDecided(item, 'DECLINED', reason);
      setDeclineTarget(null);
      setDeclineReason('');
    } catch (e) {
      showToast(`Decline failed: ${e?.message || 'Server error'}`);
    } finally {
      setDecisionBusy('');
    }
  };

  const statusColor = (s) => ({
    DISPUTE_PENDING: '#a78bfa',
    AWAITING_APPROVAL: '#fbbf24',
    AWAITING_SIGNED_LINE: '#60a5fa',
    APPROVED: '#4ade80', BOUND: '#4ade80',
    DECLINED: '#f87171', SIGNED: '#4ade80', NTU: '#fb923c',
  }[s] || '#94a3b8');

  const statusLabel = (s) => ({
    DISPUTE_PENDING: '⚖ Dispute Pending',
    AWAITING_APPROVAL: 'Awaiting Approval',
    AWAITING_SIGNED_LINE: 'Awaiting Signed Line',
    APPROVED: 'Approved', BOUND: 'Approved',
    DECLINED: 'Declined', SIGNED: 'Signed', NTU: 'NTU',
  }[s] || (s || '').replace(/_/g, ' '));

  return (
    <div className="CU_APPROVALS">
      <div className="topbar">
        <div className="topbar-left">
          <div className="topbar-title">Chief Underwriter Approvals</div>
          <div className="topbar-sub muted">Review offers, approve or decline</div>
        </div>
        <div className="topbar-right">
          <button className="topbar-pill" onClick={() => setTick(n => n + 1)}>⟳ Refresh</button>
          <button className="topbar-pill" onClick={async () => { await performLogout(); navigate('/login'); }}>Log out</button>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel glass">
          <div className="panel-head">
            <div className="panel-title">PENDING</div>
            <div className="pill-mini" style={pending.length > 0 ? { background: 'rgba(251,191,36,0.20)', color: '#fbbf24' } : {}}>
              {pending.length}
            </div>
          </div>
          <div className="panel-body approvals-list">
            {loadingServer && pending.length === 0 && <div className="muted" style={{fontSize:13}}>Loading…</div>}
            {!loadingServer && pending.length === 0 && <div className="muted">No pending approvals.</div>}
            {pending.map(x => (
              <div key={x.contractId} className="approval-row" role="button" tabIndex={0}
                onClick={() => open(x)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(x); }
                }}
                style={{ cursor: 'pointer', borderLeft: '3px solid rgba(251,191,36,0.50)', paddingLeft: 12 }}>
                <div className="approval-main">
                  <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <div className="approval-title" style={{ fontWeight: 700, fontSize: 14 }}>{x.title}</div>
                    {x.isQuote && x.quoteRef && (
                      <span style={{ fontSize:9, padding:'1px 6px', borderRadius:10, background:'rgba(251,191,36,0.10)', border:'1px solid rgba(251,191,36,0.30)', color:'#fbbf24', fontWeight:700, flexShrink:0 }}>
                        {x.quoteRef}{x.quoteVersion > 1 ? ` v${x.quoteVersion}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="approval-meta muted" style={{ marginTop: 3 }}>
                    {x.product} · Submitted by <b style={{ color: 'rgba(255,255,255,0.70)' }}>{x.submittedBy}</b>
                    {x.linePct ? ` · Line ${x.linePct}%` : ''}
                    {x.submittedAt ? ` · ${x.submittedAt.slice(0, 16).replace('T', ' ')}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <div className="approval-pill" style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.30)' }}>
                    {statusLabel(x.status)}
                  </div>
                  <button
                    type="button"
                    className="topbar-pill"
                    disabled={decisionBusy === `approve:${x.contractId}`}
                    onClick={(e) => { e.stopPropagation(); approve(x); }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="topbar-pill"
                    disabled={decisionBusy === `decline:${x.contractId}`}
                    onClick={(e) => { e.stopPropagation(); setDeclineTarget(x); setDeclineReason(''); }}
                  >
                    Decline
                  </button>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>Review →</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel glass">
          <div className="panel-head">
            <div className="panel-title">DECIDED</div>
            <div className="pill-mini">{decided.length}</div>
          </div>
          <div className="panel-body approvals-list">
            {loadingServer && decided.length === 0 && <div className="muted" style={{fontSize:13}}>Loading…</div>}
            {!loadingServer && decided.length === 0 && <div className="muted">No decisions yet.</div>}
            {decided.slice(0, 20).map(x => (
              <div key={x.contractId} className="approval-row approval-row--decided" role="button" tabIndex={0}
                onClick={() => open(x)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(x); }
                }}
                style={{ cursor: 'pointer', borderLeft: `3px solid ${statusColor(x.status)}50`, paddingLeft: 12 }}>
                <div className="approval-main">
                  <div className="approval-title" style={{ fontWeight: 700, fontSize: 14 }}>{x.title}</div>
                  <div className="approval-meta muted" style={{ marginTop: 3 }}>
                    {x.product}{x.decisionBy ? ` · ${x.decisionBy}` : ''}{x.linePct ? ` · Line ${x.linePct}%` : ''}
                  </div>
                  {x.decisionComment && <div className="approval-comment" style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 3, fontStyle: 'italic' }}>"{x.decisionComment}"</div>}
                </div>
                <div className="approval-pill" style={{ background: `${statusColor(x.status)}18`, color: statusColor(x.status), border: `1px solid ${statusColor(x.status)}40`, flexShrink: 0 }}>
                  {statusLabel(x.status)}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      {declineTarget && (
        <div
          className="modal-backdrop"
          // Backdrop dismissal is a pointer-only convenience; keyboard users
          // close via the labelled ✕ button in the dialog header.
          role="presentation"
          style={{ position:'fixed', inset:0, background:'rgba(2,6,23,0.72)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}
          onClick={(e) => { if (e.target === e.currentTarget) setDeclineTarget(null); }}
        >
          <div
            className="panel glass"
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-decline-title"
            style={{ width:'min(460px, calc(100vw - 32px))', padding:18 }}
          >
            <div className="modal-title" style={{ padding:0, marginBottom:8, borderBottom:0 }}>
              <span id="approval-decline-title" className="panel-title">Decline Offer</span>
              <button type="button" className="modal-close" onClick={() => setDeclineTarget(null)} aria-label="Close">✕</button>
            </div>
            <textarea
              className="fi"
              aria-label="Decline reason"
              value={declineReason}
              onChange={e => setDeclineReason(e.target.value)}
              placeholder="Reason for decline"
              rows={4}
              style={{ width:'100%', minHeight:96, resize:'vertical' }}
            />
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:12 }}>
              <button type="button" className="topbar-pill" onClick={() => setDeclineTarget(null)}>Cancel</button>
              <button type="button" className="topbar-pill" onClick={confirmDecline} disabled={decisionBusy === `decline:${declineTarget.contractId}`}>Confirm Decline</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
