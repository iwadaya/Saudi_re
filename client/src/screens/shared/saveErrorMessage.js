// client/src/screens/shared/saveErrorMessage.js
// (Lives under screens/shared/ so it lands in the lazy shared-screens chunk —
// its only importers are the treaty-detail screens, and app-core sits at its
// gzip budget.)
//
// Turns a rejected save (HttpError) into the message the wizard's
// SaveStateIndicator banner should show. Only 400/422 — the server telling
// the user their input is invalid — get a specific message; the caller
// throws it so WizardLayout displays it instead of the generic
// "Save failed". Transient/server faults (5xx, network) return null so
// callers keep the generic banner + Retry path, where retrying can help.
export function saveRejectionMessage(e) {
  const status = Number(e?.status);
  if (status !== 400 && status !== 422) return null;
  const fields = Array.isArray(e?.body?.fields)
    ? e.body.fields
        .slice(0, 3)
        .map((f) => (f?.path ? `${f.path}: ${f.message}` : f?.message))
        .filter(Boolean)
    : [];
  const detail = fields.join(' · ') || e?.body?.error || e?.message || 'invalid input';
  return `Save rejected — ${detail}`;
}

/** Throws the rejection message as an Error for 400/422; no-op otherwise. */
export function throwIfSaveRejection(e) {
  const msg = saveRejectionMessage(e);
  if (msg) throw new Error(msg);
}
