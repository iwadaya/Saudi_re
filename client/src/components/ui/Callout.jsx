// ui/Callout.jsx — note/tip/warn/danger inline panels matching the
// manuals' visual language. warn/danger announce as alerts.

const DEFAULT_TITLES = { note: 'Note', tip: 'Tip', warn: 'Warning', danger: 'Danger' };

/**
 * @param {object} props
 * @param {'note'|'tip'|'warn'|'danger'} [props.variant]
 */
export default function Callout({ variant = 'note', title, className = '', children, ...rest }) {
  const role = variant === 'warn' || variant === 'danger' ? 'alert' : 'note';
  return (
    <div className={`ui-callout ui-callout--${variant} ${className}`.trim()} role={role} {...rest}>
      <div>
        <p className="ui-callout__title">{title ?? DEFAULT_TITLES[variant]}</p>
        <div>{children}</div>
      </div>
    </div>
  );
}
