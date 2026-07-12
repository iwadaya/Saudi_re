// src/screens/facultative/locations/FacLocations.jsx
//
// Mirrors the Pricing_TOOL.xlsx "Sum Insured" sheet: every location has a
// Material Damage row and a Business Interruption row, each with original-
// currency SI, PML %, the SAR-converted figures, and the carrier's signed
// share (separate for MD vs BI). SI SAR and PML SAR are derived from the
// original × FX rate; the database persists every column so we don't lose
// precision on re-open.
import { useCallback, useMemo, useState, useEffect } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { useFacRiskId } from '../../../hooks/useContractId';
import { logger } from '../../../utils/logger';

const ROUTE_KEY = 'FAC_LOCATIONS';

const MAX_LOCATIONS = 50;
const WARN_LOCATIONS = 20;

const numOrNull = (v) => {
  const c = String(v ?? '').replace(/,/g, '').trim();
  if (!c) return null;
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
};
const fmtComma = (v) => {
  const n = numOrNull(v);
  if (n == null) return '';
  return Math.round(n).toLocaleString('en-US');
};
const stripCommas = (v) => String(v ?? '').replace(/,/g, '');
const fmt0 = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');

// PML / carrier shares persist as decimals 0..1; the UI shows percent.
const fracToPctStr = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 10000) / 100); // 2 dp
};
const pctStrToFrac = (s) => {
  const c = String(s ?? '').replace(/,/g, '').trim();
  if (!c) return null;
  const n = Number(c);
  return Number.isFinite(n) ? n / 100 : null;
};

function blankLocation() {
  return {
    _key: Math.random(),
    location_name: '', address: '', cresta_zone: '',
    occupancy_code: '',
    original_ccy: '', fx_to_sar: '',
    // Carrier share is captured once per location and split MD/BI on save
    // — the storage columns stay granular so a future "split-share" UI
    // can refine it without a schema change.
    carrier_share_pct: '1',
    original_pd_si: '', pd_pml_pct: '',
    original_bi_si: '', bi_pml_pct: '',
  };
}

function computeRow(r) {
  const fx = numOrNull(r.fx_to_sar) || 0;
  const pdOrg = numOrNull(r.original_pd_si) || 0;
  const biOrg = numOrNull(r.original_bi_si) || 0;
  const pdPmlPct = numOrNull(r.pd_pml_pct) || 0;
  const biPmlPct = numOrNull(r.bi_pml_pct) || 0;
  const share = numOrNull(r.carrier_share_pct) || 0;
  const pdSiSar = pdOrg * fx;
  const biSiSar = biOrg * fx;
  const pdPmlOrg = pdOrg * pdPmlPct;
  const biPmlOrg = biOrg * biPmlPct;
  const pdPmlSar = pdSiSar * pdPmlPct;
  const biPmlSar = biSiSar * biPmlPct;
  return {
    pdSiSar, biSiSar, pdPmlOrg, biPmlOrg, pdPmlSar, biPmlSar,
    pdCarrierSiOrg:  pdOrg   * share,
    pdCarrierPmlOrg: pdPmlOrg * share,
    pdCarrierSiSar:  pdSiSar  * share,
    pdCarrierPmlSar: pdPmlSar * share,
    biCarrierSiOrg:  biOrg    * share,
    biCarrierPmlOrg: biPmlOrg * share,
    biCarrierSiSar:  biSiSar  * share,
    biCarrierPmlSar: biPmlSar * share,
    totalSiSar:      pdSiSar + biSiSar,
  };
}

function FieldCell({ value, onChange, align = 'right', placeholder, width }) {
  return (
    <input className="fi" type="text" inputMode="decimal"
      style={{ textAlign: align, fontSize: 11, width: width || '100%', minWidth: 90 }}
      value={value || ''} onChange={(e) => onChange(stripCommas(e.target.value))}
      placeholder={placeholder} />
  );
}

function DerivedCell({ value, accent }) {
  return (
    <div style={{ textAlign: 'right', padding: '6px 8px', fontSize: 11, fontVariantNumeric: 'tabular-nums',
                   color: accent || 'rgba(var(--text-rgb),0.65)' }}>
      {value ? fmt0(value) : '—'}
    </div>
  );
}

const HEADERS = [
  'Particulars', 'SI ORG', 'PML %', 'PML ORG', 'SI SAR', 'PML SAR',
  'Carrier SI ORG', 'Carrier PML ORG', 'Carrier SI SAR', 'Carrier PML SAR',
];

