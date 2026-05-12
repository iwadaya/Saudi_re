import LossSelectionScreen from '../../shared/LossSelectionScreen';
import { useAppState } from '../../../context/AppContext';
export default function NpCatLossSelection() {
  const { state } = useAppState();
  const pfx = state.quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';
  return <LossSelectionScreen routeKey="NP_CAT_LOSS_SELECTION" title="Cat Loss Selection" headerPill={`${pfx}: CAT LOSS SELECTION`} lossType="cat" />;
}
