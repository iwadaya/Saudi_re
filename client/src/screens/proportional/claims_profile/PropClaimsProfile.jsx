import ProfileScreen from '../../shared/ProfileScreen';
import { useAppState } from '../../../context/AppContext';

export default function PropClaimsProfile() {
  const { state } = useAppState();
  return <ProfileScreen routeKey="PROP_CLAIMS_PROFILE" title="Claims Profile" headerPill="PROPORTIONAL TREATY: CLAIMS PROFILE" profileType="claims" quoteMode={!!state.quoteMode} />;
}
