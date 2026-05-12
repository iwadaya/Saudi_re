import WordingChecklistPanel from '../../../shared/WordingChecklistPanel.jsx';

/** @param {{ contractId: string, isQuote?: boolean }} props */
export default function NpChecklistPanel({ contractId, isQuote = false }) {
  return <WordingChecklistPanel contractId={contractId} isQuote={isQuote} />;
}
