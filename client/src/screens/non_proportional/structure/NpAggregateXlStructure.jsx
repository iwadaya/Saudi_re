// src/screens/non_proportional/structure/NpAggregateXlStructure.jsx
//
// Aggregate XL-specific structure: layer table priced in absolute
// aggregate amounts (not loss ratios), plus two policy-shape toggles
// (Franchise Deductible, Structured Deal) and a Class-of-Business
// inner-limits table. Used on the Structure screen when the treaty
// type is "Aggregate XL", and rendered read-only on Final Pricing.
//
// State lives in AppContext slice `npAggregateXlInputs`:
//   {
//     franchiseDeductible: boolean,
//     structuredDeal:      boolean,
//     layers:              [{ aggregateLimit, aggregateDeductible,
//                             deductible, aad, risk, cat }],
//     classesOfBusiness:   { [cobName]: { innerLimit, innerDeductible } },
//   }
//
// Layer count comes from npTreatyDetail.numberOfLayers (default 1).
// COB rows are seeded from npTreatyDetail.lineOfBusinessLabels — the
// Treaty Detail screen owns which classes are in scope; the user
// edits inner limits per class here.

import { useCallback, useMemo } from 'react';
import { useAppState } from '../../../context/AppContext';

const SLICE_KEY = 'npAggregateXlInputs';

const DEFAULT_LAYER = {
  aggregateLimit: '',
  aggregateDeductible: '',
  deductible: '',
  aad: '',
  risk: false,
  cat: false,
};

function fmtMoney(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
}
function stripNum(v) {
  return String(v ?? '').replace(/[^\d.-]/g, '');
}

