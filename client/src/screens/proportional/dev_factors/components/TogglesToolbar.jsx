// components/TogglesToolbar.jsx — the screen's toggle toolbars (Phase 4.2
// decomposition of DevFactorsScreen.jsx): triangle basis, meta/projection
// bar, view switcher and averaging method. JSX moved VERBATIM — every
// control is a real <button type="button"> (Phase-5 a11y) and the active
// states are pinned by goldenMaster.test.jsx.

/* Triangle basis toggle — persisted per treaty. Claims screens only;
   premium isn't reduced by losses. */
export function BasisToggleBar({ basis, onSetBasis, isIncurred, onShowStrippedModal }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 12px', padding: '10px 14px', borderRadius: 12, background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.30)' }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-blue)', letterSpacing: '.04em' }}>Triangle basis</span>
      <div className="toggle-group" style={{ boxShadow: '0 0 0 1px rgba(148,163,184,0.18)' }}>
        <button
          type="button"
          className={`toggle-option${basis === 'FULL' ? ' active' : ''}`}
          onClick={() => onSetBasis('FULL')}
          style={basis === 'FULL'
            ? { background: 'linear-gradient(135deg,#f59e0b,#f97316)', color: '#1a1206', fontWeight: 800, boxShadow: '0 0 16px rgba(249,115,22,0.65)', textShadow: 'none' }
            : { color: '#fbbf24', fontWeight: 700 }}
        >Full</button>
        <button
          type="button"
          className={`toggle-option${basis === 'STRIPPED' ? ' active' : ''}`}
          onClick={() => onSetBasis('STRIPPED')}
          style={basis === 'STRIPPED'
            ? { background: 'linear-gradient(135deg,#10b981,#06b6d4)', color: '#042f2a', fontWeight: 800, boxShadow: '0 0 16px rgba(16,185,129,0.65)', textShadow: 'none' }
            : { color: '#5eead4', fontWeight: 700 }}
        >Stripped of Large/Cat Losses</button>
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Stripped is the attritional basis — recommended. Saved per treaty: choosing Full uses
        the original triangle and folds large/cat into attritional (shown as nil) on the summaries.
      </span>
      {isIncurred && (
        <button
          type="button"
          onClick={onShowStrippedModal}
          style={{
            marginLeft: 'auto', fontSize: 11, fontWeight: 700, letterSpacing: '.04em',
            padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
            border: '1px solid rgba(16,185,129,0.45)', color: 'var(--accent)',
            background: 'rgba(16,185,129,0.10)', whiteSpace: 'nowrap',
          }}
        >▦ Stripped Incurred Triangle</button>
      )}
    </div>
  );
}

/* Meta bar — year window read-outs plus the projection-method toggle. */
export function MetaToolbar({ startYear, inceptionYear, numDevYears, projMethod, onSelectProjMethod }) {
  return (
    <div className="df-toprow">
      <div className="df-controls">
        <div className="df-mini"><div className="df-mini-label">Start Year</div><div className="df-mini-value">{startYear}</div></div>
        <div className="df-mini"><div className="df-mini-label">Inception Year</div><div className="df-mini-value">{inceptionYear}</div></div>
        <div className="df-mini"><div className="df-mini-label">Dev Years</div><div className="df-mini-value">{numDevYears}</div></div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="df-method">
          <div className="df-method-label">Projection</div>
          <div className="toggle-group df-method-toggle">
            <button type="button" className={`toggle-option${projMethod === 'CHAIN' ? ' active' : ''}`} onClick={() => onSelectProjMethod('CHAIN')}>Chain Ladder</button>
            <button type="button" className={`toggle-option${projMethod === 'BF' ? ' active' : ''}`} onClick={() => onSelectProjMethod('BF')}>Bornhuetter-Ferguson</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* View switcher — Dev Factors / Link Ratios / Comparison Graph. */
export function ViewToggle({ view, onSetView }) {
  return (
    <div style={{ marginBottom: 14, marginTop: 8 }}>
      <div className="toggle-group" style={{ display: 'inline-flex' }}>
        {[['DEV_FACTORS', '📊 Development Factors'], ['LINK_RATIOS', '🔗 Link Ratios'], ['GRAPH', '📈 Comparison Graph']].map(([key, label]) => (
          <button type="button" key={key} className={`toggle-option${view === key ? ' active' : ''}`} onClick={() => onSetView(key)} style={{ fontSize: 12, padding: '8px 16px' }}>{label}</button>
        ))}
      </div>
    </div>
  );
}

/* Averaging-method toggle (weighted / simple / last 3 / last 5). */
export function AvgMethodToggle({ avgMethod, onSelectAvgMethod }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
      <span style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.7)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Average</span>
      <div className="toggle-group">
        {['weighted', 'simple', 'last3', 'last5'].map(m => (
          <button type="button" key={m} className={`toggle-option${avgMethod === m ? ' active' : ''}`} onClick={() => onSelectAvgMethod(m)}>
            {m === 'weighted' ? 'Weighted' : m === 'simple' ? 'Simple' : m === 'last3' ? 'Last 3' : 'Last 5'}
          </button>
        ))}
      </div>
    </div>
  );
}
