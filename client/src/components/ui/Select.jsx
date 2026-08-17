// ui/Select.jsx — the canonical <select>. Mirrors Input's token-bound
// surface so a Field can hold either without the screen hand-rolling a
// `selStyle` object (docs/frontend-hardening.md — no inline styles in
// the screens layer).

export default function Select({ className = '', children, ...rest }) {
  return (
    <select className={`ui-select ${className}`.trim()} {...rest}>
      {children}
    </select>
  );
}
