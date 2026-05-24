import { useMemo, useState } from 'react';

// Advisory modal: shows the AI's suggested development quarter for each loss
// and lets the actuary apply the ones they trust. Applying only fills the
// actuarial reported date on the grid — nothing is saved until the user saves.

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.72)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const panel = {
  width: 'min(880px, 94vw)', maxHeight: '86vh', overflow: 'auto',
  background: '#0b1220', border: '1px solid rgba(148,163,184,0.25)',
  borderRadius: 14, padding: 20, color: '#e2e8f0',
};
const th = { textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', padding: '6px 8px', borderBottom: '1px solid rgba(148,163,184,0.2)' };
const td = { fontSize: 12, padding: '6px 8px', borderBottom: '1px solid rgba(148,163,184,0.08)', verticalAlign: 'top' };

const CONF_COLOR = { high: '#86efac', medium: '#fbbf24', low: 'rgba(148,163,184,0.8)' };

export default function LossQuarterSuggestModal({ suggestions = [], serverLosses = [], provider, onApply, onClose }) {
  // Default-select high/medium-confidence suggestions.
  const [selected, setSelected] = useState(() => {
    const init = {};
    for (const s of suggestions) init[s.loss_id] = s.confidence !== 'low';
    return init;
  });

  const labelById = useMemo(() => {
    const m = new Map();
    for (const l of serverLosses) {
      const id = String(l.loss_id || l.lossId || '');
      if (id) m.set(id, l.loss_name || l.insured_name || id.slice(0, 8));
    }
    return m;
  }, [serverLosses]);

  const toggle = (id) => setSelected((p) => ({ ...p, [id]: !p[id] }));
  const chosen = suggestions.filter((s) => selected[s.loss_id]);

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="AI loss-to-quarter suggestions">
      <div style={panel}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Suggested reporting quarters</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: '#e2e8f0', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
          AI-suggested development period each loss most likely entered the triangle, by matching loss
          amounts to where the triangle row jumped. Review and apply the ones you trust — this only fills
          the actuarial reported date; nothing is saved until you save the loss list.
          {provider ? ` (model: ${provider})` : ''}
        </p>

        {suggestions.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--text-muted)' }}>No suggestions returned.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 32 }}></th>
                <th style={th}>Loss</th>
                <th style={th}>UW Yr</th>
                <th style={th}>Dev (months)</th>
                <th style={th}>Reported date</th>
                <th style={th}>Confidence</th>
                <th style={th}>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => (
                <tr key={s.loss_id}>
                  <td style={td}>
                    <input type="checkbox" checked={!!selected[s.loss_id]} onChange={() => toggle(s.loss_id)} />
                  </td>
                  <td style={td}>{labelById.get(String(s.loss_id)) || String(s.loss_id).slice(0, 8)}</td>
                  <td style={td}>{s.uw_year}</td>
                  <td style={td}>{s.suggested_dev_months}</td>
                  <td style={td}>{s.suggested_reported_date}</td>
                  <td style={{ ...td, color: CONF_COLOR[s.confidence] || CONF_COLOR.low, fontWeight: 600 }}>{s.confidence}</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{s.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button type="button" onClick={onClose} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(148,163,184,0.3)', background: 'transparent', color: '#e2e8f0', cursor: 'pointer' }}>Cancel</button>
          <button
            type="button"
            disabled={chosen.length === 0}
            onClick={() => onApply(chosen)}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(56,189,248,0.5)', background: 'rgba(56,189,248,0.15)', color: '#bae6fd', cursor: chosen.length ? 'pointer' : 'not-allowed', opacity: chosen.length ? 1 : 0.5 }}
          >
            Apply {chosen.length || ''} to grid
          </button>
        </div>
      </div>
    </div>
  );
}
