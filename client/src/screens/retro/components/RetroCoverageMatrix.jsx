// screens/retro/components/RetroCoverageMatrix.jsx — the underwriter view:
// inwards limits by country (rows) × class of business (columns) for the
// selected UW year, with a RETRO / NO RETRO badge per cell and the aggregate
// outwards limit protecting it. Data comes straight from GET /api/retro/coverage.
import { useMemo } from 'react';
import { fmtMoney } from '../../../components/ledger';

export default function RetroCoverageMatrix({ coverage }) {
  const { countries, classes, byKey } = useMemo(() => {
    const cells = coverage?.cells || [];
    const countryMap = new Map();
    const classMap = new Map();
    const keyed = new Map();
    for (const c of cells) {
      const ctryKey = c.country_id || 'none';
      const clsKey = c.class_of_business_id || 'none';
      if (!countryMap.has(ctryKey)) countryMap.set(ctryKey, c.country_name || 'Unassigned');
      if (!classMap.has(clsKey)) classMap.set(clsKey, c.class_name || 'Unassigned');
      keyed.set(`${ctryKey}|${clsKey}`, c);
    }
    const sortByName = (m) => [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    return { countries: sortByName(countryMap), classes: sortByName(classMap), byKey: keyed };
  }, [coverage]);

  if (!countries.length) {
    return <div className="cf-empty">No inwards treaties found for this year — the matrix populates from the underwriting book.</div>;
  }

  return (
    <>
      <div className="rt-matrix-wrap">
        <table className="rt-matrix" data-testid="retro-coverage-matrix">
          <thead>
            <tr>
              <th className="rt-matrix-country">Country \ Class</th>
              {classes.map(([id, name]) => <th key={id}>{name}</th>)}
            </tr>
          </thead>
          <tbody>
            {countries.map(([ctryId, ctryName]) => (
              <tr key={ctryId}>
                <td className="rt-matrix-country">{ctryName}</td>
                {classes.map(([clsId]) => {
                  const cell = byKey.get(`${ctryId}|${clsId}`);
                  if (!cell) return <td key={clsId}><span className="rt-cell-empty">—</span></td>;
                  const progNames = (cell.programmes || []).map((p) => p.programme_name).join(', ');
                  return (
                    <td key={clsId} title={cell.has_retro ? `Protected by: ${progNames}` : 'No retro programme covers this cell'}>
                      <span className="rt-cell-limit">{fmtMoney(cell.gross_limit_100)}</span>
                      <span className={`rt-retro-badge ${cell.has_retro ? 'rt-retro-badge--yes' : 'rt-retro-badge--no'}`}>
                        {cell.has_retro ? 'RETRO' : 'NO RETRO'}
                      </span>
                      <div className="rt-cell-sub">
                        {cell.contract_count} treat{cell.contract_count === 1 ? 'y' : 'ies'}
                        {cell.has_retro ? ` · retro limit ${fmtMoney(cell.retro_limit)}` : ''}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rt-matrix-legend">
        <span>Cell = 100% inwards limit written in that country × class.</span>
        <span><span className="rt-retro-badge rt-retro-badge--yes">RETRO</span> at least one ACTIVE programme protects the cell</span>
        <span><span className="rt-retro-badge rt-retro-badge--no">NO RETRO</span> exposed net — no outwards protection</span>
      </div>
    </>
  );
}