export default function NpAggregateXlStructure({ currency = 'SAR', readOnly = false }) {
  const { state: appState, setSlice } = useAppState();
  const npDetail = appState.npTreatyDetail || {};
  const stored = appState[SLICE_KEY];

  const franchiseDeductible = !!stored?.franchiseDeductible;
  const structuredDeal = !!stored?.structuredDeal;

  // Layer count from Treaty Detail; cap at 20 to match the Risk XL flow.
  const layerCount = useMemo(() => {
    const n = parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '1', 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 1;
  }, [npDetail.numberOfLayers, npDetail.number_of_layers]);

  const layers = useMemo(() => {
    const saved = Array.isArray(stored?.layers) ? stored.layers : [];
    const out = [];
    for (let i = 0; i < layerCount; i++) {
      out.push(saved[i] ? { ...DEFAULT_LAYER, ...saved[i] } : { ...DEFAULT_LAYER });
    }
    return out;
  }, [stored?.layers, layerCount]);

  // COB names come from Treaty Detail. lineOfBusinessLabels is the
  // canonical display list (kept in sync with classIds on Treaty Detail);
  // the snake-case alias from the wire is tolerated too.
  const cobNames = useMemo(() => {
    const labels = npDetail.lineOfBusinessLabels
      ?? npDetail.line_of_business_labels
      ?? [];
    return Array.isArray(labels) ? labels.filter(Boolean) : [];
  }, [npDetail.lineOfBusinessLabels, npDetail.line_of_business_labels]);

  // Inner limits keyed by COB name so adding / removing classes on
  // Treaty Detail keeps existing limits aligned to the right class.
  // Tolerates the legacy array-based shape from earlier builds.
  const cobLimitsMap = useMemo(() => {
    const m = stored?.classesOfBusiness;
    if (Array.isArray(m)) {
      const out = {};
      for (const row of m) {
        if (row?.classOfBusiness) {
          out[row.classOfBusiness] = {
            innerLimit: row.innerLimit ?? '',
            innerDeductible: row.innerDeductible ?? '',
          };
        }
      }
      return out;
    }
    return (m && typeof m === 'object') ? m : {};
  }, [stored?.classesOfBusiness]);

  const setToggle = useCallback(
    (key, value) => {
      setSlice(SLICE_KEY, { [key]: value });
    },
    [setSlice],
  );

  const updateLayer = useCallback(
    (i, patch) => {
      const next = layers.map((l, idx) => (idx === i ? { ...l, ...patch } : { ...l }));
      setSlice(SLICE_KEY, { layers: next });
    },
    [layers, setSlice],
  );

  const updateCobLimit = useCallback(
    (cobName, patch) => {
      const next = {
        ...cobLimitsMap,
        [cobName]: { ...(cobLimitsMap[cobName] || {}), ...patch },
      };
      setSlice(SLICE_KEY, { classesOfBusiness: next });
    },
    [cobLimitsMap, setSlice],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Policy-shape toggles ── */}
      <section className="np-struct-card glass" style={{ marginBottom: 16 }}>
        <div className="np-struct-card-header">
          <div className="np-struct-card-title">AGGREGATE XL · POLICY SHAPE</div>
          {readOnly && <div className="np-struct-card-actions"><span className="np-tag">Read-Only</span></div>}
        </div>
        <div style={{ display: 'flex', gap: 24, padding: '14px 22px', flexWrap: 'wrap' }}>
          <Toggle
            label="Franchise Deductible"
            hint="Deductible disappears once a loss breaches it (no offset)"
            checked={franchiseDeductible}
            disabled={readOnly}
            onChange={(v) => setToggle('franchiseDeductible', v)}
          />
          <Toggle
            label="Structured Deal"
            hint="Multi-year or commutation-linked structure"
            checked={structuredDeal}
            disabled={readOnly}
            onChange={(v) => setToggle('structuredDeal', v)}
          />
        </div>
      </section>

      {/* ── Layer table ── */}
      <section className="np-struct-card glass" style={{ marginBottom: 16 }}>
        <div className="np-struct-card-header">
          <div className="np-struct-card-title">AGGREGATE XL STRUCTURE · By Layer</div>
          <div className="np-struct-card-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {readOnly && <span className="np-tag">Read-Only</span>}
            <span className="np-tag">{layerCount} layer{layerCount === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div className="np-table-wrap np-table-wrap--scroll">
          <table className="np-struct-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <colgroup>
              <col style={{ width: 60 }} />
              <col />
              <col />
              <col />
              <col />
              <col style={{ width: 60 }} />
              <col style={{ width: 60 }} />
            </colgroup>
            <thead>
              <tr>
                <th className="np-table-sticky cell-center">LAYER</th>
                <th className="np-col">AGGREGATE LIMIT ({currency})</th>
                <th className="np-col">AGGREGATE DEDUCTIBLE ({currency})</th>
                <th className="np-col">DEDUCTIBLE ({currency})</th>
                <th className="np-col">AAD ({currency})</th>
                <th className="np-col-chk cell-center">RISK</th>
                <th className="np-col-chk cell-center">CAT</th>
              </tr>
            </thead>
            <tbody>
              {layers.map((l, i) => (
                <tr key={i}>
                  <th className="np-table-sticky cell-center">L{i + 1}</th>
                  <MoneyCell value={l.aggregateLimit} currency={currency} readOnly={readOnly}
                    onChange={(v) => updateLayer(i, { aggregateLimit: v })} />
                  <MoneyCell value={l.aggregateDeductible} currency={currency} readOnly={readOnly}
                    onChange={(v) => updateLayer(i, { aggregateDeductible: v })} />
                  <MoneyCell value={l.deductible} currency={currency} readOnly={readOnly}
                    onChange={(v) => updateLayer(i, { deductible: v })} />
                  <MoneyCell value={l.aad} currency={currency} readOnly={readOnly}
                    onChange={(v) => updateLayer(i, { aad: v })} />
                  <td className="np-col-chk cell-center">
                    <input type="checkbox" className="np-check" checked={!!l.risk}
                      disabled={readOnly}
                      onChange={(e) => updateLayer(i, { risk: e.target.checked })} />
                  </td>
                  <td className="np-col-chk cell-center">
                    <input type="checkbox" className="np-check" checked={!!l.cat}
                      disabled={readOnly}
                      onChange={(e) => updateLayer(i, { cat: e.target.checked })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '10px 16px 14px', fontSize: 11, color: 'rgba(148,163,184,0.55)', lineHeight: 1.5 }}>
          Number of layers comes from Treaty Detail. Aggregate Limit
          /&nbsp;Deductible apply to the annual aggregate; Deductible and
          AAD apply per-loss.
        </div>
      </section>

      {/* ── Class of Business · Inner Limits ── */}
      <section className="np-struct-card glass" style={{ marginBottom: 16 }}>
        <div className="np-struct-card-header">
          <div className="np-struct-card-title">CLASS OF BUSINESS · Inner Limits</div>
          <div className="np-struct-card-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {readOnly && <span className="np-tag">Read-Only</span>}
            <span className="np-tag">{cobNames.length} class{cobNames.length === 1 ? '' : 'es'}</span>
          </div>
        </div>
        {cobNames.length === 0 ? (
          <div style={{ padding: '18px 22px', fontSize: 12, color: 'rgba(148,163,184,0.65)' }}>
            No classes of business selected on Treaty Detail — pick at
            least one class there to set inner limits here.
          </div>
        ) : (
          <div className="np-table-wrap np-table-wrap--scroll">
            <table className="np-struct-table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col style={{ width: '40%' }} />
                <col style={{ width: '30%' }} />
                <col style={{ width: '30%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="np-table-sticky">CLASS OF BUSINESS</th>
                  <th className="np-col">INNER LIMIT ({currency})</th>
                  <th className="np-col">INNER DEDUCTIBLE ({currency})</th>
                </tr>
              </thead>
              <tbody>
                {cobNames.map((name) => {
                  const limit = cobLimitsMap[name] || {};
                  return (
                    <tr key={name}>
                      <td
                        className="np-table-sticky"
                        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={name}
                      >
                        <span style={{ padding: '0 10px', color: 'rgba(226,232,240,0.85)', fontWeight: 600, fontSize: 12 }}>
                          {name}
                        </span>
                      </td>
                      <MoneyCell value={limit.innerLimit} currency={currency} readOnly={readOnly}
                        onChange={(v) => updateCobLimit(name, { innerLimit: v })} />
                      <MoneyCell value={limit.innerDeductible} currency={currency} readOnly={readOnly}
                        onChange={(v) => updateCobLimit(name, { innerDeductible: v })} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: '10px 16px 14px', fontSize: 11, color: 'rgba(148,163,184,0.55)', lineHeight: 1.5 }}>
          Classes come from Treaty Detail. Inner Limit / Inner Deductible
          cap or floor an individual class inside the aggregate cover —
          leave blank if a class has no inner sublimit.
        </div>
      </section>
    </>
  );
}

// ── Inline helpers ──────────────────────────────────────────────────────────

function Toggle({ label, hint, checked, disabled, onChange }) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        cursor: disabled ? 'default' : 'pointer',
        userSelect: 'none',
        opacity: disabled ? 0.85 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: '#00d4ff', width: 16, height: 16 }}
      />
      <span>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(226,232,240,0.90)' }}>{label}</span>
        {hint && (
          <span style={{ marginLeft: 8, fontSize: 11, color: 'rgba(148,163,184,0.55)' }}>· {hint}</span>
        )}
      </span>
    </label>
  );
}

function MoneyCell({ value, currency, readOnly, onChange }) {
  const display = fmtMoney(value);
  return (
    <td className="np-col">
      {readOnly ? (
        <div className="np-cell-input">
          <input
            className="np-mini-input np-mini-input--center np-mini-input--readonly"
            readOnly
            value={display}
            placeholder="—"
          />
          <span className="np-sfx">{currency}</span>
        </div>
      ) : (
        <div className="np-cell-input">
          <input
            className="np-mini-input np-mini-input--center"
            value={display}
            onChange={(e) => onChange(stripNum(e.target.value))}
            placeholder="—"
          />
          <span className="np-sfx">{currency}</span>
        </div>
      )}
    </td>
  );
}
