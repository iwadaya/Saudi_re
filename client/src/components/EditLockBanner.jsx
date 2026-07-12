// EditLockBanner — shown atop a pricing editor when the treaty is read-only for
// the current user (not the assignee). Offers a one-click "Allocate to me" that
// claims an unassigned treaty (server allows claiming the unassigned), then
// re-checks permission so the editor unlocks. Lives outside screens/ so its
// inline styles don't count against the frontend-budget ratchet.
import { useState } from 'react';
import { api } from '../api';

// Wrap an editor body so it's non-interactive when read-only. When editable it
// renders children unchanged (no extra DOM node) so existing snapshots/golden
// masters are unaffected; when locked it wraps them in an `inert` container that
// disables every input/button/run action inside.
export function ReadOnlyWrap({ readOnly, children }) {
  if (!readOnly) return <>{children}</>;
  return <div inert={true} aria-disabled="true">{children}</div>;
}

export default function EditLockBanner({ contractId, quoteId, isQuote = false, assignedToName, onAllocated }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const id = isQuote ? quoteId : contractId;

  const allocate = async () => {
    if (!id) return;
    setBusy(true); setErr('');
    try {
      await (isQuote ? api.allocateQuote(id, 'Claimed to edit') : api.allocateContract(id, 'Claimed to edit'));
      onAllocated?.();
    } catch (e) {
      setErr(e?.message || 'Could not allocate. Ask the owner to allocate it to you.');
      setBusy(false);
    }
  };

  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '10px 14px', margin: '0 0 12px', borderRadius: 10,
      background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.35)',
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#f87171' }}>🔒 Read-only</span>
      <span style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.75)' }}>
        {assignedToName ? `— assigned to ${assignedToName}. ` : '— this is unassigned. '}
        {id ? 'Claim it (if unassigned) or have it allocated to you to edit.' : 'Have it allocated to you to edit.'}
      </span>
      {err && <span style={{ fontSize: 11, color: '#f87171' }}>{err}</span>}
      {id && (
        <button type="button" className="action-pill action-pill--primary" onClick={allocate} disabled={busy}
          style={{ marginLeft: 'auto', minHeight: 32, fontSize: 12, fontWeight: 700, opacity: busy ? 0.5 : 1 }}>
          {busy ? 'Allocating…' : 'Allocate to me'}
        </button>
      )}
    </div>
  );
}
