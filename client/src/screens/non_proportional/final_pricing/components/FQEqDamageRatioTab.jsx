// components/FQEqDamageRatioTab.jsx — "EQ Damage Ratios" tab body for the NP
// pricing workbench. Thin host adapter (kept out of FQPricingAnalysisModal so
// that file stays under its 800-line cap, same as FQPlaceholderTab): derives
// the structure's cat layers, gates on EQ relevance, and wires the panel's
// onApplyToCat callback to the quote per-layer setter.
import EqDamageRatioPanel from './EqDamageRatioPanel.jsx';
import FQPlaceholderTab from './FQPlaceholderTab.jsx';

/**
 * @param {{
 *   structure: { layers?: Array<object> } | null,
 *   sIdx: number,
 *   contractId?: string,
 *   currency: string,
 *   catDisabled: boolean,
 *   updateClientStructureLayer: (sIdx:number, lIdx:number, field:string, value:unknown) => void,
 *   disabled?: boolean,
 * }} props
 */
export default function FQEqDamageRatioTab({
  structure, sIdx, contractId, currency, catDisabled, updateClientStructureLayer, disabled = false,
}) {
  const layers = structure?.layers || [];
  const catLayers = layers.filter((l) => l.cat);

  // EQ-relevant = the structure actually carries cat cover. (The panel itself
  // then gates again on captured CRESTA EQ aggregates.) Otherwise a one-liner.
  if (catDisabled || catLayers.length === 0) {
    return (
      <FQPlaceholderTab
        title="EQ Damage Ratios"
        line="Add a cat-covering layer to this structure to rate earthquake exposure from GEM damage-ratio curves."
      />
    );
  }

  // Push the GEM ground-up EQ loss into the (first) cat layer's burning-cost
  // field via the quote per-layer setter; persistence rides the workbench's
  // normal save path (no bespoke save here).
  const onApplyToCat = (groundUpEqLoss) => {
    const lIdx = layers.indexOf(catLayers[0]);
    if (lIdx >= 0) updateClientStructureLayer(sIdx, lIdx, 'catPureBurn', Math.round(groundUpEqLoss));
  };

  return (
    <EqDamageRatioPanel
      contractId={contractId}
      catLayers={catLayers}
      currency={currency}
      onApplyToCat={onApplyToCat}
      disabled={disabled}
    />
  );
}
