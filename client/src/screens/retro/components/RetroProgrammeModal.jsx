// screens/retro/components/RetroProgrammeModal.jsx — create/edit one retro
// programme: year + name + type + status, proportional (cession/commission)
// and XL (attachment/limits/reinstatements/ROL) terms, spend, and the class ×
// country scope (checkbox lists, short-circuited by the covers-all toggles).
// Pure form — the parent owns persistence via onSave(body).
import { useEffect, useState } from 'react';
import { Button, Field, Input, Modal, NumberInput, Select } from '../../../components/ui';
import { errorMessage as errMsg } from '../../../utils/errorBody';

export const PROGRAMME_TYPES = [
  ['QUOTA_SHARE', 'Quota Share'], ['SURPLUS', 'Surplus'],
  ['XL_PER_RISK', 'XL — Per Risk'], ['XL_CAT', 'XL — Cat'],
  ['XL_AGGREGATE', 'XL — Aggregate'], ['STOP_LOSS', 'Stop Loss'],
  ['WHOLE_ACCOUNT_XL', 'Whole Account XL'], ['OTHER', 'Other'],
];
export const PROGRAMME_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'CANCELLED'];

const emptyForm = (year) => ({
  uw_year: String(year),
  programme_name: '', programme_type: 'XL_PER_RISK', status: 'DRAFT',
  reinsurer: '', currency_code: 'USD',
  cession_pct: '', commission_pct: '',
  attachment: '', occurrence_limit: '', aggregate_limit: '',
  reinstatements: '', rol_pct: '', premium: '',
  inception_date: '', expiry_date: '', notes: '',
  covers_all_classes: false, covers_all_countries: false,
  class_of_business_ids: [], country_ids: [],
});

const fromProgramme = (p) => ({
  uw_year: String(p.uw_year ?? ''),
  programme_name: p.programme_name || '', programme_type: p.programme_type || 'XL_PER_RISK',
  status: p.status || 'DRAFT', reinsurer: p.reinsurer || '', currency_code: p.currency_code || 'USD',
  cession_pct: p.cession_pct ?? '', commission_pct: p.commission_pct ?? '',
  attachment: p.attachment ?? '', occurrence_limit: p.occurrence_limit ?? '',
  aggregate_limit: p.aggregate_limit ?? '', reinstatements: p.reinstatements ?? '',
  rol_pct: p.rol_pct ?? '', premium: p.premium ?? '',
  inception_date: p.inception_date ? String(p.inception_date).slice(0, 10) : '',
  expiry_date: p.expiry_date ? String(p.expiry_date).slice(0, 10) : '',
  notes: p.notes || '',
  covers_all_classes: !!p.covers_all_classes, covers_all_countries: !!p.covers_all_countries,
  class_of_business_ids: (p.classes || []).map((c) => c.class_of_business_id),
  country_ids: (p.countries || []).map((c) => c.country_id),
});

function ScopeBox({ label, allLabel, coversAll, onCoversAll, options, selected, onToggle }) {
  return (
    <div className="ui-field rt-span-3">
      <div className="rt-scope-head">
        <span className="ui-field__label">{label}</span>
        <label className="rt-all-toggle">
          <input type="checkbox" checked={coversAll} onChange={(e) => onCoversAll(e.target.checked)} />
          {allLabel}
        </label>
      </div>
      <div className={`rt-scope-box${coversAll ? ' rt-scope-box--disabled' : ''}`}>
        {options.map((o) => (
          <label key={o.id} className="rt-check">
            <input type="checkbox" checked={selected.includes(o.id)} onChange={() => onToggle(o.id)} />
            {o.name}
          </label>
        ))}
        {!options.length && <div className="cf-cell-muted">No reference data available.</div>}
      </div>
    </div>
  );
}

