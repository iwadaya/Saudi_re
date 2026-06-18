import ProfileScreen from '../../shared/ProfileScreen';
import { useAppState } from '../../../context/AppContext';

export default function PropRiskProfile() {
  const { state } = useAppState();
  return <ProfileScreen routeKey="PROP_RISK_PROFILE" title="Risk Profile" headerPill="PROPORTIONAL TREATY: RISK PROFILE" profileType="risk" quoteMode={!!state.quoteMode} />;
}
