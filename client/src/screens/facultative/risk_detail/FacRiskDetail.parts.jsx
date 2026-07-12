// components shared by FacRiskDetail and its RelatedTreatiesSection — small,
// pure presentational helpers extracted to keep the screen under the 800-line
// budget. No behaviour change.
export function FR({ label, children, hint }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, alignItems: 'center', minHeight: 40, marginBottom: 6 }}>
      <div>
        <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.55)' }}>{label}</div>
        {hint && <div style={{ fontSize: 10, color: 'rgba(var(--text-rgb),0.45)', marginTop: 1 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function SectionTitle({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(var(--accent-blue-rgb),0.75)', marginTop: 32, marginBottom: 14, paddingBottom: 8, borderBottom: '1px solid var(--hairline)' }}>{children}</div>;
}
