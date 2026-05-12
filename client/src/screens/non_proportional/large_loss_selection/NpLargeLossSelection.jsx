import LossSelectionScreen from '../../shared/LossSelectionScreen';
import { useAppState } from '../../../context/AppContext';
export default function NpLargeLossSelection() {
  const { state } = useAppState();
  const pfx = state.quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';
  return <LossSelectionScreen routeKey="NP_LARGE_LOSS_SELECTION" title="Large Loss Selection" headerPill={`${pfx}: LARGE LOSS SELECTION`} lossType="large" />;
}
