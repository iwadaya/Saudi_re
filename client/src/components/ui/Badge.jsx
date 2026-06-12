// ui/Badge.jsx — small status chip (offer states, staleness flags…).

/**
 * @param {object} props
 * @param {'neutral'|'success'|'info'|'warn'|'danger'} [props.tone]
 */
export default function Badge({ tone = 'neutral', className = '', children, ...rest }) {
  const toneClass = tone === 'neutral' ? '' : ` ui-badge--${tone}`;
  return (
    <span className={`ui-badge${toneClass} ${className}`.trim()} {...rest}>
      {children}
    </span>
  );
}
