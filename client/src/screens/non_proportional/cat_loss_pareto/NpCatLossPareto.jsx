import LossParetoScreen from '../../shared/LossParetoScreen';
import { useAppState } from '../../../context/AppContext';
export default function NpCatLossPareto() {
  const { state } = useAppState();
  const pfx = state.quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';
  return <LossParetoScreen routeKey="NP_CAT_LOSS_PARETO" title="Cat Loss Pareto" headerPill={`${pfx}: CAT LOSS PARETO`} lossType="cat" />;
}
