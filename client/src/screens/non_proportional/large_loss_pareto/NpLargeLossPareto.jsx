import LossParetoScreen from '../../shared/LossParetoScreen';
import { useAppState } from '../../../context/AppContext';
export default function NpLargeLossPareto() {
  const { state } = useAppState();
  const pfx = state.quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';
  return <LossParetoScreen routeKey="NP_LARGE_LOSS_PARETO" title="Large Loss Pareto" headerPill={`${pfx}: LARGE LOSS PARETO`} lossType="large" />;
}
