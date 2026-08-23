// src/screens/claims/ClaimsHomeScreen.jsx
// Claims module home: portfolio KPIs, filterable claims register, and the
// New Claim flow (booked against SIGNED/BOUND treaties only — enforced
// server-side, mirrored in the contract dropdown here).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import Topbar from '../../components/Topbar';
import { Button, Field, Input, Modal, Select, Table } from '../../components/ui';
import { ApprovalBadge, ClaimStatusBadge, KpiCard, fmtMoney, fmtDate } from '../../components/ledger';
import { errorMessage as errMsg } from '../../utils/errorBody';
import { logger } from '../../utils/logger';
import { formatWithCommasDecimal, sanitizeNumber } from '../../utils/format';

const parseAmt = (v) => Number(String(v ?? '').replace(/,/g, ''));

const EMPTY_FORM = {
  contract_id: '', loss_date: '', reported_date: '', insured_name: '',
  cedant_claim_ref: '', cause_of_loss: '', description: '',
  loss_type: 'ATTRITIONAL', cat_event_ref: '', gross_paid_100: '0', gross_os_100: '0', comment: '',
};
const EMPTY_PICKER = { country_id: '', cedant_id: '', uw_year: '', search: '' };

const COLUMNS = [
  { key: 'Claim Ref' }, { key: 'Cedant / Treaty' }, { key: 'Insured' }, { key: 'Loss Date' },
  { key: 'Type' }, { key: 'Approval' }, { key: 'Status' },
  { key: 'Incurred 100%', num: true }, { key: 'Incurred (our)', num: true }, { key: 'OS (our)', num: true },
];

const WIZARD_TABS = ['1 · Details', '2 · Claim Amounts', '3 · Send for Approval'];

/** Short human label for a treaty in the picker. */
const treatyLabel = (c) => {
  const bits = [c.cedant_name || 'Unnamed', c.treaty_type || 'Treaty', `UW ${c.uw_year}`];
  if (c.alt_contract_id) bits.push(c.alt_contract_id);
  if (c.signed_line_pct != null) bits.push(`line ${Number(c.signed_line_pct)}%`);
  return bits.join(' · ');
};

