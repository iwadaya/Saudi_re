// HomeScreen ownership UX (extracted to keep HomeScreen under the 800-LOC
// budget). The Mine/Everyone "Everyone" list with per-row ownership + canEdit,
// allocate-to-me / allocate-to-underwriter, and the ownership-trail modal.
//
// Modals close via Escape + an explicit Close/Cancel button (no backdrop
// onClick) and rows open via an explicit Open/View button — both keep the
// onClickNonInteractive budget metric flat (no handlers on <div>s).
import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { getSession } from '../../utils/auth';
import { formatDate } from '../../utils/format';

function useEscapeKey(enabled, onEscape) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onEscape(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onEscape]);
}

/* ── Ownership trail modal (created-by → each allocation/reassignment) ── */
export function OwnershipTrailModal({ contract, onClose }) {
  const [rows, setRows] = useState(null);
  useEscapeKey(!!contract, onClose);
  useEffect(() => {
    if (!contract) { setRows(null); return undefined; }
    let cancelled = false;
    api.getAssignmentHistory(contract.id)
      .then((r) => { if (!cancelled) setRows(Array.isArray(r) ? r : []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [contract]);
  if (!contract) return null;
  const actionLabel = (a) => ({ ASSIGNED: 'Assigned', ALLOCATED: 'Allocated', SELF_ASSIGNED: 'Claimed' }[a] || a || 'Changed');
  return (
    <div className="own-modal-backdrop" role="presentation">
      <div className="own-modal glass" role="dialog" aria-modal="true" aria-label="Ownership trail">
        <div className="own-modal__title">Ownership trail — {contract.cedantName || contract.name || 'Treaty'}</div>
        <div className="own-modal__list">
          {rows == null ? <div className="own-empty">Loading…</div>
            : rows.length === 0 ? <div className="own-empty">No ownership changes recorded.</div>
            : rows.map((h, i) => (
              <div key={h.history_id || i} className="own-trail-item">
                <div>{actionLabel(h.action)} → <b>{h.to_name || '—'}</b>{h.to_role ? ` (${h.to_role})` : ''}{h.from_name ? ` · from ${h.from_name}` : ''}</div>
                <div>by {h.by_name || h.assigned_by || 'system'} · {h.assigned_at ? formatDate(h.assigned_at) : ''}{h.comment ? ` · "${h.comment}"` : ''}</div>
              </div>
            ))}
        </div>
        <div className="renew-actions"><button type="button" className="own-btn own-btn--ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/* ── Allocate-to-underwriter picker (viewable users → reassign) ── */
export function AllocatePickerModal({ open, onPick, onClose, busy }) {
  const [users, setUsers] = useState(null);
  useEscapeKey(open, onClose);
  useEffect(() => {
    if (!open) { setUsers(null); return undefined; }
    let cancelled = false;
    api.getViewableUsers()
      .then((r) => { if (!cancelled) setUsers(Array.isArray(r) ? r : []); })
      .catch(() => { if (!cancelled) setUsers([]); });
    return () => { cancelled = true; };
  }, [open]);
  if (!open) return null;
  return (
    <div className="own-modal-backdrop" role="presentation">
      <div className="own-modal glass" role="dialog" aria-modal="true" aria-label="Allocate to underwriter">
        <div className="own-modal__title">Allocate to underwriter</div>
        <div className="own-modal__list">
          {users == null ? <div className="own-empty">Loading…</div>
            : users.length === 0 ? <div className="own-empty">No users available.</div>
            : users.map((u) => (
              <button key={u.user_id} type="button" className="own-pick" disabled={busy} onClick={() => onPick(u)}>
                <span>{u.display_name}</span>
                <span className="own-badge own-badge--owner">{u.role_code}</span>
              </button>
            ))}
        </div>
        <div className="renew-actions"><button type="button" className="own-btn own-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button></div>
      </div>
    </div>
  );
}

/* ── One row in the "Everyone" ownership list ── */
export function OwnerRow({ row, onOpen, onAllocateMe, onAllocateTo, onTrail }) {
  const canEdit = row.canEdit !== false; // default editable when the flag is absent
  const assigned = row.assignedToUserId || row.assigned_to_user_id || null;
  const ownerName = row.assignedToName || null;
  const cedant = row.cedantName || row.name || 'Untitled';
  const sub = `${row.country ? row.country + ' · ' : ''}${row.uwYear || row.uw_year || '—'} · ${row.treatyType || row.treaty_type || 'Treaty'}`;
  return (
    <div className="own-row">
      <div className="own-row__main">
        <div className="own-row__title">
          {cedant}
          {ownerName && <span className="own-badge own-badge--owner">{ownerName}</span>}
          {!canEdit && <span className="own-badge own-badge--lock">🔒 Read-only</span>}
        </div>
        <div className="own-row__sub">{sub}</div>
      </div>
      <div className="own-actions">
        <button type="button" className="own-link" onClick={() => onTrail(row)}>Ownership trail</button>
        {!assigned && <button type="button" className="own-btn" onClick={() => onAllocateMe(row)}>Allocate to me</button>}
        {assigned && canEdit && <button type="button" className="own-btn own-btn--ghost" onClick={() => onAllocateTo(row)}>Allocate to underwriter</button>}
        <button type="button" className="own-btn own-btn--ghost" onClick={() => onOpen(row)}>{canEdit ? 'Open' : 'View'}</button>
      </div>
    </div>
  );
}

/* ── "Everyone" panel: scope=all list with per-row ownership + canEdit ── */
export function EveryonePanel({ onOpen }) {
  const session = getSession();
  const [rows, setRows] = useState(null);
  const [picker, setPicker] = useState(null);   // row pending reassignment
  const [trail, setTrail] = useState(null);     // row whose trail is shown
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(() => {
    api.getContractsAll({ scope: 'all' })
      .then((r) => setRows(Array.isArray(r) ? r : []))
      .catch(() => setRows([]));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const allocateMe = async (row) => {
    setBusy(true); setMsg('');
    try { await api.allocateContract(row.id, 'Claimed from Everyone view'); setMsg(`✓ ${row.cedantName || 'Treaty'} allocated to you`); refresh(); }
    catch (e) { setMsg(`✗ ${e?.message || 'Could not allocate'}`); }
    finally { setBusy(false); }
  };
  const pickUnderwriter = async (user) => {
    if (!picker) return;
    setBusy(true); setMsg('');
    try {
      await api.reassignContract(picker.id, { reassigned_by: session?.userId, new_owner_id: user.user_id, comment: 'Allocated to underwriter' });
      setMsg(`✓ Allocated to ${user.display_name}`); setPicker(null); refresh();
    } catch (e) { setMsg(`✗ ${e?.message || 'Could not allocate'}`); }
    finally { setBusy(false); }
  };

  return (
    <section className="panel glass">
      <div className="panel-head">
        <div className="panel-title">ALL TREATIES</div>
        {msg && <div className="pill-mini">{msg}</div>}
      </div>
      <div className="draft-body own-list">
        {rows == null ? <div className="own-empty">Loading…</div>
          : rows.length === 0 ? <div className="own-empty">No treaties.</div>
          : rows.map((r) => (
            <OwnerRow key={r.id} row={r} onOpen={onOpen}
              onAllocateMe={allocateMe} onAllocateTo={setPicker} onTrail={setTrail} />
          ))}
      </div>
      <AllocatePickerModal open={!!picker} busy={busy} onPick={pickUnderwriter} onClose={() => setPicker(null)} />
      <OwnershipTrailModal contract={trail} onClose={() => setTrail(null)} />
    </section>
  );
}
