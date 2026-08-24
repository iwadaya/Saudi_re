// src/screens/retro/RetroHomeScreen.jsx
// Retro module home. The Retro Manager maintains the outwards retrocession
// programmes for each underwriting year — type, limits, cession and cost
// terms, the classes of business and countries each programme protects, and
// the retro pack (placement documents). Everyone else reads: the programme
// ledger plus the coverage matrix showing inwards limits by country × class
// and whether retro sits behind each cell.
//
// Writes are gated by GET /api/retro/permissions (Retro Manager or the
// executive tier) — the same predicate the server enforces, so the UI only
// renders controls the API will accept.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import { Badge, Button, Select, Table } from '../../components/ui';
import { KpiCard, fmtMoney } from '../../components/ledger';
import { errorMessage as errMsg } from '../../utils/errorBody';
import { logger } from '../../utils/logger';
import RetroProgrammeModal, { PROGRAMME_TYPES } from './components/RetroProgrammeModal';
import RetroPacksModal from './components/RetroPacksModal';
import RetroCoverageMatrix from './components/RetroCoverageMatrix';

const TYPE_LABEL = Object.fromEntries(PROGRAMME_TYPES);
const STATUS_TONE = { ACTIVE: 'success', DRAFT: 'neutral', EXPIRED: 'warn', CANCELLED: 'danger' };

const COLUMNS = [
  { key: 'Programme' }, { key: 'Type' }, { key: 'Scope' },
  { key: 'Attachment', num: true }, { key: 'Occ. Limit', num: true },
  { key: 'Cession %', num: true }, { key: 'ROL %', num: true }, { key: 'Premium', num: true },
  { key: 'Pack' }, { key: 'Status' }, { key: '' },
];

const thisYear = new Date().getFullYear();
const YEARS = Array.from({ length: 6 }, (_, i) => thisYear + 1 - i);

function ScopeTags({ all, items, allLabel }) {
  if (all) return <span className="rt-scope-tag rt-scope-tag--all">{allLabel}</span>;
  if (!items?.length) return <span className="cf-cell-muted">—</span>;
  const shown = items.slice(0, 3);
  return (
    <span className="rt-scope-tags">
      {shown.map((i) => <span key={i.name} className="rt-scope-tag">{i.name}</span>)}
      {items.length > shown.length && <span className="rt-scope-tag">+{items.length - shown.length}</span>}
    </span>
  );
}

