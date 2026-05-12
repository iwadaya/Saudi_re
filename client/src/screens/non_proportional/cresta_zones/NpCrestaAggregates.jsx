import PropCrestaAggregates from '../../proportional/cresta_zones/PropCrestaAggregates';

// NP uses same aggregates screen but with:
// - NP_CRESTA_AGGREGATES route key (so wizard navigation stays in NP flow)
// - Treaty type toggle is already suppressed for NP mode inside PropCrestaAggregates
export default function NpCrestaAggregates({ embedded = false }) {
  return <PropCrestaAggregates routeKeyOverride="NP_CRESTA_AGGREGATES" embedded={embedded} forceNp />;
}

