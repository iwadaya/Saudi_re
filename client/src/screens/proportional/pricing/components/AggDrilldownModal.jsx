// AggDrilldownModal.jsx — Thin ui/Modal wrapper around the shared
// AggregateAnalysisPanel. The modal owns the chrome (glass shell + title); the
// drill-down body, data fetching and all behaviour live in the shared panel.
// Country/UW meta for the title is reported back via the panel's onMeta callback.
import { useState } from 'react';
import { Modal } from '../../../../components/ui';
import AggregateAnalysisPanel from '../../../shared/aggregate_analysis/AggregateAnalysisPanel.jsx';

export default function AggDrilldownModal({ contractId, shareRows: _shareRows, onClose }) {
  const [meta, setMeta] = useState(null);

  return (
    <Modal
      open
      onClose={onClose}
      className="glass agg-drilldown-modal"
      title={(
        <>
          ◈ Aggregate Analysis
          {meta?.country_name && <span className="agg-title__meta">{meta.country_name} · UW {meta.uw_year}</span>}
          <span className="agg-title__sub">Drill-down by zone, class of business and portfolio position</span>
        </>
      )}
    >
      <AggregateAnalysisPanel contractId={contractId} onMeta={setMeta} />
    </Modal>
  );
}
