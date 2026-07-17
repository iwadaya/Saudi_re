// src/screens/claims/PlaSection.jsx
// PLA (Preliminary Loss Advice) section of the claims home screen: KPIs,
// filterable PLA register, New/Edit PLA modal, and the convert-to-claim and
// close/reopen flows. PLAs are logged against SIGNED/BOUND treaties before a
// formal claim exists; converting one books the claim with the estimate as
// its opening OS reserve.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Badge, Button, Field, Input, Modal, Table } from '../../components/ui';
import { logger } from '../../utils/logger';
import { formatWithCommasDecimal, sanitizeNumber } from '../../utils/format';
import './claims.css';

const errMsg = (e, fallback) => {
  const b = e?.body;
  if (b && typeof b === 'object' && (b.error || b.message)) return String(b.error || b.message);
  return e?.message ? String(e.message) : fallback;
};

const fmtMoney = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '–';
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
};
const fmtDate = (v) => (v ? String(v).slice(0, 10) : '–');
const dateInput = (v) => (v ? String(v).slice(0, 10) : '');
const parseAmt = (v) => Number(String(v ?? '').replace(/,/g, ''));

const PLA_STATUS_TONE = { PENDING: 'info', CONVERTED: 'success', CLOSED: 'neutral' };

function KpiCard({ label, value, sub, tone }) {
  return (
    <div className={`pla-kpi${tone ? ` pla-kpi--${tone}` : ''}`}>
      <div className="pla-kpi__label">{label}</div>
      <div className="pla-kpi__value">{value}</div>
      <div className="pla-kpi__sub">{sub || ''}</div>
    </div>
  );
}

const EMPTY_FORM = {
  contract_id: '', loss_date: '', advice_date: '', insured_name: '',
  cedant_claim_ref: '', cause_of_loss: '', description: '',
  loss_type: 'ATTRITIONAL', cat_event_ref: '', estimated_gross_loss_100: '0',
};
const EMPTY_CONVERT = { reported_date: '', gross_paid_100: '0', gross_os_100: '', comment: '' };

/** Short human label for a treaty in the picker. */
const treatyLabel = (c) => {
  const bits = [c.cedant_name || 'Unnamed', c.treaty_type || 'Treaty', `UW ${c.uw_year}`];
  if (c.alt_contract_id) bits.push(c.alt_contract_id);
  if (c.signed_line_pct != null) bits.push(`line ${Number(c.signed_line_pct)}%`);
  return bits.join(' · ');
};

