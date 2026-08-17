// ui/Field.jsx — label + control + hint/error with the ARIA wiring done
// once: htmlFor/id link, aria-describedby for hint + error, aria-invalid
// when an error is present. Pass exactly one form control as children.

import { Children, cloneElement, isValidElement, useId } from 'react';

export default function Field({ label, hint, error, required = false, children, className = '' }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? `${id}-error` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  const only = Children.count(children) === 1 ? Children.only(children) : null;
  const control = only && isValidElement(only)
    ? cloneElement(only, {
        id: only.props.id || id,
        'aria-describedby': only.props['aria-describedby'] || describedBy,
        'aria-invalid': error ? true : only.props['aria-invalid'],
        // Announce the requirement without setting the native `required`
        // attribute, which would hand validation to the browser's own
        // bubble UI and bypass the screens' inline error handling.
        'aria-required': required || only.props['aria-required'],
      })
    : children;

  return (
    <div className={`ui-field ${className}`.trim()}>
      <label className="ui-field__label" htmlFor={(only && only.props.id) || id}>
        {label}
        {required && <span className="ui-field__required" aria-hidden="true"> *</span>}
      </label>
      {control}
      {hint && <div className="ui-field__hint" id={hintId}>{hint}</div>}
      {error && <div className="ui-field__error" id={errorId} role="alert">{error}</div>}
    </div>
  );
}
