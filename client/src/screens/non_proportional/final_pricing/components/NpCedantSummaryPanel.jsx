// Thin shim — the real implementation lives in the shared CedantSummaryTabs
// component. Kept as a default export so existing NpFinalPricing.jsx imports
// work unchanged.

import CedantSummaryTabs from '../../../../components/cedant/CedantSummaryTabs';

export default function NpCedantSummaryPanel(props) {
  return <CedantSummaryTabs {...props} mode="NP" />;
}
