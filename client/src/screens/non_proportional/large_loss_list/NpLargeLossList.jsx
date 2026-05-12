import LossListScreen from '../../shared/LossListScreen';
import { useAppState } from '../../../context/AppContext';
export default function NpLargeLossList() {
  const { state } = useAppState();
  const pfx = state.quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';
  return <LossListScreen routeKey="NP_LARGE_LOSS_LIST" title="Large Loss List" headerPill={`${pfx}: LARGE LOSSES`} lossType="large" pageClass="LARGE_LOSS_LIST_PAGE" quoteMode={!!state.quoteMode} />;
}
