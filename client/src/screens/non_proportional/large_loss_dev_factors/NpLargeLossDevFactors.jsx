import NpLossDevFactors from '../large_loss_dev_factors/NpLossDevFactors';
import { useAppState } from '../../../context/AppContext';

export default function NpLargeLossDevFactors() {
  const { state } = useAppState();
  const pfx = state.quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';
  return (
    <NpLossDevFactors
      routeKey="NP_LARGE_LOSS_DEV_FACTORS"
      title="Large Loss Dev Factors"
      headerPill={`${pfx}: LARGE LOSS DEVELOPMENT FACTORS`}
      lossType="large"
    />
  );
}
