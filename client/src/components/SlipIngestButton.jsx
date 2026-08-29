/**
 * SlipIngestButton
 * Upload a reinsurance slip PDF → server proxy → AI reads it → returns structured JSON.
 * Blank form fields are auto-filled; populated fields are checked and flagged
 * if the slip disagrees.
 *
 * Props:
 *   mode       : 'NP' | 'PROP'
 *   onFill     : (fields: object) => void   — called with auto-fill field values
 *   currentValues: object                    — current form values for comparison
 *   fieldLabels: object                      — display labels for comparison output
 *   countries  : [{id, name, code}]         — for fuzzy country matching
 *   treatyTypes: [{id, name}]               — for fuzzy treaty type matching
 *   brokers    : [{id, name}]               — for fuzzy broker matching
 *   cedants    : [{id, name}]               — for fuzzy cedant matching (optional)
 *   currencies : [{id, name, code}]         — for fuzzy currency matching
 *   classes    : [{id, name}]               — for fuzzy LOB matching
 */

import { useRef, useState } from 'react';
import { api } from '../api';
import { formatWithCommasDecimal } from '../utils/format';

export function isBlankValue(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim() === '';
}

function numericComparable(value) {
  if (Array.isArray(value) || value == null) return null;
  const cleaned = String(value).replace(/[,%\s]/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function normalizeSlipValue(value) {
  if (Array.isArray(value)) {
    return value.map(v => normalizeSlipValue(v)).sort().join('|');
  }
  const n = numericComparable(value);
  if (n != null) return String(Number(n.toFixed(6)));
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function slipValuesEqual(a, b) {
  if (isBlankValue(a) && isBlankValue(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return normalizeSlipValue(a || []) === normalizeSlipValue(b || []);
  const na = numericComparable(a);
  const nb = numericComparable(b);
  if (na != null && nb != null) return Math.abs(na - nb) < 0.000001;
  return normalizeSlipValue(a) === normalizeSlipValue(b);
}

function humanizeFieldKey(key) {
  const words = String(key || '')
    .replace(/Id$/, '')
    .replace(/Pct$/, 'Percent')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b(qs)\b/gi, 'QS')
    .replace(/\b(xl)\b/gi, 'XL')
    .replace(/\b(gnpi)\b/gi, 'GNPI')
    .replace(/\b(epi)\b/gi, 'EPI')
    .replace(/\b(aal)\b/gi, 'AAL')
    .replace(/\buw\b/gi, 'UW');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function labelForField(key, fieldLabels = {}) {
  return fieldLabels[key] || humanizeFieldKey(key);
}

export function buildSlipReview(filled, currentValues = {}, { fieldLabels = {}, formatValue } = {}) {
  const fieldKeys = Object.keys(filled || {}).filter(key => !key.startsWith('_') && !isBlankValue(filled[key]));
  const autoFill = {};
  const verified = [];
  const conflicts = [];

  for (const key of fieldKeys) {
    const slipValue = filled[key];
    const currentValue = currentValues[key];
    if (isBlankValue(currentValue)) {
      autoFill[key] = slipValue;
      continue;
    }
    if (slipValuesEqual(currentValue, slipValue)) {
      verified.push({ key, label: labelForField(key, fieldLabels) });
      continue;
    }
    conflicts.push({
      key,
      label: labelForField(key, fieldLabels),
      currentValue,
      slipValue,
      currentDisplay: formatValue ? formatValue(key, currentValue) : String(currentValue),
      slipDisplay: formatValue ? formatValue(key, slipValue) : String(slipValue),
    });
  }

  const missing = Object.entries(currentValues || {})
    .filter(([key, value]) => !key.startsWith('_') && !isBlankValue(value) && !fieldKeys.includes(key))
    .map(([key, value]) => ({
      key,
      label: labelForField(key, fieldLabels),
      currentValue: value,
      currentDisplay: formatValue ? formatValue(key, value) : String(value),
    }));

  return {
    autoFill,
    verified,
    conflicts,
    missing,
    extractedCount: fieldKeys.length,
  };
}

function fuzzyMatch(value, list, nameKey = 'name') {
  if (!value || !list?.length) return null;
  const v = String(value).toLowerCase().trim();
  // 1. Exact match
  const exact = list.find(x => String(x[nameKey]).toLowerCase() === v);
  if (exact) return exact;
  // 2. Contains match
  const contains = list.find(x => String(x[nameKey]).toLowerCase().includes(v) || v.includes(String(x[nameKey]).toLowerCase()));
  if (contains) return contains;
  // 3. Code match (for country/currency)
  if (list[0]?.code) {
    const byCode = list.find(x => String(x.code).toLowerCase() === v);
    if (byCode) return byCode;
  }
  return null;
}

export default function SlipIngestButton({
  mode = 'NP',
  onFill,
  currentValues = {},
  fieldLabels = {},
  countries = [],
  treatyTypes = [],
  brokers = [],
  cedants = [],
  currencies = [],
  classes = [],
}) {
  const fileRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | reading | calling | done | error
  const [errorMsg, setErrorMsg] = useState('');
  const [lastResult, setLastResult] = useState(null);
  const [lastReview, setLastReview] = useState(null);

  const labelForId = (list, id, fallbackKey = 'name') => {
    const item = (list || []).find(x => String(x.id) === String(id));
    return item?.code || item?.[fallbackKey] || item?.name || String(id ?? '');
  };

  const formatValue = (key, value) => {
    if (isBlankValue(value)) return 'blank';
    if (key === 'countryId') return labelForId(countries, value);
    if (key === 'currencyId') return labelForId(currencies, value);
    if (key === 'treatyTypeId') return labelForId(treatyTypes, value);
    if (key === 'brokerId') return labelForId(brokers, value);
    if (key === 'cedantId') return labelForId(cedants, value);
    if (key === 'classIds' && Array.isArray(value)) {
      return value.map(id => labelForId(classes, id)).join(', ');
    }
    if (Array.isArray(value)) return value.join(', ');
    // Money and other numeric fields read as comparison amounts — group with
    // commas so the panel shows "25,000,000", not "25000000". Year-like keys
    // stay ungrouped (2,026 is not a year).
    const n = numericComparable(value);
    if (n != null && !/year/i.test(key)) return formatWithCommasDecimal(n);
    return String(value);
  };

  const handleFile = async (file) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.endsWith('.pdf')) {
      setErrorMsg('Please upload a PDF file.');
      setStatus('error');
      return;
    }

    setStatus('reading');
    setErrorMsg('');

    try {
      // 1. Read file as base64
      const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(',')[1]);
        reader.onerror = () => rej(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });

      setStatus('calling');

      // Call the server-side proxy so LLM provider keys (Gemini/OpenAI) stay on the server.
      const { text: rawText, provider } = await api.aiSlipIngest({ base64, mode });

      // 3. Parse JSON (strip any accidental markdown fences)
      const clean = rawText.replace(/```json|```/g, '').trim();
      let extracted;
      try {
        extracted = JSON.parse(clean);
      } catch {
        throw new Error(`Could not parse ${provider || 'AI'} response as JSON`);
      }

      setLastResult({ ...extracted, _provider: provider });

      // 4. Resolve IDs from reference lists
      const filled = {};

      // Country → countryId
      if (extracted.countryName) {
        const match = fuzzyMatch(extracted.countryName, countries);
        if (match) filled.countryId = String(match.id);
        filled._countryNameRaw = extracted.countryName;
      }

      // Currency → currencyId
      if (extracted.currencyCode) {
        const match = fuzzyMatch(extracted.currencyCode, currencies, 'code') || fuzzyMatch(extracted.currencyCode, currencies);
        if (match) filled.currencyId = String(match.id);
        filled._currencyCodeRaw = extracted.currencyCode;
      }

      // Treaty type → treatyTypeId
      if (extracted.treatyTypeName) {
        const match = fuzzyMatch(extracted.treatyTypeName, treatyTypes);
        if (match) filled.treatyTypeId = String(match.id);
        filled._treatyTypeNameRaw = extracted.treatyTypeName;
      }

      // Broker → brokerId
      if (extracted.brokerName) {
        const match = fuzzyMatch(extracted.brokerName, brokers);
        if (match) filled.brokerId = String(match.id);
        filled._brokerNameRaw = extracted.brokerName;
      }

      // Cedant → cedantId (optional — cedants are per-country so may not be loaded yet)
      if (extracted.cedantName) {
        const match = fuzzyMatch(extracted.cedantName, cedants);
        if (match) filled.cedantId = String(match.id);
        filled._cedantNameRaw = extracted.cedantName;
      }

      // Lines of Business → classIds
      if (Array.isArray(extracted.lineOfBusiness) && extracted.lineOfBusiness.length) {
        const ids = extracted.lineOfBusiness
          .map(lob => fuzzyMatch(lob, classes))
          .filter(Boolean)
          .map(c => String(c.id));
        if (ids.length) filled.classIds = ids;
      }

      // Direct scalar fields
      const scalarMap = {
        inceptionDate: 'inceptionDate',
        renewalDate: 'renewalDate',
        numberOfLayers: 'numberOfLayers',
        deductible: 'deductible',
        maxRetention: 'maxRetention',
        xlType: 'xlType',
        accountingMethod: 'accountingMethod',
        accounts: 'accounts',
        estGnpi: mode === 'NP' ? 'estGnpi' : null,
        brokeragePct: 'brokeragePct',
        taxesPct: 'taxesPct',
        noClaimsBonusPct: 'noClaimsBonusPct',
        profitCommissionPct: 'profitCommissionPct',
        experienceStartYear: 'experienceStartYear',
        // PROP-only
        qsLimit: 'qsLimit',
        retentionPct: 'retentionPct',
        cessionPct: 'cessionPct',
        surplusMaxRetention: 'surplusMaxRetention',
        numLines: 'numLines',
        eventLimit: 'eventLimit',
        aal: 'aal',
        lossCapPct: 'lossCapPct',
        fixedCommissionQSPct: 'fixedCommissionQSPct',
        quotaShareEpi: 'quotaShareEpi',
        surplusEpi: 'surplusEpi',
      };

      for (const [src, dst] of Object.entries(scalarMap)) {
        if (dst && extracted[src] != null) {
          filled[dst] = extracted[src];
        }
      }

      if (mode === 'PROP' && extracted.estGnpi != null && filled.quotaShareEpi == null && filled.surplusEpi == null) {
        const treatyName = String(extracted.treatyTypeName || '').toLowerCase();
        filled[treatyName.includes('surplus') && !treatyName.includes('quota') ? 'surplusEpi' : 'quotaShareEpi'] = extracted.estGnpi;
      }

      const review = buildSlipReview(filled, currentValues, { fieldLabels, formatValue });
      const autoFill = { ...review.autoFill };
      if (filled._cedantNameRaw && (autoFill.countryId || isBlankValue(currentValues.cedantId))) {
        autoFill._cedantNameRaw = filled._cedantNameRaw;
      }
      setLastReview(review);
      setStatus('done');
      if (Object.keys(autoFill).length) onFill?.(autoFill);

    } catch (e) {
      console.error('SlipIngestButton:', e);
      setErrorMsg(e.message || 'Unknown error');
      setStatus('error');
    }
  };

  const reset = () => {
    setStatus('idle');
    setErrorMsg('');
    setLastResult(null);
    setLastReview(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const label = {
    idle: '⬆ Upload Slip',
    reading: '📄 Reading…',
    calling: '🤖 Extracting…',
    done: '✅ Checked',
    error: '⚠️ Retry',
  }[status];

  const color = {
    idle: 'rgba(59,130,246,0.90)',
    reading: 'rgba(59,130,246,0.5)',
    calling: 'rgba(250,189,0,0.85)',
    done: 'rgba(34,197,94,0.85)',
    error: 'rgba(248,113,113,0.85)',
  }[status];

  const busy = status === 'reading' || status === 'calling';
  const filledCount = lastReview ? Object.keys(lastReview.autoFill || {}).length : 0;

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,application/pdf"
        style={{ display: 'none' }}
        onChange={e => handleFile(e.target.files?.[0])}
      />
      <button
        disabled={busy}
        onClick={() => status === 'done' || status === 'error' ? reset() : fileRef.current?.click()}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '7px 14px', borderRadius: 999,
          border: `1px solid ${color}`,
          background: `${color}18`,
          color: 'var(--accent-amber)',
          fontSize: 12, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.75 : 1,
          transition: 'all 0.15s',
          whiteSpace: 'nowrap',
        }}
      >
        {busy && (
          <span style={{
            display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
            border: '2px solid rgba(var(--text-rgb),0.25)', borderTopColor: color,
            animation: 'spin 0.7s linear infinite',
          }} />
        )}
        {label}
        {status === 'done' && (
          // Decorative ×: the parent button's own onClick already resets when
          // status is 'done', so clicks here just bubble to it.
          <span
            style={{ marginLeft: 2, opacity: 0.5, cursor: 'pointer', fontSize: 13 }}
            title="Upload another slip"
          >×</span>
        )}
      </button>

      {status === 'error' && errorMsg && (
        <div style={{ fontSize: 11, color: '#f87171', maxWidth: 260, lineHeight: 1.4 }}>
          {errorMsg}
        </div>
      )}

      {status === 'done' && lastResult && (
        <div style={{ fontSize: 10, color: 'var(--accent)', maxWidth: 360, lineHeight: 1.4 }}>
          {lastResult._provider && (
            <span style={{ color: 'var(--muted)', marginRight: 4 }}>via {lastResult._provider}:</span>
          )}
          {filledCount ? `Filled ${filledCount} blank field${filledCount === 1 ? '' : 's'}. ` : 'No blank fields filled. '}
          {lastReview?.verified?.length ? `Verified ${lastReview.verified.length}. ` : ''}
          {lastReview?.conflicts?.length ? `Check ${lastReview.conflicts.length} mismatch${lastReview.conflicts.length === 1 ? '' : 'es'}. ` : ''}
          {lastReview?.missing?.length ? `${lastReview.missing.length} populated field${lastReview.missing.length === 1 ? '' : 's'} not found on slip.` : ''}
        </div>
      )}

      {status === 'done' && lastReview?.conflicts?.length > 0 && (
        <div style={{ maxWidth: 420, width: 'min(420px, 80vw)', border: '1px solid rgba(248,113,113,0.28)', background: 'rgba(127,29,29,0.12)', borderRadius: 8, padding: '8px 10px', fontSize: 11, color: 'rgba(var(--text-rgb),0.88)', lineHeight: 1.35 }}>
          <div style={{ fontWeight: 800, marginBottom: 6, color: 'var(--accent-rose)' }}>Slip differs from current detail</div>
          {lastReview.conflicts.slice(0, 5).map(item => (
            <div key={item.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', padding: '5px 0', borderTop: '1px solid rgba(248,113,113,0.14)' }}>
              <div>
                <b>{item.label}</b>
                <div style={{ color: 'rgba(var(--text-rgb),0.72)' }}>Current: {item.currentDisplay || 'blank'}</div>
                <div style={{ color: 'rgba(var(--text-rgb),0.92)' }}>Slip: {item.slipDisplay || 'blank'}</div>
              </div>
              <button
                type="button"
                onClick={() => onFill?.({ [item.key]: item.slipValue })}
                style={{ borderRadius: 999, border: '1px solid rgba(248,113,113,0.45)', background: 'rgba(248,113,113,0.14)', color: 'var(--accent-rose)', padding: '4px 8px', fontSize: 10, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                Use slip
              </button>
            </div>
          ))}
          {lastReview.conflicts.length > 5 && (
            <div style={{ color: 'rgba(var(--text-rgb),0.70)', paddingTop: 4 }}>+{lastReview.conflicts.length - 5} more mismatch(es)</div>
          )}
        </div>
      )}

      {status === 'done' && !lastReview?.conflicts?.length && lastReview?.missing?.length > 0 && (
        <div style={{ maxWidth: 360, fontSize: 10, color: 'var(--accent-amber)', lineHeight: 1.4 }}>
          Not found on slip: {lastReview.missing.slice(0, 6).map(x => x.label).join(', ')}
          {lastReview.missing.length > 6 ? ` +${lastReview.missing.length - 6} more` : ''}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
