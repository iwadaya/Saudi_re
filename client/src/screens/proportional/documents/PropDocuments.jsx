import { useAppState } from '../../../context/AppContext';
import DocumentsScreen from '../../shared/DocumentsScreen';

export default function PropDocuments() {
  const { state } = useAppState();
  const quoteMode = !!state.quoteMode;
  return (
    <DocumentsScreen
      routeKey="PROP_TREATY_DOCUMENTS"
      headerPill="PROPORTIONAL TREATY: DOCUMENTS"
      quoteMode={quoteMode}
    />
  );
}
