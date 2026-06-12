// useRecommendationUndo.js — session-scoped undo for accepted AI
// recommendations (Phase 4.2).
//
// WHAT ACCEPT DOES (server): POST /fac/recommendation/:id/accept runs
// the apply-dispatch (factor / clause / cope / risk-column upsert, or a
// location / loss-history INSERT), marks the rec ACCEPTED, supersedes
// other PENDING recs on the same field, and echoes { before, after } —
// the prior value the server captured transactionally at apply time.
//
// WHAT UNDO DOES (client): there is no "unaccept" endpoint (reject only
// transitions PENDING rows), so undo restores the DATA through the same
// save APIs the wizard screens use, then marks the rec undone locally
// for the session:
//   factor.<code>        GET uw-factors → POST with the one selection
//                        reverted to the server-reported `before`
//                        (key dropped when before was null)
//   clause.<code>        POST clauses-checklist with the pre-accept
//                        { is_checked, comments } captured client-side
//                        right before accept (the accept response only
//                        echoes is_checked — comments would be lost)
//   cope.<key>           GET cope → PUT with the one column reverted
//   risk columns         GET risk → PUT with the one column reverted
//                        (original_insured ↔ insured_name mapping
//                        mirrors server/src/lib/facRecommendationApply)
//   cedant_name          server-side accept is an explicit no-op, so
//                        undo is too (status-only, marked locally)
//   location.append /    pre-accept id-set capture → GET → drop the row
//   loss_history.append  the accept inserted → PUT the remaining list
//
// Reading the CURRENT row at undo time (read-modify-write) keeps edits
// the underwriter made to other fields between accept and undo intact.
// The affordance rides the 10s "Accepted just now" flash, so entries
// only need to live for the session — they are not persisted.
import { useState, useCallback, useRef } from 'react';
import api from '../../../../api';

// Mirrors RISK_FIELD_TO_COLUMN in server/src/lib/facRecommendationApply.js.
const RISK_FIELD_TO_COLUMN = {
  original_insured: 'insured_name',
  inception_date:   'inception_date',
  expiry_date:      'expiry_date',
  occupancy_code:   'occupancy_code',
};

export function classifyTargetField(targetField) {
  if (targetField.startsWith('factor.')) return { family: 'FACTOR', code: targetField.slice('factor.'.length) };
  if (targetField.startsWith('clause.')) return { family: 'CLAUSE', code: targetField.slice('clause.'.length) };
  if (targetField.startsWith('cope.'))   return { family: 'COPE',   code: targetField.slice('cope.'.length) };
  if (targetField === 'location.append')     return { family: 'LOCATION_APPEND' };
  if (targetField === 'loss_history.append') return { family: 'LOSS_APPEND' };
  if (targetField === 'cedant_name')         return { family: 'RISK_NOOP' };
  const column = RISK_FIELD_TO_COLUMN[targetField];
  if (column) return { family: 'RISK_COLUMN', column };
  return { family: 'UNSUPPORTED' };
}

const textEq = (a, b) => String(a ?? '') === String(b ?? '');
const numEq = (a, b) => {
  const x = a == null || a === '' ? null : Number(a);
  const y = b == null || b === '' ? null : Number(b);
  if (x == null || y == null) return x == null && y == null;
  return x === y;
};

// Identify and drop the single row the accept inserted. `capture.ids`
// is the id-set snapshot taken just before the accept; when the user
// added further rows inside the undo window, fall back to matching the
// applied value's signature (the same fields the server echoes back).
function dropAppendedRow(rows, capture, idOf, matchesApplied) {
  const list = Array.isArray(rows) ? rows : [];
  const prior = new Set(capture?.ids || []);
  const added = list.filter((r) => !prior.has(idOf(r)));
  let target = null;
  if (added.length === 1) target = added[0];
  else if (added.length > 1) target = added.find(matchesApplied) || null;
  if (!target) {
    throw new Error('Undo failed — could not identify the row this acceptance added.');
  }
  return list.filter((r) => r !== target);
}

async function restoreEntry(riskId, entry) {
  const { target, before, capture, appliedValue } = entry;
  switch (target.family) {
    case 'FACTOR': {
      const cur = await api.facGetUwFactors(riskId);
      const selections = { ...(cur?.selections || {}) };
      if (before == null) delete selections[target.code];
      else selections[target.code] = before;
      await api.facSaveUwFactors(riskId, { selections, notes: cur?.notes ?? null });
      return;
    }
    case 'CLAUSE': {
      await api.facSaveClausesChecklist(riskId, {
        items: [{
          clause_code: target.code,
          is_checked:  Boolean(capture?.is_checked),
          comments:    capture?.comments ?? null,
        }],
      });
      return;
    }
    case 'COPE': {
      const cope = await api.facGetCope(riskId);
      await api.facSaveCope(riskId, { ...(cope || {}), [target.code]: before });
      return;
    }
    case 'RISK_COLUMN': {
      const risk = await api.facGetRisk(riskId);
      await api.facUpdateRisk(riskId, { ...risk, [target.column]: before });
      return;
    }
    case 'RISK_NOOP':
      // Accepting cedant_name never wrote anything (see the server
      // apply-dispatch) — undo is equally a no-op.
      return;
    case 'LOCATION_APPEND': {
      const rows = await api.facGetLocations(riskId);
      const remaining = dropAppendedRow(rows, capture, (r) => r.location_id,
        (r) => textEq(r.location_name, appliedValue?.location_name));
      await api.facSaveLocations(riskId, remaining);
      return;
    }
    case 'LOSS_APPEND': {
      const rows = await api.facGetLosses(riskId);
      const remaining = dropAppendedRow(rows, capture, (r) => r.loss_id,
        (r) => numEq(r.loss_year, appliedValue?.loss_year) && numEq(r.fgu_paid, appliedValue?.fgu_paid));
      await api.facSaveLosses(riskId, remaining);
      return;
    }
    default:
      throw new Error(`Undo is not supported for "${entry.rec.target_field}".`);
  }
}

