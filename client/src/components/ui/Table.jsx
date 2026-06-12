// ui/Table.jsx — the standard data table surface: horizontal-scroll
// wrapper + token-bound header/cell styling. Compose with plain
// thead/tbody/tr/th/td children so existing table markup ports 1:1.

export default function Table({ className = '', wrapClassName = '', children, ...rest }) {
  return (
    <div className={`ui-table-wrap ${wrapClassName}`.trim()}>
      <table className={`ui-table ${className}`.trim()} {...rest}>
        {children}
      </table>
    </div>
  );
}
