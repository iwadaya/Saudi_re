// src/screens/facultative/documents/FacDocuments.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useFacRiskId } from '../../../hooks/useContractId';

const ROUTE_KEY = 'FAC_DOCUMENTS';

const DOC_TYPES = ['SURVEY_REPORT', 'POLICY_WORDING', 'SLIP', 'RISK_NOTE', 'LOSS_REPORT', 'OTHER'];
const DOC_LABELS = { SURVEY_REPORT: 'Survey Report', POLICY_WORDING: 'Policy Wording', SLIP: 'Signing Slip', RISK_NOTE: 'Risk Note', LOSS_REPORT: 'Loss Report', OTHER: 'Other' };

export default function FacDocuments() {
  const riskId = useFacRiskId();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newType, setNewType] = useState('SURVEY_REPORT');
  const [newNotes, setNewNotes] = useState('');
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    if (!riskId) return;
    setLoading(true);
    try {
      const data = await api.facGetDocuments(riskId);
      setDocs(data || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [riskId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      await api.facUploadDocument(riskId, { doc_type: newType, file_name: newName, notes: newNotes });
      setNewName(''); setNewNotes('');
      load();
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (docId) => {
    try {
      await api.facDeleteDocument(docId);
      load();
    } catch (e) { console.error(e); }
  };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Documents" headerPill="FACULTATIVE">
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '8px 0 40px' }}>
        <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.55)', marginBottom: 16 }}>
          Attach survey reports, original policy wordings, risk notes, and loss reports. Survey reports should be no older than 2 years.
        </div>

        {/* Add document form */}
        <div style={{ padding: 16, background: 'rgba(8,14,30,0.60)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(0,212,255,0.55)', marginBottom: 12 }}>Add Document</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginBottom: 4 }}>Type</div>
              <select className="fi" value={newType} onChange={e => setNewType(e.target.value)} style={{ width: 160 }}>
                {DOC_TYPES.map(t => <option key={t} value={t}>{DOC_LABELS[t]}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginBottom: 4 }}>Document Name</div>
              <input className="fi" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. SABIC Plant Survey 2025.pdf" />
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginBottom: 4 }}>Notes</div>
              <input className="fi" value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Optional notes" />
            </div>
            <button onClick={handleAdd} style={{
              appearance: 'none', border: 'none', background: 'linear-gradient(135deg, #23d18b, #0aa36a)',
              color: '#08140e', borderRadius: 8, padding: '8px 16px', fontSize: 11, fontWeight: 800, cursor: 'pointer',
            }}>Add</button>
          </div>
        </div>

        {/* Documents list */}
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'rgba(148,163,184,0.40)', fontSize: 12 }}>Loading…</div>
        ) : docs.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'rgba(148,163,184,0.30)', fontSize: 12 }}>No documents attached yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'rgba(5,8,16,0.6)' }}>
                {['Type', 'Document Name', 'Notes', 'Added', ''].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.50)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {docs.map(d => (
                <tr key={d.document_id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.20)', color: '#00d4ff' }}>{DOC_LABELS[d.doc_type] || d.doc_type}</span>
                  </td>
                  <td style={{ padding: '10px 12px', fontWeight: 600, color: 'rgba(226,232,240,0.85)' }}>{d.file_name || '—'}</td>
                  <td style={{ padding: '10px 12px', color: 'rgba(148,163,184,0.55)' }}>{d.notes || '—'}</td>
                  <td style={{ padding: '10px 12px', color: 'rgba(148,163,184,0.40)', fontSize: 11 }}>{d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ cursor: 'pointer', color: '#f87171', fontSize: 11, fontWeight: 600 }} onClick={() => handleDelete(d.document_id)}>Delete</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </WizardLayout>
  );
}
