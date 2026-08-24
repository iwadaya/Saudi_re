// src/hooks/useNpTreatyDetail.js — npTreatyDetail with a server fallback.
//
// The npTreatyDetail slice is hydrated only by visiting the NP Treaty Detail
// screen, so a deep link / fresh session lands on Final Pricing or Structure
// with an empty bag: the header falls back to "RISK & CAT XL" + SAR, a phantom
// Risk XL section renders, and EGNPI / XL type / accounting method show "—"
// (audit F6). This hook returns the slice when it was hydrated for THIS
// contract; otherwise it fetches the same contract-header + NP-detail pair
// Treaty Detail loads and returns a read-only bag mapped to the slice's
// camelCase names. It NEVER writes the slice — Treaty Detail's autosave and
// clean-slate logic own it, and a background hydration could be captured into
// an autosave of half-server/half-user data.

import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../context/AppContext';
import { api } from '../api';
import { dateInputValue } from '../utils/format';

export function useNpTreatyDetail(contractId, quoteMode, { enabled = true } = {}) {
  const { state: appState } = useAppState();
  const slice = useMemo(() => appState.npTreatyDetail || {}, [appState.npTreatyDetail]);
  const sliceMatches = !!contractId && String(slice.contractId || '') === String(contractId);
  const [fetched, setFetched] = useState(null);

  useEffect(() => {
    // `enabled` lets shared chrome (useWizard) opt in only on NP routes —
    // fetching /non-prop for a proportional contract would 409.
    if (!enabled || !contractId || sliceMatches) return undefined;
    let cancelled = false;
    const qm = quoteMode ? { quote: true } : undefined;
    Promise.all([
      api.getContract(contractId, qm).catch(() => null),
      api.getNonPropTreaty(contractId, qm).catch(() => null),
    ]).then(([data, np]) => {
      if (cancelled || (!data && !np)) return;
      const h = data?.header || {};
      const d = np?.detail || {};
      const s = (v) => (v == null ? '' : String(v));
      setFetched({
        contractId,
        cedantId: s(h.cedant_id), cedantName: h.cedant_name || '',
        brokerId: s(h.broker_id), brokerName: h.broker_name || '',
        countryId: s(h.country_id), countryName: h.country_name || '',
        currencyId: s(h.currency_id), currencyCode: h.currency_code || '',
        treatyTypeId: s(h.treaty_type_id), treatyTypeName: h.treaty_type_name || '',
        startYear: s(h.uw_year),
        // Same 'YYYY-MM-DD' normalization the slice carries — pg date columns
        // otherwise serialize as full ISO timestamps and render raw.
        inceptionDate: dateInputValue(h.inception_date || ''),
        renewalDate: dateInputValue(h.renewal_date || ''),
        classIds: data?.class_ids || [],
        classOfBusinessIds: data?.class_ids || [],
        deductible: s(d.deductible), maxRetention: s(d.max_retention),
        accountingMethod: d.accounting_method || '', xlType: d.xl_type || '',
        accounts: d.accounts || '',
        numberOfLayers: s(d.number_of_layers),
        expiringNumberOfLayers: s(d.expiring_number_of_layers),
        quoteStructuresCount: s(d.structures_to_quote),
        brokeragePct: s(d.brokerage_pct), taxesPct: s(d.taxes_pct),
        noClaimsBonusPct: s(d.no_claims_bonus_pct),
        profitCommissionPct: s(d.profit_commission_pct),
        estGnpi: s(d.est_gnpi),
      });
    });
    return () => { cancelled = true; };
  }, [contractId, quoteMode, sliceMatches, enabled]);

  return useMemo(() => {
    if (sliceMatches) return slice;
    if (fetched && String(fetched.contractId) === String(contractId)) {
      // In-session edits made from screens that write the slice without an
      // identity (e.g. Structure's "Structures to Quote" control on a deep
      // link) must stay visible — spread them over the fetched bag. A slice
      // carrying a DIFFERENT contractId is stale and never merged.
      return slice.contractId ? fetched : { ...fetched, ...slice };
    }
    return slice; // pre-fetch: same empty bag as today
  }, [sliceMatches, slice, fetched, contractId]);
}

export default useNpTreatyDetail;
