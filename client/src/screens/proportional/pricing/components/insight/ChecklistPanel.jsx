import WordingChecklistPanel from '../../../../shared/WordingChecklistPanel.jsx';

export function ChecklistPanel({ contractId, isQuote = false }) {
  return <WordingChecklistPanel contractId={contractId} isQuote={isQuote} />;
}
