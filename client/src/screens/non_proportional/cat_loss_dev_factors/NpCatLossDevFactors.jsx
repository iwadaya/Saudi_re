import NpLossDevFactors from '../large_loss_dev_factors/NpLossDevFactors';
import { useAppState } from '../../../context/AppContext';

export default function NpCatLossDevFactors() {
  const { state } = useAppState();
  const pfx = state.quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';
  return (
    <NpLossDevFactors
      routeKey="NP_CAT_LOSS_DEV_FACTORS"
      title="Cat Loss Dev Factors"
      headerPill={`${pfx}: CAT LOSS DEVELOPMENT FACTORS`}
      lossType="cat"
    />
  );
}
