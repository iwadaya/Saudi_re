// ui/Input.jsx — token-bound text + numeric inputs. NumberInput keeps
// the value as a string (screens coerce with toN at compute time — see
// the NumericLike note in types/pricing.ts) but constrains the keyboard
// and aligns digits with tabular numerals.

export function Input({ className = '', ...rest }) {
  return <input className={`ui-input ${className}`.trim()} {...rest} />;
}

export function NumberInput({ className = '', inputMode = 'decimal', ...rest }) {
  return (
    <input
      type="text"
      inputMode={inputMode}
      className={`ui-input ui-input--number ${className}`.trim()}
      {...rest}
    />
  );
}

export default Input;
