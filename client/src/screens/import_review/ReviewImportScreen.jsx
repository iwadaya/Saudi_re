// /quotes/:id/review-import — review screen for renewal-pack imports
// that didn't match any existing treaty (mode: "new").
//
// Renders the imported wizardState in a flat, scannable layout with
// a confidence chip next to every field, a warnings panel pinned at
// the top (clickable → scrolls to the offending field), and a
// "Save & continue to wizard" CTA that just navigates into the
// existing wizard with the draft already loaded. The wizard's normal
// validation runs there — we don't duplicate it here.
//
// Reuses:
//   • the .fi input class for the rare editable cells (currently
//     read-only, but the markup pattern is consistent so a future
//     edit-in-place is one prop change away),
//   • ConfidenceChip for per-field confidence,
//   • setActiveContractId / useNavigate for routing into the wizard,
//   • the existing app-shell + Topbar shell so this screen feels
//     like any other workspace page.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import ConfidenceChip from '../../components/ConfidenceChip';
import { setActiveContractId } from '../../hooks/useContractId';

export default function ReviewImportScreen() {
  const { id: quoteId } = useParams();
  const navigate = useNavigate();
  const [quote, setQuote] = useState(null);
  const [err, setErr] = useState('');
  const fieldRefs = useRef({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const q = await api.getQuote(quoteId);
        if (cancelled) return;
        if (!q?.import_metadata) {
          setErr('This quote was not created from a renewal-pack import.');
          return;
        }
        setQuote(q);
      } catch (e) {
        if (!cancelled) setErr(e?.message || 'Failed to load quote');
      }
    })();
    return () => { cancelled = true; };
  }, [quoteId]);

  const continueToWizard = () => {
    setActiveContractId(quoteId);
    const isNp = quote?.import_metadata?.type === 'non_proportional';
    navigate(isNp ? '/np/treaty-detail' : '/prop/treaty-detail', {
      state: { contractId: quoteId, importedFromPack: true, sourceFilename: quote?.import_metadata?.source_filename },
    });
  };

  // ──────────────────────────────────────────────────────────────────────────
  if (err) {
    return (
      <div className="app-shell grid-bg">
        <Topbar title="REVIEW IMPORT" />
        <main className="workspace"><div className="container container--full">
          <div className="rvi-err">⚠ {err}</div>
        </div></main>
        <RviStyles />
      </div>
    );
  }
  if (!quote) {
    return (
      <div className="app-shell grid-bg">
        <Topbar title="REVIEW IMPORT" />
        <main className="workspace"><div className="container container--full">
          <div className="rvi-empty">Loading import…</div>
        </div></main>
        <RviStyles />
      </div>
    );
  }

  const meta = quote.import_metadata;
  const ws = meta?.wizard_state || {};
  const confidence = meta?.field_confidence || {};
  const warnings = meta?.warnings || [];
  const unmatched = meta?.unmatched_cresta || [];

  const fieldId = (path) => `rvi-field-${path.replace(/[^\w]+/g, '-')}`;
  const focusField = (path) => {
    const id = fieldId(path);
    const el = fieldRefs.current[id];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => el?.classList?.remove('rvi-flash'), 1500);
    el?.classList?.add('rvi-flash');
  };

  return (
    <div className="app-shell grid-bg">
      <Topbar title="REVIEW IMPORT" subtitle={`Source: ${meta.source_filename || '—'}`} actions={
        <button className="topbar-pill" onClick={continueToWizard}>Save &amp; continue to wizard →</button>
      } />
      <main className="workspace"><div className="container container--full">

        <WarningsPanel warnings={warnings} unmatched={unmatched} fieldConfidence={confidence} onJump={focusField} />

        <div className="rvi-grid">
          <Section title="Header">
            <Field path="header.cedant_name" label="Cedant" value={ws.header?.cedant_name} confidence={confidence['header.cedant_name']} fieldRefs={fieldRefs} fieldId={fieldId} />
            <Field path="header.contract_description" label="Treaty" value={ws.header?.contract_description} confidence={confidence['header.contract_description']} fieldRefs={fieldRefs} fieldId={fieldId} />
            <Field path="header.uw_year" label="UW Year" value={ws.header?.uw_year} confidence={confidence['header.uw_year_range']} fieldRefs={fieldRefs} fieldId={fieldId} />
            <Field path="header.classes" label="Classes" value={(ws.header?.classes_text || []).join(', ')} confidence={confidence['header.classes']} fieldRefs={fieldRefs} fieldId={fieldId} />
          </Section>

          <Section title="Detail">
            <Field path="detail.triangulations_available" label="Triangulations available" value={ws.detail?.triangulations_available ? 'Yes' : 'No'} fieldRefs={fieldRefs} fieldId={fieldId} />
            <Field path="detail.experience_start_year" label="Experience start year" value={ws.detail?.experience_start_year} fieldRefs={fieldRefs} fieldId={fieldId} />
            <Field path="detail.quota_share_epi" label="Latest earned" value={fmtNum(ws.detail?.quota_share_epi)} confidence={confidence['premium.latestEarned']} fieldRefs={fieldRefs} fieldId={fieldId} />
            <Field path="detail.growth_assumption_pct" label="Growth assumption %" value={ws.detail?.growth_assumption_pct} confidence={confidence['premium.growthAssumption']} fieldRefs={fieldRefs} fieldId={fieldId} />
            <Field path="detail.ultimate_loss_ratio_pct" label="Ultimate loss ratio %" value={ws.detail?.ultimate_loss_ratio_pct} confidence={confidence['claims.ultimateLossRatio']} fieldRefs={fieldRefs} fieldId={fieldId} />
            {ws.detail?.number_of_layers != null && (
              <Field path="detail.number_of_layers" label="Number of layers" value={ws.detail.number_of_layers} fieldRefs={fieldRefs} fieldId={fieldId} />
            )}
            {ws.detail?.est_gnpi != null && (
              <Field path="detail.est_gnpi" label="EGNPI (latest)" value={fmtNum(ws.detail.est_gnpi)} fieldRefs={fieldRefs} fieldId={fieldId} />
            )}
          </Section>

          {ws.np_structure?.layers?.length > 0 && (
            <Section title="NP layers" wide>
              <table className="rvi-tbl">
                <thead><tr>
                  <th>#</th><th>Label</th><th>Limit</th><th>Attachment</th>
                  <th>Agg Limit</th><th>EGNPI</th><th>Rate %</th><th>Reinst.</th>
                </tr></thead>
                <tbody>
                  {ws.np_structure.layers.map((l, i) => (
                    <tr key={i} ref={(el) => { if (el) fieldRefs.current[fieldId(`np_structure.layers[${i}]`)] = el; }}>
                      <td>{l.layer_number}</td>
                      <td>{l.label} <ConfidenceChip value={confidence[`np_structure.layers[${i}].layer`]} compact /></td>
                      <td>{fmtNum(l.layer_limit)} <ConfidenceChip value={confidence[`np_structure.layers[${i}].limit`]} compact /></td>
                      <td>{fmtNum(l.attachment)} <ConfidenceChip value={confidence[`np_structure.layers[${i}].attachment`]} compact /></td>
                      <td>{fmtNum(l.aggregate_limit)}</td>
                      <td>{fmtNum(l.egnpi)} <ConfidenceChip value={confidence[`np_structure.layers[${i}].egnpi`]} compact /></td>
                      <td>{l.rate}</td>
                      <td>{l.num_reinstatements}@{l.reinstatement_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {ws.egnpi_history?.length > 0 && (
            <Section title="EGNPI history">
              <table className="rvi-tbl">
                <thead><tr><th>UW Year</th><th>EGNPI</th></tr></thead>
                <tbody>
                  {ws.egnpi_history.map((r, i) => (
                    <tr key={i}><td>{r.uw_year}</td><td>{fmtNum(r.egnpi)}</td></tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {ws.triangles && (
            <Section title="Triangles" wide>
              <TrianglePreview label="Premium" tri={ws.triangles.premium} />
              <TrianglePreview label="Claims" tri={ws.triangles.claims} />
              {ws.triangles.os && <TrianglePreview label="OS" tri={ws.triangles.os} />}
            </Section>
          )}

          {ws.cresta?.zones?.length > 0 && (
            <Section title="CRESTA zones" wide>
              <table className="rvi-tbl">
                <thead><tr>
                  <th>Country</th><th>Zone</th><th>EQ</th><th>WS</th><th>Flood</th><th>SRCC</th><th>Other</th><th></th>
                </tr></thead>
                <tbody>
                  {ws.cresta.zones.map((z, i) => (
                    <tr key={i}
                      ref={(el) => { if (el) fieldRefs.current[fieldId(`cresta.zone.${z.zone_name || z.zone_id || i}`)] = el; }}
                      style={z.needsManualCrestaMatch ? { background: 'rgba(248,113,113,0.06)' } : undefined}>
                      <td>{z.country_code || '—'}</td>
                      <td>{z.zone_name || z.zone_id || '—'}</td>
                      <td>{fmtNum(z.eq_agg)}</td>
                      <td>{fmtNum(z.ws_agg)}</td>
                      <td>{fmtNum(z.flood_agg)}</td>
                      <td>{fmtNum(z.srcc_agg)}</td>
                      <td>{fmtNum(z.others_agg)}</td>
                      <td>{z.needsManualCrestaMatch ? <span className="rvi-bad">no match</span> : <span className="rvi-ok">matched</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
        </div>

        <div className="rvi-cta-row">
          <button className="rvi-btn rvi-btn--primary" onClick={continueToWizard}>Save &amp; continue to wizard →</button>
        </div>
      </div></main>
      <RviStyles />
    </div>
  );
}

// ── building blocks ──────────────────────────────────────────────────────────

function Section({ title, wide, children }) {
  return (
    <section className={`rvi-section ${wide ? 'rvi-section--wide' : ''}`}>
      <div className="rvi-section-title">{title}</div>
      <div className="rvi-section-body">{children}</div>
    </section>
  );
}

function Field({ path, label, value, confidence, fieldRefs, fieldId }) {
  return (
    <div
      className="rvi-field"
      id={fieldId(path)}
      ref={(el) => { if (el) fieldRefs.current[fieldId(path)] = el; }}
    >
      <div className="rvi-label">
        {label}
        {confidence !== undefined && <ConfidenceChip value={confidence} compact />}
      </div>
      <div className="rvi-value">{value == null || value === '' ? <span className="rvi-muted">—</span> : String(value)}</div>
    </div>
  );
}

function TrianglePreview({ label, tri }) {
  if (!tri || !tri.uwYears?.length) return null;
  const devCols = tri.devPeriods.slice(0, 6);
  return (
    <div className="rvi-tri">
      <div className="rvi-tri-label">{label}</div>
      <table className="rvi-tbl rvi-tbl--tight">
        <thead><tr>
          <th>UW</th>
          {devCols.map((d) => <th key={d}>D{d}</th>)}
          {tri.devPeriods.length > 6 && <th>…</th>}
        </tr></thead>
        <tbody>
          {tri.uwYears.slice(0, 6).map((y, i) => (
            <tr key={y}>
              <td>{y}</td>
              {devCols.map((_, j) => <td key={j}>{fmtNum(tri.values?.[i]?.[j])}</td>)}
              {tri.devPeriods.length > 6 && <td>…</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WarningsPanel({ warnings, unmatched, fieldConfidence, onJump }) {
  const lowConfidence = useMemo(() => {
    const arr = [];
    for (const [path, c] of Object.entries(fieldConfidence || {})) {
      if (c != null && c < 0.5) arr.push({ path, confidence: c });
    }
    return arr;
  }, [fieldConfidence]);

  if (!warnings.length && !unmatched.length && !lowConfidence.length) return null;

  return (
    <div className="rvi-warn-panel">
      <div className="rvi-warn-head">
        ⚠ {warnings.length + unmatched.length + lowConfidence.length} item{warnings.length + unmatched.length + lowConfidence.length === 1 ? '' : 's'} need{warnings.length + unmatched.length + lowConfidence.length === 1 ? 's' : ''} attention
      </div>
      <ul className="rvi-warn-list">
        {unmatched.length > 0 && (
          <li className="rvi-warn-row" onClick={() => onJump(`cresta.zone.${unmatched[0]}`)}>
            🌐 {unmatched.length} CRESTA zone{unmatched.length === 1 ? '' : 's'} not matched: {unmatched.slice(0, 4).join(', ')}{unmatched.length > 4 ? `, +${unmatched.length - 4}` : ''}
          </li>
        )}
        {lowConfidence.length > 0 && (
          <li className="rvi-warn-row" onClick={() => onJump(lowConfidence[0].path)}>
            🔎 {lowConfidence.length} field{lowConfidence.length === 1 ? '' : 's'} below confidence threshold (&lt; 50%)
          </li>
        )}
        {warnings.slice(0, 6).map((w, i) => (
          <li key={i} className="rvi-warn-row rvi-warn-row--text">{w}</li>
        ))}
        {warnings.length > 6 && (
          <li className="rvi-warn-row rvi-warn-row--text">…and {warnings.length - 6} more warning{warnings.length - 6 === 1 ? '' : 's'}</li>
        )}
      </ul>
    </div>
  );
}

function RviStyles() {
  return (
    <style>{`
      .rvi-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .rvi-section {
        background: rgba(8,16,40,0.45);
        border: 1px solid rgba(148,163,184,0.10);
        border-radius: 14px;
        padding: 14px 16px;
      }
      .rvi-section--wide { grid-column: 1 / -1; }
      .rvi-section-title {
        font-size: 10px; font-weight: 800; letter-spacing: .1em;
        text-transform: uppercase; color: rgba(226,232,240,0.45);
        margin-bottom: 10px;
      }
      .rvi-section-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; }
      .rvi-section--wide .rvi-section-body { display: block; }
      .rvi-field {
        display: flex; flex-direction: column; gap: 4px;
        padding: 6px 8px; border-radius: 8px;
        transition: background .2s;
      }
      .rvi-flash { background: rgba(var(--accent-rgb), 0.18) !important; }
      .rvi-label {
        font-size: 10px; font-weight: 700; letter-spacing: .08em;
        text-transform: uppercase; color: rgba(226,232,240,0.55);
        display: flex; align-items: center; gap: 6px;
      }
      .rvi-value { font-size: 13px; color: #e2e8f0; font-variant-numeric: tabular-nums; }
      .rvi-muted { color: rgba(226,232,240,0.30); font-style: italic; }
      .rvi-tbl {
        width: 100%; border-collapse: collapse; font-size: 11px;
      }
      .rvi-tbl th, .rvi-tbl td {
        padding: 6px 8px; text-align: right;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .rvi-tbl th { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: rgba(226,232,240,0.40); }
      .rvi-tbl th:first-child, .rvi-tbl td:first-child { text-align: left; }
      .rvi-tbl--tight th, .rvi-tbl--tight td { padding: 4px 6px; }
      .rvi-tri { margin-bottom: 12px; }
      .rvi-tri-label { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: rgba(226,232,240,0.5); margin-bottom: 4px; }
      .rvi-warn-panel {
        margin-bottom: 14px;
        padding: 12px 16px;
        border-radius: 12px;
        background: rgba(250, 191, 36, 0.06);
        border: 1px solid rgba(250, 191, 36, 0.28);
      }
      .rvi-warn-head { font-size: 12px; font-weight: 800; color: #fbbf24; margin-bottom: 8px; }
      .rvi-warn-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
      .rvi-warn-row {
        font-size: 11px; color: rgba(226,232,240,0.75);
        padding: 4px 0; cursor: pointer;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .rvi-warn-row:last-child { border-bottom: none; }
      .rvi-warn-row:hover { color: #fbbf24; }
      .rvi-warn-row--text { cursor: default; }
      .rvi-warn-row--text:hover { color: rgba(226,232,240,0.75); }
      .rvi-cta-row { display: flex; justify-content: flex-end; margin-top: 18px; }
      .rvi-btn {
        padding: 11px 22px; border-radius: 10px; border: none; cursor: pointer;
        font-family: inherit; font-size: 12px; font-weight: 800;
        letter-spacing: .08em; text-transform: uppercase; transition: filter .15s;
      }
      .rvi-btn--primary { background: var(--accent); color: #07120c; }
      .rvi-btn--primary:hover { filter: brightness(1.08); }
      .rvi-err { padding: 14px; border-radius: 10px; background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.28); color: #fda4a4; font-size: 13px; }
      .rvi-empty { padding: 14px; color: rgba(226,232,240,0.5); font-size: 13px; }
      .rvi-ok { color: var(--accent); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
      .rvi-bad { color: #f87171; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
    `}</style>
  );
}

function fmtNum(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  return n.toString();
}