export default function RetroProgrammeModal({
  open, onClose, onSave,       // onSave(body) → Promise; parent reloads on success
  programme,                   // null = create; else the row being edited
  defaultYear, classes, countries,
}) {
  const [form, setForm] = useState(() => emptyForm(defaultYear));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(programme ? fromProgramme(programme) : emptyForm(defaultYear));
    setError('');
  }, [open, programme, defaultYear]);

  const set = (key) => (e) => {
    const v = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setForm((f) => ({ ...f, [key]: v }));
  };
  const toggleIn = (key) => (id) => setForm((f) => ({
    ...f,
    [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id],
  }));

  const save = async () => {
    if (!form.programme_name.trim()) { setError('Programme name is required.'); return; }
    setBusy(true); setError('');
    try {
      await onSave({
        ...form,
        programme_name: form.programme_name.trim(),
        class_of_business_ids: form.covers_all_classes ? [] : form.class_of_business_ids,
        country_ids: form.covers_all_countries ? [] : form.country_ids,
      });
      onClose();
    } catch (e) {
      setError(errMsg(e, 'Save failed.'));
    } finally { setBusy(false); }
  };

  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} className="ui-modal--lg"
      title={programme ? `Edit — ${programme.programme_name}` : 'New Retro Programme'}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {programme ? 'Save Changes' : 'Create Programme'}
          </Button>
        </>
      )}>
      {error && <div className="cf-error cf-error--modal" role="alert">{error}</div>}
      <div className="rt-form-grid">
        <Field label="UW year" required>
          <NumberInput value={form.uw_year} onChange={set('uw_year')} inputMode="numeric" />
        </Field>
        <Field label="Programme name" required className="rt-span-2">
          <Input value={form.programme_name} onChange={set('programme_name')} placeholder="e.g. Whole Account Cat XL" />
        </Field>
        <Field label="Type">
          <Select value={form.programme_type} onChange={set('programme_type')}>
            {PROGRAMME_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={set('status')}>
            {PROGRAMME_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="Reinsurer / market">
          <Input value={form.reinsurer} onChange={set('reinsurer')} placeholder="Lead reinsurer" />
        </Field>

        <Field label="Currency">
          <Input value={form.currency_code} onChange={set('currency_code')} placeholder="USD" />
        </Field>
        <Field label="Cession % (proportional)">
          <NumberInput value={form.cession_pct} onChange={set('cession_pct')} placeholder="e.g. 20" />
        </Field>
        <Field label="Commission %">
          <NumberInput value={form.commission_pct} onChange={set('commission_pct')} placeholder="e.g. 27.5" />
        </Field>

        <Field label="Attachment (XL)">
          <NumberInput value={form.attachment} onChange={set('attachment')} placeholder="0" />
        </Field>
        <Field label="Occurrence limit">
          <NumberInput value={form.occurrence_limit} onChange={set('occurrence_limit')} placeholder="0" />
        </Field>
        <Field label="Aggregate limit">
          <NumberInput value={form.aggregate_limit} onChange={set('aggregate_limit')} placeholder="0" />
        </Field>

        <Field label="Reinstatements">
          <NumberInput value={form.reinstatements} onChange={set('reinstatements')} inputMode="numeric" placeholder="0" />
        </Field>
        <Field label="Rate on line %">
          <NumberInput value={form.rol_pct} onChange={set('rol_pct')} placeholder="e.g. 12.5" />
        </Field>
        <Field label="Retro premium">
          <NumberInput value={form.premium} onChange={set('premium')} placeholder="0" />
        </Field>

        <Field label="Inception">
          <Input type="date" value={form.inception_date} onChange={set('inception_date')} />
        </Field>
        <Field label="Expiry">
          <Input type="date" value={form.expiry_date} onChange={set('expiry_date')} />
        </Field>
        <Field label="Notes">
          <Input value={form.notes} onChange={set('notes')} placeholder="Placement notes…" />
        </Field>

        <ScopeBox label="Classes of business covered" allLabel="All classes"
          coversAll={form.covers_all_classes} onCoversAll={(v) => setForm((f) => ({ ...f, covers_all_classes: v }))}
          options={classes} selected={form.class_of_business_ids} onToggle={toggleIn('class_of_business_ids')} />
        <ScopeBox label="Countries covered" allLabel="All countries"
          coversAll={form.covers_all_countries} onCoversAll={(v) => setForm((f) => ({ ...f, covers_all_countries: v }))}
          options={countries} selected={form.country_ids} onToggle={toggleIn('country_ids')} />
      </div>
    </Modal>
  );
}
