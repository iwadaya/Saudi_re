// ui/Card.jsx — the standard panel surface (replaces per-screen
// glass/section divs with inline backgrounds).

export default function Card({ title, className = '', children, ...rest }) {
  return (
    <section className={`ui-card ${className}`.trim()} {...rest}>
      {title != null && <h3 className="ui-card__title">{title}</h3>}
      {children}
    </section>
  );
}
