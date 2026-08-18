// src/screens/claims/ClaimDetailScreen.jsx
// Single-claim view: header context, current position (100% + our share),
// the immutable movement ledger, movement booking, lifecycle actions
// (close / decline / reopen), and working notes.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import { Button, Callout, Field, Input, Modal, Select, Table } from '../../components/ui';
import { ApprovalBadge } from '../../components/ledger';
import { logger } from '../../utils/logger';
import { formatWithCommasDecimal, sanitizeNumber } from '../../utils/format';

const errMsg = (e, fallback) => {
  const b = e?.body;
  if (b && typeof b === 'object' && (b.error || b.message)) return String(b.error || b.message);
  return e?.message ? String(e.message) : fallback;
};

const fmtMoney = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '–';
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
};
const fmtDate = (v) => (v ? String(v).slice(0, 10) : '–');
const fmtPct = (v) => (v == null ? '–' : `${Number(v)}%`);

const MOVEMENT_COLUMNS = [
  { key: '#' }, { key: 'Date' }, { key: 'Type' },
  { key: 'Paid @100%', num: true }, { key: 'OS @100%', num: true },
  { key: 'Incurred @100%', num: true }, { key: 'Line %', num: true },
  { key: 'Comment' }, { key: 'By' },
];

const ACTION_TITLES = {
  close: 'Close Claim', decline: 'Decline Claim', reopen: 'Reopen Claim',
  submit: 'Submit for Approval', approve: 'Approve Claim', reject: 'Reject Claim',
};

const ACTION_BLURBS = {
  reopen: 'Reopening restates the closing position (OS remains 0) — book a RESERVE_CHANGE movement afterwards to re-establish the reserve.',
  close: 'Closing books a CLOSURE movement that zeroes the outstanding reserve. Paid-to-date is preserved.',
  decline: 'Declining books a CLOSURE movement that zeroes the outstanding reserve. Paid-to-date is preserved.',
  submit: 'Submitting sends the claim for review. It is frozen — no edits, movements, or lifecycle changes — until it is approved or rejected.',
  approve: 'Approving finalises the claim as submitted.',
  reject: 'Rejecting returns the claim to the handler for revision. Give a reason so they know what to fix.',
};

function PosCard({ label, v100, vShare, ccy }) {
  return (
    <div className="cf-pos">
      <div className="cf-pos__label">{label}</div>
      <div className="cf-pos__value">
        {fmtMoney(vShare)} <span className="cf-pos__unit">{ccy || ''} our share</span>
      </div>
      <div className="cf-pos__at100">{fmtMoney(v100)} @ 100%</div>
    </div>
  );
}

const EMPTY_MV = { movement_type: 'RESERVE_CHANGE', movement_date: '', gross_paid_100: '', gross_os_100: '', comment: '' };