function LocationCard({
  index, row, computed, isTopLocation, onChange, onRemove,
  currencies, canRemove,
}) {
  const set = (key, val) => onChange(index, key, val);

  // Two sub-rows mapped to MD / BI selections. All carrier columns are
  // derived from the location-level carrier_share_pct.
  const subRow = (kind) => {
    const si     = kind === 'PD' ? row.original_pd_si : row.original_bi_si;
    const pmlPct = kind === 'PD' ? row.pd_pml_pct     : row.bi_pml_pct;
    const c = computed;
    const siSar   = kind === 'PD' ? c.pdSiSar          : c.biSiSar;
    const pmlOrg  = kind === 'PD' ? c.pdPmlOrg         : c.biPmlOrg;
    const pmlSar  = kind === 'PD' ? c.pdPmlSar         : c.biPmlSar;
    const cSiOrg  = kind === 'PD' ? c.pdCarrierSiOrg   : c.biCarrierSiOrg;
    const cPmlOrg = kind === 'PD' ? c.pdCarrierPmlOrg  : c.biCarrierPmlOrg;
    const cSiSar  = kind === 'PD' ? c.pdCarrierSiSar   : c.biCarrierSiSar;
    const cPmlSar = kind === 'PD' ? c.pdCarrierPmlSar  : c.biCarrierPmlSar;

    const label = kind === 'PD' ? 'Material Damage' : 'Business Interruption';
    const accent = kind === 'PD' ? 'var(--accent-blue)' : 'var(--accent-amber)';

    return (
      <tr style={{ borderBottom: '1px solid var(--hairline)' }}>
        <td style={{ padding: '6px 8px', fontSize: 10, fontWeight: 800, letterSpacing: '.08em',
                     textTransform: 'uppercase', color: accent }}>{label}</td>
        <td style={{ padding: '4px 4px' }}>
          <FieldCell value={fmtComma(si)} onChange={(v) => set(kind === 'PD' ? 'original_pd_si' : 'original_bi_si', v)} />
        </td>
        <td style={{ padding: '4px 4px', width: 80 }}>
          <FieldCell value={fracToPctStr(pmlPct)}
            onChange={(v) => set(kind === 'PD' ? 'pd_pml_pct' : 'bi_pml_pct', pctStrToFrac(v))}
            placeholder="%" />
        </td>
        <td><DerivedCell value={pmlOrg} /></td>
        <td><DerivedCell value={siSar}  accent="rgba(var(--text-rgb),0.85)" /></td>
        <td><DerivedCell value={pmlSar} accent="rgba(var(--text-rgb),0.85)" /></td>
        <td><DerivedCell value={cSiOrg} /></td>
        <td><DerivedCell value={cPmlOrg} /></td>
        <td><DerivedCell value={cSiSar}  accent="var(--accent)" /></td>
        <td><DerivedCell value={cPmlSar} accent="var(--accent)" /></td>
      </tr>
    );
  };

  return (
    <div style={{ background: 'var(--control-bg)', border: '1px solid var(--hairline)',
                  borderRadius: 12, padding: '14px 16px', marginBottom: 12,
                  borderLeft: isTopLocation ? '3px solid var(--accent)' : '3px solid transparent' }}>
      {/* Header row: location-level fields */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.10em',
                         color: 'rgba(var(--text-rgb),0.78)' }}>LOCATION {index + 1}</span>
          {isTopLocation && (
            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                           padding: '2px 8px', borderRadius: 20,
                           background: 'rgba(var(--accent-rgb),0.10)', border: '1px solid rgba(var(--accent-rgb),0.30)',
                           color: 'var(--accent)' }}>TOP LOCATION</span>
          )}
        </div>
        {canRemove && (
          <span role="button" tabIndex={0} aria-label={`Remove location ${index + 1}`}
                style={{ cursor: 'pointer', color: 'var(--accent-rose)', fontSize: 16 }}
                onClick={() => onRemove(index)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRemove(index); }
                }}>×</span>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8, marginBottom: 12 }}>
        <input className="fi" placeholder="Name" value={row.location_name || ''}
               onChange={(e) => set('location_name', e.target.value)} style={{ fontSize: 12 }} />
        <input className="fi" placeholder="Address" value={row.address || ''}
               onChange={(e) => set('address', e.target.value)} style={{ fontSize: 12, gridColumn: 'span 2' }} />
        <input className="fi" list="fac-loc-occupancies" placeholder="Occupancy #"
               value={row.occupancy_code || ''} onChange={(e) => set('occupancy_code', e.target.value)}
               style={{ fontSize: 12 }} />
        <select className="fi" value={row.original_ccy || ''} onChange={(e) => set('original_ccy', e.target.value)}
                style={{ fontSize: 12 }}>
          <option value="">CCY</option>
          {currencies.map((c) => {
            const code = (c.currency_code || c.name || '').toUpperCase();
            return <option key={code} value={code}>{code}</option>;
          })}
        </select>
        <input className="fi" type="text" inputMode="decimal" placeholder="FX → SAR"
               value={row.fx_to_sar || ''} onChange={(e) => set('fx_to_sar', stripCommas(e.target.value))}
               style={{ fontSize: 12, textAlign: 'right' }} />
        <input className="fi" type="text" inputMode="decimal" placeholder="Carrier %"
               value={fracToPctStr(row.carrier_share_pct)}
               onChange={(e) => set('carrier_share_pct', pctStrToFrac(e.target.value))}
               style={{ fontSize: 12, textAlign: 'right' }} title="Signed share of the layer (applies to both MD and BI)" />
      </div>

      {/* Sub-table: MD and BI rows */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ background: 'var(--table-head-bg)' }}>
            {HEADERS.map((h) => (
              <th key={h} style={{ padding: '6px 6px',
                                   textAlign: h === 'Particulars' ? 'left' : 'right',
                                   fontSize: 9, fontWeight: 800, letterSpacing: '.10em',
                                   textTransform: 'uppercase', color: 'var(--muted)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {subRow('PD')}
          {subRow('BI')}
        </tbody>
      </table>
    </div>
  );
}

export default function FacLocations() {
  const riskId = useFacRiskId();
  const [rows, setRows] = useState([blankLocation()]);
  const [occupancies, setOccupancies] = useState([]);
  const [currencies, setCurrencies] = useState([]);

  // Reference data — used to populate the occupancy datalist and the
  // currency dropdown. Both are cached client-side (CACHEABLE_PATHS).
  useEffect(() => {
    Promise.all([
      api.facGetOccupancies(),
      api.getRefListItems('currency'),
    ]).then(([occ, cu]) => {
      setOccupancies(occ?.occupancies || []);
      setCurrencies(Array.isArray(cu) ? cu : cu?.items || []);
    }).catch(logger.error);
  }, []);

  const hydrate = useCallback((data) => {
    if (data?.length) {
      setRows(data.map((r) => {
        // Surface the persisted carrier shares as a single per-location
        // value. We pick the PD share when present (the BI share mirrors
        // it for risks saved by this screen); future per-MD/BI editing
        // can re-introduce the split.
        const persistedShare = r.carrier_pd_share_pct ?? r.carrier_bi_share_pct;
        return {
          _key: r.location_id || Math.random(),
          location_id: r.location_id,
          location_name: r.location_name || '', address: r.address || '',
          cresta_zone: r.cresta_zone || '',
          occupancy_code: r.occupancy_code == null ? '' : String(r.occupancy_code),
          original_ccy: r.original_ccy || '',
          fx_to_sar: r.fx_to_sar == null ? '' : String(r.fx_to_sar),
          original_pd_si: r.original_pd_si == null ? '' : String(r.original_pd_si),
          original_bi_si: r.original_bi_si == null ? '' : String(r.original_bi_si),
          pd_pml_pct: r.pd_pml_pct == null ? '' : String(r.pd_pml_pct),
          bi_pml_pct: r.bi_pml_pct == null ? '' : String(r.bi_pml_pct),
          carrier_share_pct: persistedShare == null ? '1' : String(persistedShare),
        };
      }));
    } else {
      setRows([blankLocation()]);
    }
  }, []);

  const saveLocations = useCallback(
    (id, state) => {
      // Drop fully empty rows; recompute SAR amounts so the canonical
      // pd_si / bi_si columns stay consistent with the original × FX
      // pair the user actually typed.
      const cleaned = state
        .filter((r) => r.location_name || numOrNull(r.original_pd_si) || numOrNull(r.original_bi_si))
        .map((r) => {
          const fx = numOrNull(r.fx_to_sar) || 0;
          const pdOrg = numOrNull(r.original_pd_si) || 0;
          const biOrg = numOrNull(r.original_bi_si) || 0;
          const share = numOrNull(r.carrier_share_pct);
          return {
            location_name: r.location_name || null,
            address: r.address || null,
            cresta_zone: r.cresta_zone || null,
            occupancy_code: numOrNull(r.occupancy_code),
            original_ccy: r.original_ccy ? r.original_ccy.toUpperCase() : null,
            fx_to_sar: numOrNull(r.fx_to_sar),
            original_pd_si: numOrNull(r.original_pd_si),
            original_bi_si: numOrNull(r.original_bi_si),
            pd_pml_pct: numOrNull(r.pd_pml_pct),
            bi_pml_pct: numOrNull(r.bi_pml_pct),
            // Single per-location carrier share fans out to both MD and BI
            // storage columns; the schema is granular for future use.
            carrier_pd_share_pct: share,
            carrier_bi_share_pct: share,
            pd_si: pdOrg * fx || null,
            bi_si: biOrg * fx || null,
          };
        });
      return api.facSaveLocations(id, cleaned);
    },
    [],
  );

  const { save, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetLocations,
    save: saveLocations,
    currentState: () => rows,
    onLoaded: hydrate,
    errorLabel: 'Locations',
  });

  const onChangeRow = useCallback((i, key, val) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: val } : r)));
    markDirty();
  }, [markDirty]);

  const onRemoveRow = useCallback((i) => {
    setRows((prev) => prev.filter((_, j) => j !== i));
    markDirty();
  }, [markDirty]);

  const onAddRow = useCallback(() => {
    setRows((prev) => (prev.length >= MAX_LOCATIONS ? prev : [...prev, blankLocation()]));
    markDirty();
  }, [markDirty]);

  // Compute totals + identify the top location (largest combined SAR SI).
  const { computedRows, totals, topIndex } = useMemo(() => {
    let topIdx = -1;
    let topTotal = -1;
    let pdSarSum = 0; let biSarSum = 0;
    const enriched = rows.map((r, i) => {
      const c = computeRow(r);
      pdSarSum += c.pdSiSar;
      biSarSum += c.biSiSar;
      if (c.totalSiSar > topTotal && c.totalSiSar > 0) {
        topTotal = c.totalSiSar;
        topIdx = i;
      }
      return c;
    });
    return {
      computedRows: enriched,
      totals: { pdSar: pdSarSum, biSar: biSarSum, grand: pdSarSum + biSarSum },
      topIndex: topIdx,
    };
  }, [rows]);

  const overSoftWarn = rows.length > WARN_LOCATIONS;

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Locations & SI" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '8px 0 40px' }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
          One card per location with separate Material Damage and Business Interruption rows.
          PML %, FX rate and the carrier&apos;s signed share drive the SAR columns automatically.
        </div>

        {/* Shared occupancy datalist — referenced from each card. */}
        <datalist id="fac-loc-occupancies">
          {occupancies.map((o) => (
            <option key={o.occupancy_code} value={String(o.occupancy_code)}>
              {`${o.occupancy_code} · ${o.occupancy_name}`}
            </option>
          ))}
        </datalist>

        {rows.map((r, i) => (
          <LocationCard
            key={r._key}
            index={i}
            row={r}
            computed={computedRows[i]}
            isTopLocation={i === topIndex}
            onChange={onChangeRow}
            onRemove={onRemoveRow}
            canRemove={rows.length > 1}
            currencies={currencies}
          />
        ))}

        {rows.length < MAX_LOCATIONS && (
          <button onClick={onAddRow} style={{ marginTop: 4, appearance: 'none',
            border: '1px dashed rgba(var(--accent-rgb),0.30)', background: 'rgba(var(--accent-rgb),0.05)',
            color: 'var(--accent)', borderRadius: 8, padding: '8px 16px', fontSize: 11,
            fontWeight: 700, cursor: 'pointer' }}>
            + Add Location ({rows.length} / {MAX_LOCATIONS})
          </button>
        )}
        {overSoftWarn && (
          <div style={{ marginTop: 6, fontSize: 10, color: 'rgba(var(--accent-amber-rgb),0.85)' }}>
            More than {WARN_LOCATIONS} locations — consider grouping smaller sites for performance.
          </div>
        )}

        {/* Bottom totals (SAR) */}
        <div style={{ marginTop: 20, padding: '12px 16px', background: 'rgba(var(--accent-blue-rgb),0.05)',
                       border: '1px solid rgba(var(--accent-blue-rgb),0.20)', borderRadius: 10,
                       display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em',
                          textTransform: 'uppercase', color: 'rgba(var(--accent-blue-rgb),0.75)' }}>Material Damage SAR</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--accent-blue)', marginTop: 2 }}>{fmt0(totals.pdSar)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em',
                          textTransform: 'uppercase', color: 'rgba(var(--accent-amber-rgb),0.75)' }}>Business Interruption SAR</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--accent-amber)', marginTop: 2 }}>{fmt0(totals.biSar)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em',
                          textTransform: 'uppercase', color: 'rgba(var(--accent-rgb),0.75)' }}>Grand Total SAR</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--accent)', marginTop: 2 }}>{fmt0(totals.grand)}</div>
          </div>
        </div>
      </div>
    </WizardLayout>
  );
}
