// src/screens/claims/ClaimDetailScreen.jsx
// Single-claim view: header context, current position (100% + our share),
// the immutable movement ledger, movement booking, lifecycle actions
// (close / decline / reopen), and working notes.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import { Button, Field, Input, Modal } from '../../components/ui';
import { logger } from '../../utils/logger';
import { ApprovalPill } from './ClaimsHomeScreen';

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

function PosCard({ label, v100, vShare, ccy }) {
  return (
    <div style={{
      flex: '1 1 200px', minWidth: 200, padding: '16px 18px', borderRadius: 14,
      background: 'var(--surface-2)', border: '1px solid rgba(var(--accent-rgb),0.18)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>{fmtMoney(vShare)} <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{ccy || ''} our share</span></div>
      <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginTop: 4 }}>{fmtMoney(v100)} @ 100%</div>
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
    <div style={{ minHeight: '100vh', background: 'var(--bg0)', fontFamily: 'var(--font-sans)' }}>
      <Topbar
        title={claim ? claim.claim_ref : 'Claim'}
        subtitle={claim ? `${claim.cedant_name || ''} · ${claim.treaty_type || ''} · UW ${claim.uw_year || ''}` : ''}
        actions={(
          <div style={{ display: 'flex', gap: 8 }}>
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

      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '24px 20px' }}>
        {error && <div style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {loading && <div style={{ color: 'var(--text-subtle)', padding: 24 }}>Loading…</div>}

        {claim && underReview && (
          <div style={{
            padding: '10px 14px', borderRadius: 10, marginBottom: 14, fontSize: 12.5,
            background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.35)', color: '#fbbf24',
          }}>
            Waiting for approval{claim.submitted_by_name ? ` — submitted by ${claim.submitted_by_name}` : ''}{claim.submitted_at ? ` on ${fmtDate(claim.submitted_at)}` : ''}. The claim is frozen until it is approved or rejected.
          </div>
        )}
        {claim && claim.approval_status === 'REJECTED' && (
          <div style={{
            padding: '10px 14px', borderRadius: 10, marginBottom: 14, fontSize: 12.5,
            background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.35)', color: '#f87171',
          }}>
            Rejected{claim.reviewed_by_name ? ` by ${claim.reviewed_by_name}` : ''}{claim.reviewed_at ? ` on ${fmtDate(claim.reviewed_at)}` : ''}{claim.review_comment ? ` — “${claim.review_comment}”` : ''}. Revise and resubmit for approval.
          </div>
        )}
        {claim && (
          <>
            {/* Header facts */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12,
              padding: '16px 18px', borderRadius: 14, marginBottom: 18,
              background: 'var(--surface-2)', border: '1px solid rgba(var(--accent-rgb),0.14)',
              fontSize: 12.5,
            }}>
              {[
                ['Status', claim.status],
                ['Approval', <ApprovalPill key="approval" status={claim.approval_status} />],
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
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 3 }}>{k}</div>
                  <div style={{ color: 'var(--text)', fontWeight: 600 }}>{v}</div>
                </div>
              ))}
            </div>

            {claim.description && (
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 18, padding: '0 4px' }}>{claim.description}</div>
            )}

            {/* Position */}
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 24 }}>
              <PosCard label="Paid" v100={claim.gross_paid_100} vShare={claim.paid_our_share} ccy={claim.currency_code} />
              <PosCard label="Outstanding" v100={claim.gross_os_100} vShare={claim.os_our_share} ccy={claim.currency_code} />
              <PosCard label="Incurred" v100={claim.gross_incurred_100} vShare={claim.incurred_our_share} ccy={claim.currency_code} />
            </div>

            {/* Movement ledger */}
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 8 }}>Movement Ledger</div>
            <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(var(--accent-rgb),0.14)', marginBottom: 26 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                    {['#', 'Date', 'Type', 'Paid @100%', 'OS @100%', 'Incurred @100%', 'Line %', 'Comment', 'By'].map((h, i) => (
                      <th key={h} style={{ padding: '9px 12px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-subtle)', textAlign: i >= 3 && i <= 6 ? 'right' : 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(claim.movements || []).map((m) => (
                    <tr key={m.movement_id} style={{ borderTop: '1px solid rgba(var(--accent-rgb),0.08)' }}>
                      <td style={{ padding: '9px 12px', color: 'var(--text-subtle)' }}>{m.movement_no}</td>
                      <td style={{ padding: '9px 12px', color: 'var(--text)' }}>{fmtDate(m.movement_date)}</td>
                      <td style={{ padding: '9px 12px', fontWeight: 700, color: 'var(--accent)' }}>{m.movement_type}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney(m.gross_paid_100)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney(m.gross_os_100)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--text)' }}>{fmtMoney(m.gross_incurred_100)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: 'var(--text-subtle)' }}>{fmtPct(m.share_pct)}</td>
                      <td style={{ padding: '9px 12px', color: 'var(--text-subtle)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.comment || ''}>{m.comment || ''}</td>
                      <td style={{ padding: '9px 12px', color: 'var(--text-subtle)' }}>{m.created_by_name || '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Attachments */}
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 8 }}>Attachments</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="file" multiple
                onChange={(e) => setDocFiles(Array.from(e.target.files || []))}
                style={{
                  flex: 1, minWidth: 240, background: 'var(--surface-2)', color: 'var(--text)',
                  border: '1px solid rgba(var(--accent-rgb),0.25)', borderRadius: 8,
                  padding: '7px 10px', fontSize: 12.5, fontFamily: 'var(--font-sans)',
                }}
                aria-label="Attach files to this claim"
              />
              <Button loading={uploading} onClick={uploadDocs} disabled={!docFiles.length}>
                Upload{docFiles.length ? ` (${docFiles.length})` : ''}
              </Button>
            </div>
            {docError && <div style={{ color: '#f87171', fontSize: 12.5, marginBottom: 10 }}>{docError}</div>}
            {(claim.documents || []).length > 0 && (
              <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(var(--accent-rgb),0.14)', marginBottom: 26 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                      {['File', 'Size', 'Uploaded', 'By', ''].map((h) => (
                        <th key={h || 'actions'} style={{ padding: '9px 12px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-subtle)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {claim.documents.map((d) => (
                      <tr key={d.document_id} style={{ borderTop: '1px solid rgba(var(--accent-rgb),0.08)' }}>
                        <td style={{ padding: '9px 12px' }}>
                          <a href={api.getClaimDocumentViewUrl(d.document_id)} target="_blank" rel="noreferrer"
                            style={{ color: 'var(--accent)', fontWeight: 700, textDecoration: 'none' }}>
                            {d.file_name}
                          </a>
                          {d.title ? <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{d.title}</div> : null}
                        </td>
                        <td style={{ padding: '9px 12px', color: 'var(--text-subtle)' }}>
                          {d.size_bytes != null ? `${(Number(d.size_bytes) / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB` : '–'}
                        </td>
                        <td style={{ padding: '9px 12px', color: 'var(--text)' }}>{fmtDate(d.uploaded_at)}</td>
                        <td style={{ padding: '9px 12px', color: 'var(--text-subtle)' }}>{d.uploaded_by_name || '–'}</td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <a href={api.getClaimDocumentDownloadUrl(d.document_id)}
                            style={{ color: 'var(--accent)', fontSize: 12, marginRight: 12, textDecoration: 'none' }}>Download</a>
                          <button
                            onClick={() => deleteDoc(d.document_id, d.file_name)}
                            style={{ background: 'none', border: 'none', color: '#f87171', fontSize: 12, cursor: 'pointer', padding: 0, fontFamily: 'var(--font-sans)' }}
                          >Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!(claim.documents || []).length && (
              <div style={{ fontSize: 12.5, color: 'var(--text-subtle)', marginBottom: 26 }}>No attachments yet — cedant advices, adjuster reports and settlement proofs live here.</div>
            )}

            {/* Notes */}
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 8 }}>Notes</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <Input placeholder="Add a working note…" value={note} onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }} />
              </div>
              <Button onClick={submitNote}>Add note</Button>
            </div>
            {(claim.notes || []).map((n) => (
              <div key={n.note_id} style={{
                padding: '10px 14px', borderRadius: 10, marginBottom: 8, fontSize: 12.5,
                background: 'var(--surface-2)', border: '1px solid rgba(var(--accent-rgb),0.10)',
              }}>
                <div style={{ color: 'var(--text)' }}>{n.note}</div>
                <div style={{ color: 'var(--text-subtle)', fontSize: 10.5, marginTop: 4 }}>{n.created_by_name || 'Unknown'} · {fmtDate(n.created_at)}</div>
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
        <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginBottom: 12, lineHeight: 1.55 }}>
          Enter the <b>cumulative</b> position at 100% as at this movement (bordereau restatement) — not the delta.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Movement type">
            <select value={mv.movement_type} onChange={(e) => setMv((f) => ({ ...f, movement_type: e.target.value }))}
              style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid rgba(var(--accent-rgb),0.25)', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, width: '100%' }}>
              {['ADVICE', 'RESERVE_CHANGE', 'PAYMENT', 'RECOVERY'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Movement date"><Input type="date" value={mv.movement_date} onChange={(e) => setMv((f) => ({ ...f, movement_date: e.target.value }))} /></Field>
          <Field label="Cumulative paid @100%"><Input inputMode="numeric" value={mv.gross_paid_100} onChange={(e) => setMv((f) => ({ ...f, gross_paid_100: e.target.value }))} /></Field>
          <Field label="Outstanding reserve @100%"><Input inputMode="numeric" value={mv.gross_os_100} onChange={(e) => setMv((f) => ({ ...f, gross_os_100: e.target.value }))} /></Field>
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Comment"><Input value={mv.comment} onChange={(e) => setMv((f) => ({ ...f, comment: e.target.value }))} placeholder="e.g. Interim payment per cedant SOA Q2" /></Field>
          </div>
        </div>
        {mvError && <div style={{ color: '#f87171', fontSize: 12.5, marginTop: 12 }}>{mvError}</div>}
      </Modal>

      {/* Close/decline/reopen confirm */}
      <Modal open={!!actionOpen} onClose={() => setActionOpen(null)}
        title={{
          close: 'Close Claim', decline: 'Decline Claim', reopen: 'Reopen Claim',
          submit: 'Submit for Approval', approve: 'Approve Claim', reject: 'Reject Claim',
        }[actionOpen] || ''}
        footer={(
          <>
            <Button onClick={() => setActionOpen(null)}>Cancel</Button>
            <Button variant={actionOpen === 'decline' || actionOpen === 'reject' ? 'danger' : 'primary'} loading={saving} onClick={submitAction}>Confirm</Button>
          </>
        )}>
        <div style={{ fontSize: 12.5, color: 'var(--text-subtle)', marginBottom: 12, lineHeight: 1.55 }}>
          {{
            reopen: 'Reopening restates the closing position (OS remains 0) — book a RESERVE_CHANGE movement afterwards to re-establish the reserve.',
            close: 'Closing books a CLOSURE movement that zeroes the outstanding reserve. Paid-to-date is preserved.',
            decline: 'Declining books a CLOSURE movement that zeroes the outstanding reserve. Paid-to-date is preserved.',
            submit: 'Submitting sends the claim for review. It is frozen — no edits, movements, or lifecycle changes — until it is approved or rejected.',
            approve: 'Approving finalises the claim as submitted.',
            reject: 'Rejecting returns the claim to the handler for revision. Give a reason so they know what to fix.',
          }[actionOpen] || ''}
        </div>
        <Field label={actionOpen === 'reject' ? 'Reason (recommended)' : 'Reason'}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
        </Field>
      </Modal>
    </div>
  );
}
