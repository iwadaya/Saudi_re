// RecommendationsList.jsx — the drawer's recommendations section:
// status groups (PENDING open by default, REJECTED collapsed), each
// sub-grouped by target_screen, rendering a RecommendationCard per rec.
import { useState } from 'react';
import RecommendationCard from './RecommendationCard';

// Collapsible status group containing per-screen sub-groups.
const REC_GROUP_TOGGLE_CLASS = {
  PENDING:    'facdoc-group-toggle--pending',
  ACCEPTED:   'facdoc-group-toggle--accepted',
  REJECTED:   'facdoc-group-toggle--rejected',
  SUPERSEDED: 'facdoc-group-toggle--superseded',
};

function RecGroup({ title, status, groups, startCollapsed = false, cardProps = {} }) {
  const [collapsed, setCollapsed] = useState(startCollapsed);
  const toneClass = REC_GROUP_TOGGLE_CLASS[status] || REC_GROUP_TOGGLE_CLASS.PENDING;
  const totalCount = groups.reduce((s, [, r]) => s + r.length, 0);
  if (totalCount === 0) return null;
  const {
    factorOptions, onAccept, onReject, busyRecs, justApplied, onUndo, getUndoState,
  } = cardProps;
  return (
    <div className="facdoc-group">
      <button type="button" aria-expanded={!collapsed}
              className={`facdoc-disclosure facdoc-disclosure--group ${toneClass}`}
              onClick={() => setCollapsed((v) => !v)}>
        <span>{collapsed ? '▸' : '▾'}</span>
        <span>{title}</span>
        <span className="facdoc-group-count">· {totalCount}</span>
      </button>
      {!collapsed && groups.map(([screen, list]) => (
        <div key={screen} className="facdoc-group-screen">
          <div className="facdoc-screen-label">
            {screen}
          </div>
          {list.map((rec) => (
            <RecommendationCard key={rec.recommendation_id} rec={rec}
                                factorOptions={factorOptions}
                                onAccept={onAccept} onReject={onReject}
                                onUndo={onUndo} getUndoState={getUndoState}
                                busy={busyRecs?.has(rec.recommendation_id)}
                                justApplied={justApplied?.has(rec.recommendation_id)} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function RecommendationsList({ recs, groupCollapseRef, cardProps }) {
  // Group: PENDING expanded by default, ACCEPTED expanded, REJECTED
  // collapsed. Order matters in the UI — show PENDING first.
  const grouped = { PENDING: [], ACCEPTED: [], REJECTED: [], SUPERSEDED: [] };
  for (const r of recs) (grouped[r.status] || (grouped.PENDING)).push(r);
  // Within each status group, sub-group by target_screen so the
  // underwriter sees per-screen impact at a glance.
  const groupByScreen = (list) => {
    const m = new Map();
    for (const r of list) {
      if (!m.has(r.target_screen)) m.set(r.target_screen, []);
      m.get(r.target_screen).push(r);
    }
    return Array.from(m.entries());
  };

  return (
    <div className="facdoc-recs">
      <div className="facdoc-section-label facdoc-section-label--recs">
        Recommendations ({recs.length})
      </div>
      {recs.length === 0 ? (
        <div className="facdoc-empty-recs">
          The model returned no actionable suggestions for this document.
        </div>
      ) : null}

      {/* PENDING — open by default */}
      <RecGroup title="Pending" status="PENDING" groups={groupByScreen(grouped.PENDING)}
                startCollapsed={false}
                cardProps={cardProps} />
      {grouped.ACCEPTED.length > 0 && (
        <RecGroup title="Accepted" status="ACCEPTED" groups={groupByScreen(grouped.ACCEPTED)}
                  startCollapsed={Boolean(groupCollapseRef.current.ACCEPTED)}
                  cardProps={cardProps} />
      )}
      {grouped.SUPERSEDED.length > 0 && (
        <RecGroup title="Superseded" status="SUPERSEDED" groups={groupByScreen(grouped.SUPERSEDED)}
                  startCollapsed
                  cardProps={cardProps} />
      )}
      {grouped.REJECTED.length > 0 && (
        <RecGroup title="Rejected" status="REJECTED" groups={groupByScreen(grouped.REJECTED)}
                  startCollapsed={Boolean(groupCollapseRef.current.REJECTED)}
                  cardProps={cardProps} />
      )}
    </div>
  );
}
