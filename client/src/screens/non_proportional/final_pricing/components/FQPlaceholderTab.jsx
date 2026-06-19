// components/FQPlaceholderTab.jsx — Centered "coming soon" card for the NP quote
// pricing workbench's not-yet-built tabs. Pure presentational: title + one line.
export default function FQPlaceholderTab({ title, line }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}>
      <div style={{ maxWidth: 480, textAlign: 'center', background: 'rgba(8,14,30,0.6)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 12, padding: '32px 28px' }}>
        <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '.06em', color: 'rgba(226,232,240,0.9)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.6)', marginTop: 8, lineHeight: 1.5 }}>{line}</div>
      </div>
    </div>
  );
}
