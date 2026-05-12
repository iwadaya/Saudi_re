import { useAppState } from '../../../context/AppContext';
import DocumentsScreen from '../../shared/DocumentsScreen';

export default function NpDocuments() {
  const { state } = useAppState();
  const quoteMode = !!state.quoteMode;
  return (
    <DocumentsScreen
      routeKey="NP_TREATY_DOCUMENTS"
      headerPill={quoteMode ? 'NP-QUOTE TREATY: DOCUMENTS' : 'NON-PROPORTIONAL TREATY: DOCUMENTS'}
      quoteMode={quoteMode}
    />
  );
}
