import { useState } from 'react';

/* ─── COB Multi-Select Modal — inline copy of QuickBenchmark's
       CobSelectModal so the Final Quote screen feels identical. ─── */
export default function FQCobSelectModal({ selected, cobList, onSave, onClose }) {
  const [sel, setSel] = useState(new Set(selected || []));
  const toggle = (id) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id); else n.add(id);
    setSel(n);
  };
  return (
    <div className="bm-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bm-modal" style={{ width: '100vw', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto' }}>
        <div className="bm-modal-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Select Lines of Business</span>
          <button className="bm-pill" onClick={onClose}>✕</button>
        </div>
        <div className="bm-modal-body" style={{ minHeight: 0, height: '100%', maxHeight: 'none', overflowY: 'auto', maxWidth: 720, width: '100%', margin: '0 auto', padding: '24px 28px' }}>
          {(cobList || []).map((c) => (
            <label key={c.id} className="bm-cob-row">
              <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
              {c.name}
            </label>
          ))}
        </div>
        <div className="bm-modal-actions">
          <button className="bm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="bm-btn-primary" onClick={() => onSave([...sel])}>Apply</button>
        </div>
      </div>
    </div>
  );
}
