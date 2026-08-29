// components/FQEqDamageRatioTab.jsx — "EQ Damage Ratios" tab body for the NP
// pricing workbench. Thin host adapter (kept out of FQPricingAnalysisModal so
// that file stays under its 800-line cap, same as FQPlaceholderTab): derives
// the structure's cat layers, gates on EQ relevance, and wires the panel's
// onApplyToCat callback to the quote per-layer setter.
import GemDamageRatioPanel from '../../cat_exposure/GemDamageRatioPanel.jsx';
import FQPlaceholderTab from './FQPlaceholderTab.jsx';
import { cn, fmtRol, layerHit } from '../../../../utils/npPricingEngine.js';

// GEM hands back a ground-up EQ loss in CURRENCY; catPureBurn is a percent
// (ROL) string everywhere else — npPricingEngine writes fmtRol(rol) with
// rol = annual layer loss / limit (calcPureBurningCost step 6), and
// fqQuoteMath's saneRolOrEmpty silently discards values above 100%. Cut the
// scenario loss to the layer and rate it on the layer limit; never write a
// raw currency amount into the percent field. Returns null when the layer
// has no positive limit (no denominator — caller must skip the write).
// Kept in sync with the same helper in NpInsightModal.jsx.
function eqLossToCatPureBurn(groundUpEqLoss, layer) {
  const limit = cn(layer?.limit ?? layer?.layer_limit);
  if (!(limit > 0)) return null;
  const attach = cn(layer?.attachment ?? layer?.deductible);
  const rol = layerHit(cn(groundUpEqLoss), attach, limit) / limit;
  return rol > 0 ? fmtRol(rol) : '0.00%';
}

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
  // Only cat layers with a positive limit can accept the converted burning
  // cost — the panel's Apply button disables when none qualify. (The tab
  // itself still shows whenever the structure carries any cat cover.)
  const appliableCatLayers = catLayers.filter((l) => cn(l.limit) > 0);

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

  // Convert the GEM ground-up EQ loss to the (first appliable) cat layer's
  // pure-burn ROL % and push it via the quote per-layer setter; persistence
  // rides the workbench's normal save path (no bespoke save here).
  const onApplyToCat = (groundUpEqLoss) => {
    const target = appliableCatLayers[0];
    const lIdx = target ? layers.indexOf(target) : -1;
    if (lIdx < 0) return;
    const rolPct = eqLossToCatPureBurn(groundUpEqLoss, target);
    if (rolPct != null) updateClientStructureLayer(sIdx, lIdx, 'catPureBurn', rolPct);
  };

  return (
    <GemDamageRatioPanel
      contractId={contractId}
      catLayers={appliableCatLayers}
      currency={currency}
      onApplyToCat={onApplyToCat}
      disabled={disabled}
    />
  );
}