export default function ClaimsHomeScreen() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [claims, setClaims] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [statusFilter, setStatusFilter] = useState('');
  const [approvalFilter, setApprovalFilter] = useState('');
  const [lossTypeFilter, setLossTypeFilter] = useState('');
  const [search, setSearch] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [createTab, setCreateTab] = useState(0); // 0 Details · 1 Claim Amounts · 2 Send for Approval
  const [contracts, setContracts] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [picker, setPicker] = useState(EMPTY_PICKER);
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [s, c] = await Promise.all([
        api.getClaimsSummary(),
        api.listClaims({
          status: statusFilter || undefined,
          approvalStatus: approvalFilter || undefined,
          lossType: lossTypeFilter || undefined,
          q: search || undefined,
        }),
      ]);
      setSummary(s);
      setClaims(Array.isArray(c) ? c : []);
    } catch (e) {
      logger.error('claims load failed', e);
      setError('Failed to load claims. Please retry.');
    } finally { setLoading(false); }
  }, [statusFilter, approvalFilter, lossTypeFilter, search]);

  useEffect(() => { load(); }, [load]);

  const openCreate = useCallback(async () => {
    setCreateOpen(true); setCreateTab(0); setCreateError(''); setForm(EMPTY_FORM); setPicker(EMPTY_PICKER); setFiles([]);
    try {
      const rows = await api.getClaimsEligibleContracts();
      setContracts(Array.isArray(rows) ? rows : []);
    } catch (e) {
      logger.error('eligible contracts load failed', e);
      setCreateError('Could not load signed treaties.');
    }
  }, []);

  // Cascading treaty picker: country → cedants in that country → that cedant's
  // treaties, further narrowed by UW year and free-text search (contract id /
  // alt id / description / cedant).
  const countries = useMemo(() => {
    const seen = new Map();
    for (const c of contracts) if (c.country_id && !seen.has(c.country_id)) seen.set(c.country_id, c.country_name || 'Unknown');
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [contracts]);

  const cedants = useMemo(() => {
    const seen = new Map();
    for (const c of contracts) {
      if (picker.country_id && c.country_id !== picker.country_id) continue;
      if (c.cedant_id && !seen.has(c.cedant_id)) seen.set(c.cedant_id, c.cedant_name || 'Unnamed');
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [contracts, picker.country_id]);

  const uwYears = useMemo(() => {
    const years = new Set();
    for (const c of contracts) {
      if (picker.country_id && c.country_id !== picker.country_id) continue;
      if (picker.cedant_id && c.cedant_id !== picker.cedant_id) continue;
      if (c.uw_year != null) years.add(c.uw_year);
    }
    return [...years].sort((a, b) => b - a);
  }, [contracts, picker.country_id, picker.cedant_id]);

  const eligibleTreaties = useMemo(() => {
    const needle = picker.search.trim().toLowerCase();
    return contracts.filter((c) => {
      if (picker.country_id && c.country_id !== picker.country_id) return false;
      if (picker.cedant_id && c.cedant_id !== picker.cedant_id) return false;
      if (picker.uw_year && String(c.uw_year) !== String(picker.uw_year)) return false;
      if (needle) {
        const hay = [c.contract_id, c.alt_contract_id, c.contract_description, c.cedant_name, c.treaty_type]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [contracts, picker]);

  const setPickerField = (k) => (e) => {
    const value = e?.target ? e.target.value : e;
    setPicker((p) => {
      const next = { ...p, [k]: value };
      if (k === 'country_id') { next.cedant_id = ''; next.uw_year = ''; }
      if (k === 'cedant_id') next.uw_year = '';
      return next;
    });
  };

  // Drop the treaty selection if it no longer survives the picker filters.
  useEffect(() => {
    if (form.contract_id && !eligibleTreaties.some((c) => c.contract_id === form.contract_id)) {
      setForm((f) => ({ ...f, contract_id: '' }));
    }
  }, [eligibleTreaties, form.contract_id]);

  const selectedTreaty = useMemo(
    () => contracts.find((c) => c.contract_id === form.contract_id) || null,
    [contracts, form.contract_id],
  );

  /** Per-tab validation; returns an error message or '' when the tab is good. */
  const tabError = useCallback((tab) => {
    if (tab === 0) {
      if (!form.contract_id) return 'Select the treaty the claim attaches to.';
      if (!form.loss_date) return 'Loss date is required.';
    }
    if (tab === 1) {
      const paid = parseAmt(form.gross_paid_100);
      const os = parseAmt(form.gross_os_100);
      if (!Number.isFinite(paid) || paid < 0 || !Number.isFinite(os) || os < 0) {
        return 'Opening paid and OS must be non-negative amounts.';
      }
    }
    return '';
  }, [form]);

  /** Move to a tab, validating every tab before it. */
  const goToTab = useCallback((target) => {
    for (let t = 0; t < target; t += 1) {
      const err = tabError(t);
      if (err) { setCreateTab(t); setCreateError(err); return; }
    }
    setCreateError('');
    setCreateTab(target);
  }, [tabError]);

  const submitCreate = useCallback(async (sendForApproval) => {
    setCreateError('');
    for (let t = 0; t <= 1; t += 1) {
      const err = tabError(t);
      if (err) { setCreateTab(t); setCreateError(err); return; }
    }
    setSaving(true);
    try {
      const body = {
        contract_id: form.contract_id,
        loss_date: form.loss_date,
        reported_date: form.reported_date || undefined,
        insured_name: form.insured_name || undefined,
        cedant_claim_ref: form.cedant_claim_ref || undefined,
        cause_of_loss: form.cause_of_loss || undefined,
        description: form.description || undefined,
        loss_type: form.loss_type,
        cat_event_ref: form.loss_type === 'CAT' ? (form.cat_event_ref || undefined) : undefined,
        gross_paid_100: parseAmt(form.gross_paid_100) || 0,
        gross_os_100: parseAmt(form.gross_os_100) || 0,
        comment: form.comment || undefined,
      };
      const out = await api.createClaim(body);
      // Attachments ride along after the claim exists; a failed upload is
      // reported but never blocks the created claim.
      const failed = [];
      for (const file of files) {
        try {
          const fd = new FormData();
          fd.append('file', file);
          await api.uploadClaimDocument(out.claim_id, fd);
        } catch (e) {
          logger.error('claim attachment upload failed', e);
          failed.push(file.name);
        }
      }
      if (failed.length) {
        window.alert(`Claim ${out.claim_ref || ''} was created, but these attachments failed to upload: ${failed.join(', ')}. You can re-attach them on the claim screen.`);
      }
      if (sendForApproval) {
        try {
          await api.submitClaim(out.claim_id);
        } catch (e) {
          logger.error('claim submit-for-approval failed', e);
          window.alert(`Claim ${out.claim_ref || ''} was created as a draft, but sending it for approval failed. You can submit it from the claim screen.`);
        }
      }
      setCreateOpen(false);
      navigate(`/claims/${out.claim_id}`);
    } catch (e) {
      logger.error('claim create failed', e);
      setCreateError(errMsg(e, 'Claim creation failed.'));
    } finally { setSaving(false); }
  }, [form, files, navigate, tabError]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  return (
    <div className="cf-screen">
      <Topbar
        title="Claims"
        subtitle="Claims dashboard & register"
        actions={(
          <div className="cf-actions">
            <Button onClick={() => setApprovalFilter('WAITING_APPROVAL')}>
              Review Claims{summary && Number(summary.waiting_approval_claims) > 0 ? ` (${summary.waiting_approval_claims})` : ''}
            </Button>
            <Button variant="primary" onClick={openCreate}>+ New Claim</Button>
          </div>
        )}
      />

      <div className="cf-page">

        {/* Claim counts */}
        <div className="cf-kpi-row">
          <KpiCard label="Total Claims" value={summary ? summary.total_claims : '–'} sub={summary ? `${summary.open_claims} open · ${summary.cat_claims} CAT` : ''} />
          <KpiCard label="Draft" value={summary ? summary.draft_claims : '–'} tone="muted" />
          <KpiCard label="Waiting for Approval" value={summary ? summary.waiting_approval_claims : '–'} tone="warn" />
          <KpiCard label="Rejected" value={summary ? summary.rejected_claims : '–'} tone="danger" />
          <KpiCard label="Finalised" value={summary ? summary.finalised_claims : '–'} tone="ok" />
        </div>

        {/* Position (our share) */}
        <div className="cf-kpi-row cf-kpi-row--wide">
          <KpiCard label="Total Claims Paid to Date" value={summary ? fmtMoney(summary.total_paid_our_share) : '–'} sub="our share, excl. rejected" />
          <KpiCard label="Open Incurred" value={summary ? fmtMoney(summary.open_incurred_our_share) : '–'} sub="our share, open claims" />
          <KpiCard label="Outstanding" value={summary ? fmtMoney(summary.open_os_our_share) : '–'} sub="our share, open claims" />
        </div>

        {/* Filters */}
        <div className="cf-filters">
          <Select className="ui-select--auto" value={approvalFilter} aria-label="Filter by approval status"
            onChange={(e) => setApprovalFilter(e.target.value)}>
            <option value="">All approval states</option>
            {['DRAFT', 'WAITING_APPROVAL', 'REJECTED', 'FINALISED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </Select>
          <Select className="ui-select--auto" value={statusFilter} aria-label="Filter by status"
            onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {['OPEN', 'REOPENED', 'CLOSED', 'DECLINED'].map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Select className="ui-select--auto" value={lossTypeFilter} aria-label="Filter by loss type"
            onChange={(e) => setLossTypeFilter(e.target.value)}>
            <option value="">All loss types</option>
            {['ATTRITIONAL', 'LARGE', 'CAT'].map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <div className="cf-filters__search">
            <Input placeholder="Search ref / insured / cedant…" value={search} aria-label="Search claims"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
          </div>
          <Button onClick={load}>Refresh</Button>
        </div>

        {error && <div className="cf-error" role="alert">{error}</div>}

        {/* Register */}
        <Table>
          <thead>
            <tr>
              {COLUMNS.map(({ key, num }) => (
                <th key={key} className={num ? 'cf-num' : undefined}>{key}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={COLUMNS.length} className="cf-empty">Loading…</td></tr>
            )}
            {!loading && !claims.length && (
              <tr><td colSpan={COLUMNS.length} className="cf-empty">No claims found. Book the first one with “+ New Claim”.</td></tr>
            )}
            {!loading && claims.map((c) => (
              <tr key={c.claim_id}>
                {/* The ref is the row's link target: a real <a> so it is
                    keyboard-reachable and middle-clickable, which a
                    click-handler on the <tr> never was. */}
                <td>
                  <Link className="cf-link" to={`/claims/${c.claim_id}`}>{c.claim_ref}</Link>
                </td>
                <td>
                  <div className="cf-cell-title">{c.cedant_name || '–'}</div>
                  <div className="cf-cell-sub">{c.treaty_type || ''} · UW {c.uw_year || '–'}</div>
                </td>
                <td>{c.insured_name || '–'}</td>
                <td>{fmtDate(c.loss_date)}</td>
                <td className="cf-cell-muted">{c.loss_type}</td>
                <td><ApprovalBadge status={c.approval_status} /></td>
                <td><ClaimStatusBadge status={c.status} /></td>
                <td className="cf-num">{fmtMoney(c.gross_incurred_100)} <span className="cf-ccy">{c.currency_code || ''}</span></td>
                <td className="cf-num cf-num--strong">{fmtMoney(c.incurred_our_share)}</td>
                <td className="cf-num">{fmtMoney(c.os_our_share)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      {/* New Claim wizard — full screen, tabbed */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New Claim"
        className="ui-modal--full"
        closeOnBackdrop={false}
        footer={(
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            {createTab > 0 && <Button onClick={() => goToTab(createTab - 1)}>← Back</Button>}
            {createTab < 2 && <Button variant="primary" onClick={() => goToTab(createTab + 1)}>Next →</Button>}
            {createTab === 2 && <Button loading={saving} onClick={() => submitCreate(false)}>Create Draft</Button>}
            {createTab === 2 && <Button variant="primary" loading={saving} onClick={() => submitCreate(true)}>Create &amp; Send for Approval</Button>}
          </>
        )}
      >
        {/* Tab bar */}
        <div role="tablist" aria-label="New claim steps" className="cf-tabs">
          {WIZARD_TABS.map((t, i) => (
            <button key={t} type="button" role="tab" aria-selected={i === createTab} className="cf-tab" onClick={() => goToTab(i)}>
              {t}
            </button>
          ))}
        </div>

        <div className="cf-wizard-body">
          <div className="cf-wizard-inner">

            {/* ── Tab 1 · Details ── */}
            {createTab === 0 && (
              <div className="cf-grid2">
                <div className="cf-section-head">Treaty</div>
                <Field label="Country">
                  <Select value={picker.country_id} onChange={setPickerField('country_id')}>
                    <option value="">All countries</option>
                    {countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="Cedant">
                  <Select value={picker.cedant_id} onChange={setPickerField('cedant_id')}>
                    <option value="">All cedants{picker.country_id ? ' in country' : ''}</option>
                    {cedants.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="UW year">
                  <Select value={picker.uw_year} onChange={setPickerField('uw_year')}>
                    <option value="">All years</option>
                    {uwYears.map((y) => <option key={y} value={y}>{y}</option>)}
                  </Select>
                </Field>
                <Field label="Search treaties">
                  <Input value={picker.search} onChange={setPickerField('search')} placeholder="Contract ID / description…" />
                </Field>
                <div className="cf-grid-full">
                  <Field label={`Treaty (SIGNED / BOUND only — ${eligibleTreaties.length} match${eligibleTreaties.length === 1 ? '' : 'es'})`} required>
                    <Select value={form.contract_id} onChange={set('contract_id')}>
                      <option value="">Select treaty…</option>
                      {eligibleTreaties.map((c) => (
                        <option key={c.contract_id} value={c.contract_id}>{treatyLabel(c)}</option>
                      ))}
                    </Select>
                  </Field>
                  {selectedTreaty?.contract_description && (
                    <div className="cf-hint">{selectedTreaty.contract_description}</div>
                  )}
                </div>

                <div className="cf-section-head">Loss</div>
                <Field label="Loss date" required><Input type="date" value={form.loss_date} onChange={set('loss_date')} /></Field>
                <Field label="Reported date"><Input type="date" value={form.reported_date} onChange={set('reported_date')} /></Field>
                <Field label="Insured"><Input value={form.insured_name} onChange={set('insured_name')} placeholder="Insured name" /></Field>
                <Field label="Cedant claim ref"><Input value={form.cedant_claim_ref} onChange={set('cedant_claim_ref')} placeholder="Cedant's reference" /></Field>
                <Field label="Loss type">
                  <Select value={form.loss_type} onChange={set('loss_type')}>
                    {['ATTRITIONAL', 'LARGE', 'CAT'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </Select>
                </Field>
                {form.loss_type === 'CAT' && (
                  <Field label="CAT event ref"><Input value={form.cat_event_ref} onChange={set('cat_event_ref')} placeholder="e.g. Jeddah Floods 2026" /></Field>
                )}
                <Field label="Cause of loss"><Input value={form.cause_of_loss} onChange={set('cause_of_loss')} placeholder="e.g. Fire" /></Field>
                <div className="cf-grid-full">
                  <Field label="Description"><Input value={form.description} onChange={set('description')} placeholder="Advice narrative" /></Field>
                </div>

                <div className="cf-section-head">Attachments</div>
                <div className="cf-grid-full">
                  <Field label="Supporting documents (cedant advice, adjuster report, …)">
                    <Input
                      type="file" multiple
                      onChange={(e) => setFiles(Array.from(e.target.files || []))}
                      aria-label="Claim attachments"
                    />
                  </Field>
                  {files.length > 0 && (
                    <div className="cf-hint">
                      {files.length} file{files.length === 1 ? '' : 's'} will be attached: {files.map((f) => f.name).join(', ')}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab 2 · Claim Amounts ── */}
            {createTab === 1 && (() => {
              const paid = parseAmt(form.gross_paid_100) || 0;
              const os = parseAmt(form.gross_os_100) || 0;
              const line = selectedTreaty?.signed_line_pct != null ? Number(selectedTreaty.signed_line_pct) : null;
              const ccy = selectedTreaty?.currency_code || '';
              const share = (v) => (line == null ? null : (v * line) / 100);
              return (
                <div className="cf-grid2">
                  <div className="cf-section-head">Opening position @ 100% (cumulative)</div>
                  <div className="cf-grid-full cf-note-text">
                    Enter the cedant-advised position at 100% — it is booked as movement #1 (ADVICE) on the claim ledger.
                  </div>
                  <Field label={`Opening paid @100%${ccy ? ` (${ccy})` : ''}`}>
                    <Input inputMode="decimal" value={formatWithCommasDecimal(form.gross_paid_100)} onChange={(e) => set('gross_paid_100')(sanitizeNumber(e.target.value))} />
                  </Field>
                  <Field label={`Opening OS reserve @100%${ccy ? ` (${ccy})` : ''}`}>
                    <Input inputMode="decimal" value={formatWithCommasDecimal(form.gross_os_100)} onChange={(e) => set('gross_os_100')(sanitizeNumber(e.target.value))} />
                  </Field>
                  <div className="cf-grid-full">
                    <Field label="Movement comment"><Input value={form.comment} onChange={set('comment')} placeholder="e.g. Initial advice per cedant email" /></Field>
                  </div>

                  <div className="cf-section-head">Position preview</div>
                  <div className="cf-mini-grid">
                    {[
                      ['Incurred @100%', fmtMoney(paid + os)],
                      [`Our line${line != null ? ` (${line}%)` : ''}`, line != null ? `${line}%` : 'select a treaty'],
                      ['Paid (our share)', share(paid) != null ? fmtMoney(share(paid)) : '–'],
                      ['OS (our share)', share(os) != null ? fmtMoney(share(os)) : '–'],
                      ['Incurred (our share)', share(paid + os) != null ? fmtMoney(share(paid + os)) : '–'],
                    ].map(([k, v]) => (
                      <div key={k} className="cf-mini">
                        <div className="cf-mini__label">{k}</div>
                        <div className="cf-mini__value">{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* ── Tab 3 · Send for Approval ── */}
            {createTab === 2 && (() => {
              const paid = parseAmt(form.gross_paid_100) || 0;
              const os = parseAmt(form.gross_os_100) || 0;
              const line = selectedTreaty?.signed_line_pct != null ? Number(selectedTreaty.signed_line_pct) : null;
              const ccy = selectedTreaty?.currency_code || '';
              const rows = [
                ['Treaty', selectedTreaty ? treatyLabel(selectedTreaty) : '–'],
                ['Contract description', selectedTreaty?.contract_description || '–'],
                ['Country', selectedTreaty?.country_name || '–'],
                ['Loss date', form.loss_date || '–'],
                ['Reported date', form.reported_date || 'today'],
                ['Insured', form.insured_name || '–'],
                ['Cedant claim ref', form.cedant_claim_ref || '–'],
                ['Loss type', form.loss_type + (form.loss_type === 'CAT' && form.cat_event_ref ? ` · ${form.cat_event_ref}` : '')],
                ['Cause of loss', form.cause_of_loss || '–'],
                ['Description', form.description || '–'],
                [`Opening paid @100%${ccy ? ` (${ccy})` : ''}`, fmtMoney(paid)],
                [`Opening OS @100%${ccy ? ` (${ccy})` : ''}`, fmtMoney(os)],
                ['Incurred (our share)', line != null ? fmtMoney(((paid + os) * line) / 100) : '–'],
                ['Attachments', files.length ? files.map((f) => f.name).join(', ') : 'none'],
              ];
              return (
                <div>
                  <div className="cf-section-title">Review &amp; submit</div>
                  <div className="cf-facts cf-facts--review">
                    {rows.map(([k, v]) => (
                      <div key={k}>
                        <div className="cf-fact__label">{k}</div>
                        <div className="cf-fact__value">{v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="cf-note-text">
                    <b className="cf-strong">Create Draft</b> books the claim and leaves it in DRAFT so you can keep working on it.<br />
                    <b className="cf-strong">Create &amp; Send for Approval</b> books the claim and submits it for review immediately — it is then frozen until approved or rejected.
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
        {createError && <div className="cf-error cf-error--modal" role="alert">{createError}</div>}
      </Modal>
    </div>
  );
}
