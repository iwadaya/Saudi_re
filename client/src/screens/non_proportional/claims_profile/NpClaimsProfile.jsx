import ProfileScreen from '../../shared/ProfileScreen';
import { useAppState } from '../../../context/AppContext';
export default function NpClaimsProfile() {
  const { state } = useAppState();
  const pfx = state.quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY';
  return <ProfileScreen routeKey="NP_CLAIMS_PROFILE" title="Claims Profile" headerPill={`${pfx}: CLAIMS PROFILE`} profileType="claims" quoteMode={!!state.quoteMode} />;
}
