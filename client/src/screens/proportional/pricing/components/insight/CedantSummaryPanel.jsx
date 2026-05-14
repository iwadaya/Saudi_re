// Thin shim — the real implementation lives in the shared CedantSummaryTabs
// component. Kept as a named export so existing PropPricing.jsx imports work
// unchanged.

import CedantSummaryTabs from '../../../../../components/cedant/CedantSummaryTabs';

export function CedantSummaryPanel(props) {
  return <CedantSummaryTabs {...props} mode="PROP" />;
}
