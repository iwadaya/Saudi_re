// StatusChip.jsx — analysis status → ui Badge (shared by the documents
// table status cell and the drawer header).
import { Badge } from '../../../../components/ui';
import { STATUS_TONES } from '../documentsShared';

export default function StatusChip({ status }) {
  if (!status) return null;
  return (
    <Badge tone={STATUS_TONES[status] || 'neutral'}>
      {status === 'RUNNING' ? 'Analysing…' : status}
    </Badge>
  );
}