export default function useRecommendationUndo({ riskId }) {
  // recommendation_id → { rec, target, before, capture, appliedValue, reason }.
  // Ref, not state: entries are written mid-accept and always followed by
  // a drawer reload, which re-renders with the fresh map.
  const entriesRef = useRef(new Map());
  const [undone, setUndone] = useState(() => new Set());
  const [undoing, setUndoing] = useState(() => new Set());
  const [undoErrors, setUndoErrors] = useState(() => new Map());

  /**
   * Capture whatever the accept response will NOT give us, BEFORE the
   * accept mutates the data. Never throws — a failed capture downgrades
   * to a disabled Undo button, it must not block the accept itself.
   */
  const captureBeforeAccept = useCallback(async (rec) => {
    const { family, code } = classifyTargetField(rec.target_field);
    try {
      if (family === 'CLAUSE') {
        const r = await api.facGetClausesChecklist(riskId);
        const item = (r?.items || []).find((it) => it.clause_code === code);
        return {
          kind: 'CLAUSE_ITEM',
          is_checked: Boolean(item?.is_checked),
          comments: item?.comments ?? null,
        };
      }
      if (family === 'LOCATION_APPEND') {
        const rows = await api.facGetLocations(riskId);
        return { kind: 'ID_SET', ids: (Array.isArray(rows) ? rows : []).map((row) => row.location_id) };
      }
      if (family === 'LOSS_APPEND') {
        const rows = await api.facGetLosses(riskId);
        return { kind: 'ID_SET', ids: (Array.isArray(rows) ? rows : []).map((row) => row.loss_id) };
      }
      // Remaining families: the accept response's `before` is sufficient.
      return null;
    } catch {
      return { kind: 'CAPTURE_FAILED' };
    }
  }, [riskId]);

  /** Record a successful accept so the 10s flash can offer Undo. */
  const recordAccepted = useCallback((rec, appliedValue, response, capture) => {
    const target = classifyTargetField(rec.target_field);
    const hasBefore = !!response && typeof response === 'object'
      && Object.prototype.hasOwnProperty.call(response, 'before');
    const captureFailed = capture?.kind === 'CAPTURE_FAILED';
    const needsCapture = ['CLAUSE', 'LOCATION_APPEND', 'LOSS_APPEND'].includes(target.family);
    let reason = null;
    if (target.family === 'UNSUPPORTED') {
      reason = `Undo is not supported for "${rec.target_field}".`;
    } else if (needsCapture && (captureFailed || !capture)) {
      reason = 'Undo unavailable — the prior value could not be captured before accepting.';
    } else if (['FACTOR', 'COPE', 'RISK_COLUMN'].includes(target.family) && !hasBefore) {
      reason = 'Undo unavailable — the server did not report the prior value.';
    }
    entriesRef.current.set(rec.recommendation_id, {
      rec,
      target,
      before: hasBefore ? response.before : null,
      capture: captureFailed ? null : capture,
      appliedValue,
      reason,
    });
  }, []);

  /**
   * Restore the prior value. Resolves true on success; on failure the
   * error is surfaced via getUndoState(recId).error (never throws).
   * The recommendation row itself stays ACCEPTED server-side — there is
   * no unaccept/reject-after-accept endpoint — so callers should keep
   * the local "undone" marker visible instead of expecting the reload
   * to flip the status back.
   */
  const undoAccept = useCallback(async (rec) => {
    const id = rec.recommendation_id;
    const entry = entriesRef.current.get(id);
    if (!entry || entry.reason || undone.has(id)) return false;
    setUndoing((prev) => new Set(prev).add(id));
    setUndoErrors((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    try {
      await restoreEntry(riskId, entry);
      entriesRef.current.delete(id);
      setUndone((prev) => new Set(prev).add(id));
      return true;
    } catch (e) {
      setUndoErrors((prev) => new Map(prev).set(id, e?.message || 'Undo failed.'));
      return false;
    } finally {
      setUndoing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [riskId, undone]);

  const getUndoState = useCallback((recId) => {
    const entry = entriesRef.current.get(recId);
    return {
      available: !!entry && !entry.reason && !undone.has(recId),
      reason: entry ? entry.reason : 'Undo is only available right after accepting.',
      busy: undoing.has(recId),
      done: undone.has(recId),
      error: undoErrors.get(recId) || null,
    };
  }, [undone, undoing, undoErrors]);

  return { captureBeforeAccept, recordAccepted, undoAccept, getUndoState };
}