export default function ClaimDetailScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [claim, setClaim] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [mvOpen, setMvOpen] = useState(false);
  const [mv, setMv] = useState(EMPTY_MV);
  const [mvError, setMvError] = useState('');
  const [saving, setSaving] = useState(false);

  const [actionOpen, setActionOpen] = useState(null); // 'close' | 'decline' | 'reopen' | 'submit' | 'approve' | 'reject'
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [docFiles, setDocFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [docError, setDocError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setClaim(await api.getClaim(id)); }
    catch (e) { logger.error('claim load failed', e); setError('Failed to load claim.'); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const openMovement = () => {
    setMv({
      ...EMPTY_MV,
      gross_paid_100: claim ? String(claim.gross_paid_100 ?? '') : '',
      gross_os_100: claim ? String(claim.gross_os_100 ?? '') : '',
    });
    setMvError(''); setMvOpen(true);
  };

  const submitMovement = useCallback(async () => {
    setMvError('');
    const paid = Number(String(mv.gross_paid_100).replace(/,/g, ''));
    const os = Number(String(mv.gross_os_100).replace(/,/g, ''));
    if (!Number.isFinite(paid) || paid < 0 || !Number.isFinite(os) || os < 0) {
      setMvError('Paid and OS must be non-negative amounts.'); return;
    }
    setSaving(true);
    try {
      await api.bookClaimMovement(id, {
        movement_type: mv.movement_type,
        movement_date: mv.movement_date || undefined,
        gross_paid_100: paid, gross_os_100: os,
        comment: mv.comment || undefined,
      });
      setMvOpen(false); await load();
    } catch (e) {
      logger.error('movement failed', e);
      setMvError(errMsg(e, 'Movement booking failed.'));
    } finally { setSaving(false); }
  }, [id, mv, load]);

  const submitAction = useCallback(async () => {
    setSaving(true);
    try {
      if (actionOpen === 'close') await api.closeClaim(id, reason || undefined);
      if (actionOpen === 'decline') await api.declineClaim(id, reason || undefined);
      if (actionOpen === 'reopen') await api.reopenClaim(id, reason || undefined);
      if (actionOpen === 'submit') await api.submitClaim(id, reason || undefined);
      if (actionOpen === 'approve') await api.approveClaim(id, reason || undefined);
      if (actionOpen === 'reject') await api.rejectClaim(id, reason || undefined);
      setActionOpen(null); setReason(''); await load();
    } catch (e) {
      logger.error('claim action failed', e);
      setError(errMsg(e, 'Action failed.'));
      setActionOpen(null);
    } finally { setSaving(false); }
  }, [actionOpen, id, reason, load]);

  const submitNote = useCallback(async () => {
    if (!note.trim()) return;
    try { await api.addClaimNote(id, note.trim()); setNote(''); await load(); }
    catch (e) { logger.error('note failed', e); }
  }, [id, note, load]);

  const uploadDocs = useCallback(async () => {
    if (!docFiles.length) return;
    setUploading(true); setDocError('');
    try {
      for (const file of docFiles) {
        const fd = new FormData();
        fd.append('file', file);
        await api.uploadClaimDocument(id, fd);
      }
      setDocFiles([]);
      await load();
    } catch (e) {
      logger.error('claim doc upload failed', e);
      setDocError(errMsg(e, 'Attachment upload failed.'));
    } finally { setUploading(false); }
  }, [id, docFiles, load]);

  const deleteDoc = useCallback(async (docId, fileName) => {
    if (!window.confirm(`Delete attachment “${fileName}”?`)) return;
    try { await api.deleteClaimDocument(docId); await load(); }
    catch (e) { logger.error('claim doc delete failed', e); setDocError(errMsg(e, 'Delete failed.')); }
  }, [load]);

  const underReview = claim && claim.approval_status === 'WAITING_APPROVAL';
  const isOpen = claim && ['OPEN', 'REOPENED'].includes(claim.status) && !underReview;
  const canSubmit = claim && ['DRAFT', 'REJECTED'].includes(claim.approval_status);

  return (
    <div className="cf-screen">
      <Topbar
        title={claim ? claim.claim_ref : 'Claim'}
        subtitle={claim ? `${claim.cedant_name || ''} · ${claim.treaty_type || ''} · UW ${claim.uw_year || ''}` : ''}
        actions={(
          <div className="cf-actions">
            <Button onClick={() => navigate('/claims')}>← Register</Button>
            {canSubmit && <Button onClick={() => { setActionOpen('submit'); setReason(''); }}>Submit for Approval</Button>}
            {underReview && <Button variant="primary" onClick={() => { setActionOpen('approve'); setReason(''); }}>Approve</Button>}
            {underReview && <Button variant="danger" onClick={() => { setActionOpen('reject'); setReason(''); }}>Reject</Button>}
            {isOpen && <Button variant="primary" onClick={openMovement}>+ Movement</Button>}
            {isOpen && <Button onClick={() => { setActionOpen('close'); setReason(''); }}>Close</Button>}
            {isOpen && <Button variant="danger" onClick={() => { setActionOpen('decline'); setReason(''); }}>Decline</Button>}
            {claim && !underReview && !['OPEN', 'REOPENED'].includes(claim.status)
              && <Button onClick={() => { setActionOpen('reopen'); setReason(''); }}>Reopen</Button>}
          </div>
        )}
      />

      <div className="cf-page cf-page--narrow">
        {error && <div className="cf-error" role="alert">{error}</div>}
        {loading && <div className="cf-loading">Loading…</div>}

        {claim && underReview && (
          <Callout variant="warn" title="Waiting for approval" className="cf-banner">
            {claim.submitted_by_name ? `Submitted by ${claim.submitted_by_name}` : 'Submitted'}
            {claim.submitted_at ? ` on ${fmtDate(claim.submitted_at)}` : ''}. The claim is frozen until it is approved or rejected.
          </Callout>
        )}
        {claim && claim.approval_status === 'REJECTED' && (
          <Callout variant="danger" title="Rejected" className="cf-banner">
            {claim.reviewed_by_name ? `Rejected by ${claim.reviewed_by_name}` : 'Rejected'}
            {claim.reviewed_at ? ` on ${fmtDate(claim.reviewed_at)}` : ''}
            {claim.review_comment ? ` — “${claim.review_comment}”` : ''}. Revise and resubmit for approval.
          </Callout>
        )}
        {claim && (
          <>
            {/* Header facts */}
            <div className="cf-facts">
              {[
                ['Status', claim.status],
                ['Approval', <ApprovalBadge key="approval" status={claim.approval_status} />],
                ['Loss date', fmtDate(claim.loss_date)],
                ['Reported', fmtDate(claim.reported_date)],
                ['Loss type', claim.loss_type + (claim.cat_event_ref ? ` · ${claim.cat_event_ref}` : '')],
                ['Insured', claim.insured_name || '–'],
                ['Cedant ref', claim.cedant_claim_ref || '–'],
                ['Cause', claim.cause_of_loss || '–'],
                ['Class', claim.class_of_business || '–'],
                ['Signed line', fmtPct(claim.share_pct ?? claim.contract_signed_line_pct)],
                ['Currency', claim.currency_code || '–'],
              ].map(([k, v]) => (
                <div key={k}>
                  <div className="cf-fact__label">{k}</div>
                  <div className="cf-fact__value">{v}</div>
                </div>
              ))}
            </div>

            {claim.description && <div className="cf-desc">{claim.description}</div>}

            {/* Position */}
            <div className="cf-pos-row">
              <PosCard label="Paid" v100={claim.gross_paid_100} vShare={claim.paid_our_share} ccy={claim.currency_code} />
              <PosCard label="Outstanding" v100={claim.gross_os_100} vShare={claim.os_our_share} ccy={claim.currency_code} />
              <PosCard label="Incurred" v100={claim.gross_incurred_100} vShare={claim.incurred_our_share} ccy={claim.currency_code} />
            </div>

            {/* Movement ledger */}
            <div className="cf-section-title">Movement Ledger</div>
            <Table wrapClassName="cf-section-gap">
              <thead>
                <tr>
                  {MOVEMENT_COLUMNS.map(({ key, num }) => (
                    <th key={key} className={num ? 'cf-num' : undefined}>{key}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(claim.movements || []).map((m) => (
                  <tr key={m.movement_id}>
                    <td className="cf-cell-muted">{m.movement_no}</td>
                    <td>{fmtDate(m.movement_date)}</td>
                    <td className="cf-cell-accent">{m.movement_type}</td>
                    <td className="cf-num">{fmtMoney(m.gross_paid_100)}</td>
                    <td className="cf-num">{fmtMoney(m.gross_os_100)}</td>
                    <td className="cf-num cf-num--strong">{fmtMoney(m.gross_incurred_100)}</td>
                    <td className="cf-num cf-cell-muted">{fmtPct(m.share_pct)}</td>
                    <td className="cf-cell-clip" title={m.comment || ''}>{m.comment || ''}</td>
                    <td className="cf-cell-muted">{m.created_by_name || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>

            {/* Attachments */}
            <div className="cf-section-title">Attachments</div>
            <div className="cf-attach">
              <Input
                type="file" multiple
                className="cf-attach__input"
                onChange={(e) => setDocFiles(Array.from(e.target.files || []))}
                aria-label="Attach files to this claim"
              />
              <Button loading={uploading} onClick={uploadDocs} disabled={!docFiles.length}>
                Upload{docFiles.length ? ` (${docFiles.length})` : ''}
              </Button>
            </div>
            {docError && <div className="cf-error" role="alert">{docError}</div>}
            {(claim.documents || []).length > 0 && (
              <Table wrapClassName="cf-section-gap">
                <thead>
                  <tr>
                    {['File', 'Size', 'Uploaded', 'By', ''].map((h) => (
                      <th key={h || 'actions'}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {claim.documents.map((d) => (
                    <tr key={d.document_id}>
                      <td>
                        <a href={api.getClaimDocumentViewUrl(d.document_id)} target="_blank" rel="noreferrer" className="cf-link">
                          {d.file_name}
                        </a>
                        {d.title ? <div className="cf-cell-sub">{d.title}</div> : null}
                      </td>
                      <td className="cf-cell-muted">
                        {d.size_bytes != null ? `${(Number(d.size_bytes) / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB` : '–'}
                      </td>
                      <td>{fmtDate(d.uploaded_at)}</td>
                      <td className="cf-cell-muted">{d.uploaded_by_name || '–'}</td>
                      <td className="cf-actions-cell">
                        <a href={api.getClaimDocumentDownloadUrl(d.document_id)} className="cf-link cf-link--sm">Download</a>
                        <button type="button" className="cf-linkbtn" onClick={() => deleteDoc(d.document_id, d.file_name)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {!(claim.documents || []).length && (
              <div className="cf-attach-empty">No attachments yet — cedant advices, adjuster reports and settlement proofs live here.</div>
            )}

            {/* Notes */}
            <div className="cf-section-title">Notes</div>
            <div className="cf-notes-row">
              <div className="cf-notes-row__input">
                <Input placeholder="Add a working note…" value={note} aria-label="New note"
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }} />
              </div>
              <Button onClick={submitNote}>Add note</Button>
            </div>
            {(claim.notes || []).map((n) => (
              <div key={n.note_id} className="cf-note-item">
                <div className="cf-note-item__body">{n.note}</div>
                <div className="cf-note-item__meta">{n.created_by_name || 'Unknown'} · {fmtDate(n.created_at)}</div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Movement modal */}
      <Modal open={mvOpen} onClose={() => setMvOpen(false)} title="Book Movement"
        footer={(
          <>
            <Button onClick={() => setMvOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={submitMovement}>Book</Button>
          </>
        )}>
        <div className="cf-note-text cf-note-text--modal">
          Enter the <b className="cf-strong">cumulative</b> position at 100% as at this movement (bordereau restatement) — not the delta.
        </div>
        <div className="cf-grid2">
          <Field label="Movement type">
            <Select value={mv.movement_type} onChange={(e) => setMv((f) => ({ ...f, movement_type: e.target.value }))}>
              {['ADVICE', 'RESERVE_CHANGE', 'PAYMENT', 'RECOVERY'].map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Movement date"><Input type="date" value={mv.movement_date} onChange={(e) => setMv((f) => ({ ...f, movement_date: e.target.value }))} /></Field>
          <Field label="Cumulative paid @100%"><Input inputMode="decimal" value={formatWithCommasDecimal(mv.gross_paid_100)} onChange={(e) => setMv((f) => ({ ...f, gross_paid_100: sanitizeNumber(e.target.value) }))} /></Field>
          <Field label="Outstanding reserve @100%"><Input inputMode="decimal" value={formatWithCommasDecimal(mv.gross_os_100)} onChange={(e) => setMv((f) => ({ ...f, gross_os_100: sanitizeNumber(e.target.value) }))} /></Field>
          <div className="cf-grid-full">
            <Field label="Comment"><Input value={mv.comment} onChange={(e) => setMv((f) => ({ ...f, comment: e.target.value }))} placeholder="e.g. Interim payment per cedant SOA Q2" /></Field>
          </div>
        </div>
        {mvError && <div className="cf-error cf-error--modal" role="alert">{mvError}</div>}
      </Modal>

      {/* Close/decline/reopen confirm */}
      <Modal open={!!actionOpen} onClose={() => setActionOpen(null)}
        title={ACTION_TITLES[actionOpen] || ''}
        footer={(
          <>
            <Button onClick={() => setActionOpen(null)}>Cancel</Button>
            <Button variant={actionOpen === 'decline' || actionOpen === 'reject' ? 'danger' : 'primary'} loading={saving} onClick={submitAction}>Confirm</Button>
          </>
        )}>
        <div className="cf-note-text cf-note-text--modal">{ACTION_BLURBS[actionOpen] || ''}</div>
        <Field label={actionOpen === 'reject' ? 'Reason (recommended)' : 'Reason'}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
        </Field>
      </Modal>
    </div>
  );
}
