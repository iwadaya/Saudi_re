// screens/retro/components/RetroPacksModal.jsx — the retro pack for one
// programme: placement slips, cover notes, security schedules. Anyone can
// view/download; upload + delete are manager-only (mirrors the server gate).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../api';
import { Button, Modal } from '../../../components/ui';
import { fmtDate } from '../../../components/ledger';
import { errorMessage as errMsg } from '../../../utils/errorBody';
import { logger } from '../../../utils/logger';

const fmtSize = (b) => {
  const n = Number(b) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

export default function RetroPacksModal({ open, onClose, programme, canManage, onChanged }) {
  const [packs, setPacks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const progId = programme?.retro_programme_id;

  const load = useCallback(async () => {
    if (!progId) return;
    setLoading(true); setError('');
    try {
      const detail = await api.getRetroProgramme(progId);
      setPacks(Array.isArray(detail?.packs) ? detail.packs : []);
    } catch (e) {
      logger.error('retro packs load failed', e);
      setError('Failed to load the retro pack.');
    } finally { setLoading(false); }
  }, [progId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      await api.uploadRetroPack(progId, form);
      await load();
      onChanged?.();
    } catch (e) {
      setError(errMsg(e, 'Upload failed.'));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (docId) => {
    if (!window.confirm('Remove this document from the retro pack?')) return;
    setBusy(true); setError('');
    try {
      await api.deleteRetroPack(docId);
      await load();
      onChanged?.();
    } catch (e) {
      setError(errMsg(e, 'Delete failed.'));
    } finally { setBusy(false); }
  };

  if (!open || !programme) return null;
  return (
    <Modal open={open} onClose={onClose} title={`Retro Pack — ${programme.programme_name}`}
      footer={<Button onClick={onClose}>Close</Button>}>
      {error && <div className="cf-error cf-error--modal" role="alert">{error}</div>}
      {loading && <div className="cf-loading">Loading…</div>}
      {!loading && !packs.length && (
        <div className="cf-empty">No documents yet. {canManage ? 'Upload the placement slip, cover notes and security schedule below.' : 'The Retro Manager has not uploaded documents for this programme.'}</div>
      )}
      {!loading && packs.map((d) => (
        <div key={d.document_id} className="rt-pack-row">
          <div className="rt-pack-main">
            <div className="rt-pack-name">{d.title || d.file_name}</div>
            <div className="rt-pack-sub">
              {d.file_name} · {fmtSize(d.size_bytes)} · {fmtDate(d.uploaded_at)}
              {d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ''}
            </div>
          </div>
          <a className="cf-link cf-link--sm" href={api.getRetroPackDownloadUrl(d.document_id)} target="_blank" rel="noreferrer">
            Download
          </a>
          {canManage && (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => remove(d.document_id)}>Remove</Button>
          )}
        </div>
      ))}
      {canManage && (
        <div className="rt-pack-upload">
          <input ref={fileRef} type="file" aria-label="Upload retro pack document"
            onChange={(e) => upload(e.target.files?.[0])} disabled={busy} />
          {busy && <span className="cf-cell-muted">Working…</span>}
        </div>
      )}
    </Modal>
  );
}
