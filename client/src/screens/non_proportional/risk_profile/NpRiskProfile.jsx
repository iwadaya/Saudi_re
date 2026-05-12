import ProfileScreen from '../../shared/ProfileScreen';
import { useAppState } from '../../../context/AppContext';
export default function NpRiskProfile() {
  const { state } = useAppState();
  const pfx = state.quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';
  return <ProfileScreen routeKey="NP_RISK_PROFILE" title="Risk Profile" headerPill={`${pfx}: RISK PROFILE`} profileType="risk" quoteMode={!!state.quoteMode} />;
}
