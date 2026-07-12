// "Pre-filled from {filename}. Review and adjust." banner.
//
// Rendered near the top of a wizard screen when the active quote was
// created from a renewal-pack import. Reads import_metadata off the
// quote payload so it works whether the wizard was reached via the
// import modal (state passed in) or via a page reload (state lost,
// metadata fetched server-side).
//
// The "Discard import" link clears the imported flag client-side and
// drops the user back to the home screen — the underwriter can decide
// whether to actually delete the draft from there. We deliberately
// don't auto-delete: a misclick shouldn't lose work.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

/**
 * @param {object} props
 * @param {string} props.quoteId               - The active draft quote id.
 * @param {object} [props.importedFromState]   - Hint passed via navigate(state) — saves a fetch.
 * @param {string} [props.importedFromState.sourceFilename]
 * @param {string} [props.importedFromState.priorTreatyId]
 */
export default function ImportedFromPackBanner({ quoteId, importedFromState }) {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);
  const [meta, setMeta] = useState(() => {
    if (!importedFromState) return null;
    return {
      sourceFilename: importedFromState.sourceFilename || 'import',
      priorTreatyId: importedFromState.priorTreatyId || null,
      warnings: [],
      unmatchedCresta: [],
    };
  });

  useEffect(() => {
    if (meta || !quoteId) return;
    let cancelled = false;
    (async () => {
      try {
        const q = await api.getQuote(quoteId);
        const im = q?.import_metadata;
        if (!im || im.source !== 'renewal_pack_import') return;
        if (cancelled) return;
        setMeta({
          sourceFilename: im.source_filename || 'import',
          priorTreatyId: im.match?.priorTreatyId || null,
          warnings: im.warnings || [],
          unmatchedCresta: im.unmatched_cresta || [],
        });
      } catch {
        /* banner is best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [meta, quoteId]);

  if (dismissed || !meta) return null;

  const warningCount = (meta.warnings?.length || 0) + (meta.unmatchedCresta?.length || 0);

  return (
    <>
      <style>{`
        .ipb {
          display: flex; align-items: center; gap: 10px;
          padding: 9px 14px; border-radius: 10px;
          background: rgba(var(--accent-rgb), .08);
          border: 1px solid rgba(var(--accent-rgb), .26);
          color: rgba(var(--text-rgb),.92);
          font-size: 12px; font-family: inherit;
          margin: 0 0 12px 0;
        }
        .ipb-icon { font-size: 14px; }
        .ipb-text { flex: 1; }
        .ipb-source { color: var(--accent); font-weight: 700; }
        .ipb-warn {
          font-size: 10px; padding: 2px 8px; border-radius: 10px;
          background: rgba(250,191,36,.14); color: var(--accent-amber);
          border: 1px solid rgba(250,191,36,.28);
          letter-spacing: .05em; text-transform: uppercase; font-weight: 700;
        }
        .ipb-act {
          background: none; border: none; padding: 4px 8px;
          font-size: 11px; cursor: pointer;
          color: rgba(var(--text-rgb),.55); text-decoration: underline;
          text-underline-offset: 2px;
        }
        .ipb-act:hover { color: rgba(var(--text-rgb),.85); }
      `}</style>
      <div className="ipb" role="status">
        <span className="ipb-icon">📥</span>
        <span className="ipb-text">
          Pre-filled from <span className="ipb-source">{meta.sourceFilename}</span>. Review and adjust before saving.
        </span>
        {warningCount > 0 && (
          <span className="ipb-warn">{warningCount} need{warningCount === 1 ? 's' : ''} review</span>
        )}
        <button className="ipb-act" onClick={() => { setDismissed(true); navigate('/'); }}>
          Discard import
        </button>
      </div>
    </>
  );
}
