import LossListScreen from '../../shared/LossListScreen';
import { useAppState } from '../../../context/AppContext';
export default function NpCatLossList() {
  const { state } = useAppState();
  const pfx = state.quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';
  return <LossListScreen routeKey="NP_CAT_LOSS_LIST" title="Cat Loss List" headerPill={`${pfx}: CAT LOSSES`} lossType="cat" pageClass="CAT_LOSS_LIST_PAGE" quoteMode={!!state.quoteMode} />;
}