// createNonce: increment it in the parent to open the New PLA modal (the
// Topbar "+ New PLA" button lives in ClaimsHomeScreen, the modal lives here).
export default function PlaSection({ createNonce = 0 }) {
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [plas, setPlas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [statusFilter, setStatusFilter] = useState('');
  const [lossTypeFilter, setLossTypeFilter] = useState('');
  const [search, setSearch] = useState('');

  // Create / edit modal ('create' | pla row being edited | null).
  const [editorOpen, setEditorOpen] = useState(null);
  const [contracts, setContracts] = useState([]);
  const [treatySearch, setTreatySearch] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState('');

  // Convert modal (pla row | null) and close/reopen confirm.
  const [convertPla, setConvertPla] = useState(null);
  const [convert, setConvert] = useState(EMPTY_CONVERT);
  const [convertError, setConvertError] = useState('');
  const [actionPla, setActionPla] = useState(null); // { pla, kind: 'close' | 'reopen' }
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [s, p] = await Promise.all([
        api.getPlasSummary(),
        api.listPlas({
          status: statusFilter || undefined,
          lossType: lossTypeFilter || undefined,
          q: search || undefined,
        }),
      ]);
      setSummary(s);
      setPlas(Array.isArray(p) ? p : []);
    } catch (e) {
      logger.error('PLA load failed', e);
      setError('Failed to load PLAs. Please retry.');
    } finally { setLoading(false); }
  }, [statusFilter, lossTypeFilter, search]);

  useEffect(() => { load(); }, [load]);

  const openEditor = useCallback(async (pla) => {
    setEditorError('');
    setTreatySearch('');
    if (pla) {
      setForm({
        contract_id: pla.contract_id,
        loss_date: dateInput(pla.loss_date),
        advice_date: dateInput(pla.advice_date),
        insured_name: pla.insured_name || '',
        cedant_claim_ref: pla.cedant_claim_ref || '',
        cause_of_loss: pla.cause_of_loss || '',
        description: pla.description || '',
        loss_type: pla.loss_type || 'ATTRITIONAL',
        cat_event_ref: pla.cat_event_ref || '',
        estimated_gross_loss_100: String(pla.estimated_gross_loss_100 ?? '0'),
      });
      setEditorOpen(pla);
    } else {
      setForm(EMPTY_FORM);
      setEditorOpen('create');
      try {
        const rows = await api.getClaimsEligibleContracts();
        setContracts(Array.isArray(rows) ? rows : []);
      } catch (e) {
        logger.error('eligible contracts load failed', e);
        setEditorError('Could not load signed treaties.');
      }
    }
  }, []);

  // Parent bumps createNonce when its "+ New PLA" Topbar button is clicked.
  useEffect(() => { if (createNonce > 0) openEditor(null); }, [createNonce, openEditor]);

  const eligibleTreaties = useMemo(() => {
    const needle = treatySearch.trim().toLowerCase();
    if (!needle) return contracts;
    return contracts.filter((c) => {
      const hay = [c.contract_id, c.alt_contract_id, c.contract_description, c.cedant_name, c.treaty_type, c.country_name]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }, [contracts, treatySearch]);

  const selectedTreaty = useMemo(
    () => contracts.find((c) => c.contract_id === form.contract_id) || null,
    [contracts, form.contract_id],
  );

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  const submitEditor = useCallback(async () => {
    setEditorError('');
    const isCreate = editorOpen === 'create';
    if (isCreate && !form.contract_id) { setEditorError('Select the treaty the PLA attaches to.'); return; }
    if (!form.loss_date) { setEditorError('Loss date is required.'); return; }
    const est = parseAmt(form.estimated_gross_loss_100);
    if (!Number.isFinite(est) || est < 0) { setEditorError('Estimated gross loss must be a non-negative amount.'); return; }
    setSaving(true);
    try {
      const body = {
        loss_date: form.loss_date,
        advice_date: form.advice_date || undefined,
        insured_name: form.insured_name || undefined,
        cedant_claim_ref: form.cedant_claim_ref || undefined,
        cause_of_loss: form.cause_of_loss || undefined,
        description: form.description || undefined,
        loss_type: form.loss_type,
        cat_event_ref: form.loss_type === 'CAT' ? (form.cat_event_ref || undefined) : undefined,
        estimated_gross_loss_100: est,
      };
      if (isCreate) await api.createPla({ ...body, contract_id: form.contract_id });
      else await api.updatePla(editorOpen.pla_id, body);
      setEditorOpen(null);
      await load();
    } catch (e) {
      logger.error('PLA save failed', e);
      setEditorError(errMsg(e, 'Saving the PLA failed.'));
    } finally { setSaving(false); }
  }, [editorOpen, form, load]);

  const openConvert = useCallback((pla) => {
    setConvert({ ...EMPTY_CONVERT, gross_os_100: String(pla.estimated_gross_loss_100 ?? '0') });
    setConvertError('');
    setConvertPla(pla);
  }, []);

  const submitConvert = useCallback(async () => {
    setConvertError('');
    const paid = parseAmt(convert.gross_paid_100);
    const os = parseAmt(convert.gross_os_100);
    if (!Number.isFinite(paid) || paid < 0 || !Number.isFinite(os) || os < 0) {
      setConvertError('Opening paid and OS must be non-negative amounts.'); return;
    }
    setSaving(true);
    try {
      const out = await api.convertPla(convertPla.pla_id, {
        reported_date: convert.reported_date || undefined,
        gross_paid_100: paid,
        gross_os_100: os,
        comment: convert.comment || undefined,
      });
      setConvertPla(null);
      navigate(`/claims/${out.claim_id}`);
    } catch (e) {
      logger.error('PLA convert failed', e);
      setConvertError(errMsg(e, 'Converting the PLA failed.'));
    } finally { setSaving(false); }
  }, [convertPla, convert, navigate]);

  const submitAction = useCallback(async () => {
    if (!actionPla) return;
    setSaving(true);
    try {
      if (actionPla.kind === 'close') await api.closePla(actionPla.pla.pla_id, reason || undefined);
      else await api.reopenPla(actionPla.pla.pla_id, reason || undefined);
      setActionPla(null); setReason('');
      await load();
    } catch (e) {
      logger.error('PLA action failed', e);
      setError(errMsg(e, 'Action failed.'));
      setActionPla(null);
    } finally { setSaving(false); }
  }, [actionPla, reason, load]);

  const line = selectedTreaty?.signed_line_pct != null ? Number(selectedTreaty.signed_line_pct) : null;
  const est = parseAmt(form.estimated_gross_loss_100) || 0;

  return (
    <>
      {/* KPIs */}
      <div className="pla-kpis">
        <KpiCard label="Pending PLAs" value={summary ? summary.pending_plas : '–'} tone="info" sub={summary ? `${summary.total_plas} logged in total` : ''} />
        <KpiCard label="Pending Estimate @100%" value={summary ? fmtMoney(summary.pending_estimated_100) : '–'} sub="cedant-advised gross" />
        <KpiCard label="Pending Estimate (our share)" value={summary ? fmtMoney(summary.pending_estimated_our_share) : '–'} sub="at signed lines" />
        <KpiCard label="Converted to Claims" value={summary ? summary.converted_plas : '–'} tone="success" />
        <KpiCard label="Closed w/o Claim" value={summary ? summary.closed_plas : '–'} tone="muted" />
      </div>

      {/* Filters */}
      <div className="pla-filters">
        <select className="pla-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter PLAs by status">
          <option value="">All statuses</option>
          {['PENDING', 'CONVERTED', 'CLOSED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="pla-select" value={lossTypeFilter} onChange={(e) => setLossTypeFilter(e.target.value)} aria-label="Filter PLAs by loss type">
          <option value="">All loss types</option>
          {['ATTRITIONAL', 'LARGE', 'CAT'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="pla-filters__search">
          <Input placeholder="Search ref / insured / cedant…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
        </div>
        <Button onClick={load}>Refresh</Button>
      </div>

      {error && <div className="pla-load-error">{error}</div>}

      {/* PLA register */}
      <Table className="pla-table">
        <thead>
          <tr>
            <th>PLA Ref</th>
            <th>Cedant / Treaty</th>
            <th>Insured</th>
            <th>Loss Date</th>
            <th>Advised</th>
            <th>Type</th>
            <th>Status</th>
            <th className="pla-num">Estimate 100%</th>
            <th className="pla-num">Estimate (our)</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={10} className="pla-empty">Loading…</td></tr>
          )}
          {!loading && !plas.length && (
            <tr><td colSpan={10} className="pla-empty">No PLAs logged. Record the first advice with “+ New PLA”.</td></tr>
          )}
          {!loading && plas.map((p) => (
            <tr key={p.pla_id}>
              <td>
                {p.status === 'PENDING'
                  ? <button type="button" className="pla-ref-btn" onClick={() => openEditor(p)} title="Open to view or edit">{p.pla_ref}</button>
                  : <span className="pla-strong">{p.pla_ref}</span>}
              </td>
              <td>
                <div className="pla-cell-main">{p.cedant_name || '–'}</div>
                <div className="pla-cell-sub">{p.treaty_type || ''} · UW {p.uw_year || '–'}</div>
              </td>
              <td>{p.insured_name || '–'}</td>
              <td>{fmtDate(p.loss_date)}</td>
              <td>{fmtDate(p.advice_date)}</td>
              <td>{p.loss_type}</td>
              <td>
                <Badge tone={PLA_STATUS_TONE[p.status] || 'neutral'}>{p.status}</Badge>
                {p.status === 'CONVERTED' && p.converted_claim_id && (
                  <button type="button" className="pla-linkbtn pla-linkbtn--claim"
                    onClick={() => navigate(`/claims/${p.converted_claim_id}`)}>
                    {p.converted_claim_ref || 'View claim'} →
                  </button>
                )}
              </td>
              <td className="pla-num">{fmtMoney(p.estimated_gross_loss_100)} <span className="pla-ccy">{p.currency_code || ''}</span></td>
              <td className="pla-num pla-strong">{fmtMoney(p.estimated_our_share)}</td>
              <td className="pla-num pla-actions">
                {p.status === 'PENDING' && (
                  <>
                    <button type="button" className="pla-linkbtn" onClick={() => openConvert(p)}>Convert to claim</button>
                    <button type="button" className="pla-linkbtn pla-linkbtn--muted" onClick={() => { setActionPla({ pla: p, kind: 'close' }); setReason(''); }}>Close</button>
                  </>
                )}
                {p.status === 'CLOSED' && (
                  <button type="button" className="pla-linkbtn pla-linkbtn--warn" onClick={() => { setActionPla({ pla: p, kind: 'reopen' }); setReason(''); }}>Reopen</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      {/* New / Edit PLA modal */}
      <Modal
        open={!!editorOpen}
        onClose={() => setEditorOpen(null)}
        title={editorOpen === 'create' ? 'New Preliminary Loss Advice' : `Edit ${editorOpen?.pla_ref || 'PLA'}`}
        footer={(
          <>
            <Button onClick={() => setEditorOpen(null)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={submitEditor}>
              {editorOpen === 'create' ? 'Log PLA' : 'Save changes'}
            </Button>
          </>
        )}
      >
        <div className="pla-form-grid">
          {editorOpen === 'create' ? (
            <>
              <div className="pla-span">
                <Field label="Search treaties">
                  <Input value={treatySearch} onChange={(e) => setTreatySearch(e.target.value)} placeholder="Cedant / contract ID / description…" />
                </Field>
              </div>
              <div className="pla-span">
                <Field label={`Treaty (SIGNED / BOUND only — ${eligibleTreaties.length} match${eligibleTreaties.length === 1 ? '' : 'es'})`} required>
                  <select className="pla-select pla-select--block" value={form.contract_id} onChange={set('contract_id')}>
                    <option value="">Select treaty…</option>
                    {eligibleTreaties.map((c) => (
                      <option key={c.contract_id} value={c.contract_id}>{treatyLabel(c)}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          ) : (
            <div className="pla-span pla-hint">
              {editorOpen && editorOpen !== 'create' ? `${editorOpen.cedant_name || ''} · ${editorOpen.treaty_type || ''} · UW ${editorOpen.uw_year || ''}` : ''}
            </div>
          )}

          <Field label="Loss date" required><Input type="date" value={form.loss_date} onChange={set('loss_date')} /></Field>
          <Field label="Advice date"><Input type="date" value={form.advice_date} onChange={set('advice_date')} /></Field>
          <Field label="Insured"><Input value={form.insured_name} onChange={set('insured_name')} placeholder="Insured name" /></Field>
          <Field label="Cedant claim ref"><Input value={form.cedant_claim_ref} onChange={set('cedant_claim_ref')} placeholder="Cedant's reference" /></Field>
          <Field label="Loss type">
            <select className="pla-select pla-select--block" value={form.loss_type} onChange={set('loss_type')}>
              {['ATTRITIONAL', 'LARGE', 'CAT'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          {form.loss_type === 'CAT' && (
            <Field label="CAT event ref"><Input value={form.cat_event_ref} onChange={set('cat_event_ref')} placeholder="e.g. Jeddah Floods 2026" /></Field>
          )}
          <Field label="Cause of loss"><Input value={form.cause_of_loss} onChange={set('cause_of_loss')} placeholder="e.g. Fire" /></Field>
          <Field label="Estimated gross loss @100%">
            <Input inputMode="decimal" value={formatWithCommasDecimal(form.estimated_gross_loss_100)}
              onChange={(e) => set('estimated_gross_loss_100')(sanitizeNumber(e.target.value))} />
          </Field>
          <div className="pla-span">
            <Field label="Description"><Input value={form.description} onChange={set('description')} placeholder="Advice narrative" /></Field>
          </div>
          {editorOpen === 'create' && line != null && (
            <div className="pla-span pla-hint">
              Estimated our share at the {line}% signed line: <b>{fmtMoney((est * line) / 100)}</b>
            </div>
          )}
        </div>
        {editorError && <div className="pla-error">{editorError}</div>}
      </Modal>

      {/* Convert to claim modal */}
      <Modal
        open={!!convertPla}
        onClose={() => setConvertPla(null)}
        title={`Convert ${convertPla?.pla_ref || ''} to Claim`}
        footer={(
          <>
            <Button onClick={() => setConvertPla(null)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={submitConvert}>Convert &amp; Open Claim</Button>
          </>
        )}
      >
        <p className="pla-hint">
          Converting books a claim on <b>{convertPla ? `${convertPla.cedant_name || ''} · ${convertPla.treaty_type || ''} · UW ${convertPla.uw_year || ''}` : ''}</b> with
          an opening ADVICE movement. The opening OS defaults to the PLA estimate — restate it here if the cedant has advised firmer figures.
        </p>
        <div className="pla-form-grid">
          <Field label="Reported date"><Input type="date" value={convert.reported_date} onChange={(e) => setConvert((f) => ({ ...f, reported_date: e.target.value }))} /></Field>
          <div />
          <Field label="Opening paid @100%">
            <Input inputMode="decimal" value={formatWithCommasDecimal(convert.gross_paid_100)}
              onChange={(e) => setConvert((f) => ({ ...f, gross_paid_100: sanitizeNumber(e.target.value) }))} />
          </Field>
          <Field label="Opening OS reserve @100%">
            <Input inputMode="decimal" value={formatWithCommasDecimal(convert.gross_os_100)}
              onChange={(e) => setConvert((f) => ({ ...f, gross_os_100: sanitizeNumber(e.target.value) }))} />
          </Field>
          <div className="pla-span">
            <Field label="Comment"><Input value={convert.comment} onChange={(e) => setConvert((f) => ({ ...f, comment: e.target.value }))} placeholder={`e.g. Converted from ${convertPla?.pla_ref || 'PLA'} per cedant advice`} /></Field>
          </div>
        </div>
        {convertError && <div className="pla-error">{convertError}</div>}
      </Modal>

      {/* Close / reopen confirm */}
      <Modal
        open={!!actionPla}
        onClose={() => setActionPla(null)}
        title={actionPla?.kind === 'close' ? `Close ${actionPla?.pla?.pla_ref || 'PLA'}` : `Reopen ${actionPla?.pla?.pla_ref || 'PLA'}`}
        footer={(
          <>
            <Button onClick={() => setActionPla(null)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={submitAction}>Confirm</Button>
          </>
        )}
      >
        <p className="pla-hint">
          {actionPla?.kind === 'close'
            ? 'Closing records that no claim is expected from this advice. It stays on the register and can be reopened if the loss develops.'
            : 'Reopening returns the advice to PENDING so it can be updated or converted to a claim.'}
        </p>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
        </Field>
      </Modal>
    </>
  );
}