export default function RetroHomeScreen() {
  const [year, setYear] = useState(String(thisYear));
  const [canManage, setCanManage] = useState(false);
  const [summary, setSummary] = useState(null);
  const [programmes, setProgrammes] = useState([]);
  const [coverage, setCoverage] = useState(null);
  const [classes, setClasses] = useState([]);
  const [countries, setCountries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState(null);        // {programme|null} while open
  const [packsFor, setPacksFor] = useState(null);    // programme whose pack is open

  // Static reference data + permissions — once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [perm, cobs, ctrys] = await Promise.all([
          api.getRetroPermissions().catch(() => null),
          api.listClassOfBusiness().catch(() => []),
          api.getRefListItems('country').catch(() => []),
        ]);
        if (cancelled) return;
        setCanManage(!!perm?.can_manage);
        setClasses((Array.isArray(cobs) ? cobs : []).map((c) => ({ id: c.id, name: c.name })));
        setCountries((Array.isArray(ctrys) ? ctrys : []).map((c) => ({ id: c.id, name: c.name })));
      } catch (e) { logger.error('retro ref load failed', e); }
    })();
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [s, rows, cov] = await Promise.all([
        api.getRetroSummary(year),
        api.listRetroProgrammes({ year }),
        api.getRetroCoverage(year),
      ]);
      setSummary(s);
      setProgrammes(Array.isArray(rows) ? rows : []);
      setCoverage(cov);
    } catch (e) {
      logger.error('retro load failed', e);
      setError('Failed to load the retro module. Please retry.');
    } finally { setLoading(false); }
  }, [year]);

  useEffect(() => { load(); }, [load]);

  const saveProgramme = useCallback(async (body) => {
    if (editor?.programme) await api.updateRetroProgramme(editor.programme.retro_programme_id, body);
    else await api.createRetroProgramme(body);
    await load();
  }, [editor, load]);

  const removeProgramme = useCallback(async (p) => {
    if (!window.confirm(`Delete "${p.programme_name}" (${p.uw_year})? Its retro pack is removed with it.`)) return;
    try { await api.deleteRetroProgramme(p.retro_programme_id); await load(); }
    catch (e) { setError(errMsg(e, 'Delete failed.')); }
  }, [load]);

  const money = useCallback((v, ccy) => (
    v == null || Number(v) === 0 ? '–' : <>{fmtMoney(v)} <span className="cf-ccy">{ccy || ''}</span></>
  ), []);

  const activeCells = useMemo(() => {
    const cells = coverage?.cells || [];
    const withRetro = cells.filter((c) => c.has_retro).length;
    return { total: cells.length, withRetro };
  }, [coverage]);

  return (
    <div className="cf-screen">
      <Topbar title="Retro" subtitle="Outwards retrocession programmes" />
      <div className="cf-page">

        {/* KPIs */}
        <div className="cf-kpi-row cf-kpi-row--wide">
          <KpiCard label="Active Programmes" value={summary ? summary.active : '–'} sub={summary && summary.draft ? `${summary.draft} draft` : undefined} tone="ok" />
          <KpiCard label="Occurrence Limit (Active)" value={summary ? fmtMoney(summary.active_occurrence_limit) : '–'} sub="Σ across active programmes" />
          <KpiCard label="Retro Premium (Active)" value={summary ? fmtMoney(summary.active_premium) : '–'} tone="warn" />
          <KpiCard label="Book Cells With Retro" value={coverage ? `${activeCells.withRetro} / ${activeCells.total}` : '–'} sub="country × class cells protected" tone={activeCells.withRetro < activeCells.total ? 'warn' : 'ok'} />
        </div>

        {/* Filters + actions */}
        <div className="cf-filters">
          <Select className="ui-select--auto" value={year} aria-label="Underwriting year"
            onChange={(e) => setYear(e.target.value)}>
            {YEARS.map((y) => <option key={y} value={y}>UW {y}</option>)}
          </Select>
          <Button onClick={load}>Refresh</Button>
          {canManage && (
            <Button variant="primary" onClick={() => setEditor({ programme: null })}>+ New Programme</Button>
          )}
        </div>

        {error && <div className="cf-error" role="alert">{error}</div>}

        {/* Programme ledger */}
        <div className="cf-section-gap">
          <Table>
            <thead>
              <tr>
                {COLUMNS.map(({ key, num }) => (
                  <th key={key || 'actions'} className={num ? 'cf-num' : undefined}>{key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={COLUMNS.length} className="cf-empty">Loading…</td></tr>}
              {!loading && !programmes.length && (
                <tr><td colSpan={COLUMNS.length} className="cf-empty">
                  No retro programmes for UW {year}.{canManage ? ' Create the first one with “New Programme”.' : ' The Retro Manager has not set any up yet.'}
                </td></tr>
              )}
              {!loading && programmes.map((p) => (
                <tr key={p.retro_programme_id}>
                  <td>
                    <div className="cf-cell-title">{p.programme_name}</div>
                    <div className="cf-cell-sub">{p.reinsurer || ''}</div>
                  </td>
                  <td className="cf-cell-muted">{TYPE_LABEL[p.programme_type] || p.programme_type}</td>
                  <td>
                    <div><ScopeTags all={p.covers_all_classes} items={p.classes} allLabel="All classes" /></div>
                    <div><ScopeTags all={p.covers_all_countries} items={p.countries} allLabel="All countries" /></div>
                  </td>
                  <td className="cf-num">{money(p.attachment, p.currency_code)}</td>
                  <td className="cf-num cf-num--strong">{money(p.occurrence_limit, p.currency_code)}</td>
                  <td className="cf-num">{p.cession_pct != null ? `${Number(p.cession_pct)}%` : '–'}</td>
                  <td className="cf-num">{p.rol_pct != null ? `${Number(p.rol_pct)}%` : '–'}</td>
                  <td className="cf-num">{money(p.premium, p.currency_code)}</td>
                  <td>
                    <button type="button" className="cf-linkbtn" onClick={() => setPacksFor(p)}>
                      {p.packs_count > 0 ? `${p.packs_count} file${p.packs_count === 1 ? '' : 's'}` : (canManage ? 'Add pack' : '–')}
                    </button>
                  </td>
                  <td><Badge tone={STATUS_TONE[p.status] || 'neutral'}>{p.status}</Badge></td>
                  <td className="cf-actions-cell">
                    {canManage && (<>
                      <Button size="sm" onClick={() => setEditor({ programme: p })}>Edit</Button>{' '}
                      <Button size="sm" variant="danger" onClick={() => removeProgramme(p)}>Delete</Button>
                    </>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>

        {/* Coverage matrix — the underwriter analysis */}
        <div className="cf-section-head">
          <h2 className="cf-section-title">Coverage — Limits by Country × Class</h2>
        </div>
        {loading ? <div className="cf-loading">Loading…</div> : <RetroCoverageMatrix coverage={coverage} />}
      </div>

      <RetroProgrammeModal
        open={!!editor} onClose={() => setEditor(null)} onSave={saveProgramme}
        programme={editor?.programme || null} defaultYear={year}
        classes={classes} countries={countries} />
      <RetroPacksModal
        open={!!packsFor} onClose={() => setPacksFor(null)}
        programme={packsFor} canManage={canManage} onChanged={load} />
    </div>
  );
}
