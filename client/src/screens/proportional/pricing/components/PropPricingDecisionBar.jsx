// components/PropPricingDecisionBar.jsx — Phase 4.2 (docs/frontend-hardening.md).
//
// The underwriter-comment + Export Excel / Offer / Decline action bar,
// extracted from PropPricing.jsx with the JSX (including the Excel export
// payload — note the golden `epiSplit: (contract.epi_split || td.epiSplit
// || [])` fallback) verbatim. Props in, callbacks out.

import { cn } from './propPricingConstants';
import { exportPropContractWorkbook } from '../propWorkbookExporters.js';
import { logger } from '../../../../utils/logger';

export default function PropPricingDecisionBar({
  comment, setComment, setDirty, isReadOnly, offerStatus,
  setShowOffer, setShowDecline,
  td, appState, components, yearly, contract, shareRows, shareGrid, leads,
  contractId,
}) {
  return (
    <div className="bbg-block bbg-block--decision">
      <div className="bbg-decision-grid">
        <div className="bbg-decision-comment">
          <span className="bbg-flabel">Underwriter Comment</span>
          <textarea className="bbg-textarea" rows={3} value={comment}
            onChange={e => { if (!isReadOnly) { setComment(e.target.value); setDirty(true); } }}
            placeholder="Pricing rationale…" readOnly={isReadOnly}
            style={isReadOnly ? { opacity: 0.5, cursor: 'not-allowed' } : {}} />
        </div>
        <div className="bbg-decision-actions">
          <button
            className="bbg-btn"
            style={{ borderColor:'rgba(34,197,94,0.5)', color:'#4ade80', display:'flex', alignItems:'center', gap:6 }}
            title="Export the whole contract to Excel — one sheet per screen, in wizard order (Treaty Detail → Pricing)"
            onClick={() => {
              const finalData = {
                cedantName: td?.cedantName || '',
                countryName: td?.countryName || '',
                uwYear: td?.startYear || td?.uwYear || '',
                currency: td?.currencyCode || td?.currency || 'SAR',
                treatyType: td?.treatyTypeName || td?.treatyType || '',
                isQuote: !!appState.quoteMode,
                components,
                yearly,
                epiSplit: (contract.epi_split || td.epiSplit || []),
                shareRows,
                shareGrid,
                leads: leads && (leads.lead_reinsurer || leads.expiring_reinsurer)
                  ? [{ reinsurer_name: leads.lead_reinsurer, role: 'Lead', written_line_pct: leads.lead_share_pct },
                     leads.expiring_reinsurer ? { reinsurer_name: leads.expiring_reinsurer, role: 'Expiring', written_line_pct: null } : null
                    ].filter(Boolean)
                  : [],
                comment,
                totalEpi: cn(td?.quotaShareEpi || 0) + cn(td?.surplusEpi || 0),
                qsEpi: cn(td?.quotaShareEpi || 0),
                surplusEpi: cn(td?.surplusEpi || 0),
              };
              exportPropContractWorkbook({
                contractId,
                finalData,
                propDetail: td,
                triangulationsEnabled: appState.propTreatyDetail?.triangulationsAvailable !== false,
              }).catch((e) => { logger.error('Export failed', e); });
            }}
          >↓ Export Excel</button>
          <button className="bbg-btn bbg-btn--offer" onClick={() => setShowOffer(true)}>
            {isReadOnly ? 'View Offer' : offerStatus === 'AWAITING_APPROVAL' ? '⏳ Awaiting Approval' : offerStatus === 'AWAITING_SIGNED_LINE' ? '✍ Sign / NTU' : 'Offer Treaty'}
          </button>
          {!isReadOnly && offerStatus === 'DRAFT' && (
            <button className="bbg-btn bbg-btn--decline" onClick={() => setShowDecline(true)}>Decline</button>
          )}
        </div>
      </div>
    </div>
  );
}
