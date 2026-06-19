// WordingChecker.jsx — AI wording analysis: coverage, exclusions, grey areas, treaty check
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { api } from '../../api';

const WORDING_CHECKLIST = [
  { key: 'claimClause',           label: 'Claim Clause',                    required: true },
  { key: 'sanctionClause',        label: 'Sanction & Limitation Clause',     required: true },
  { key: 'cyberExclusion',        label: 'Cyber Loss Exclusion',             required: true },
  { key: 'warTerrorism',          label: 'War & Terrorism Exclusion',         required: true },
  { key: 'nuclearExclusion',      label: 'Nuclear Energy Exclusion',         required: true },
  { key: 'communicableDisease',   label: 'Communicable Disease Exclusion',   required: true },
  { key: 'arbitrationClause',     label: 'Arbitration / Dispute Resolution', required: true },
  { key: 'claimsCooperation',     label: 'Claims Cooperation Clause',        required: false },
  { key: 'interlocking',          label: 'Interlocking Clause',              required: false },
  { key: 'followSettlements',     label: 'Follow Settlements Clause',        required: false },
  { key: 'currencyClause',        label: 'Currency Clause',                  required: false },
  { key: 'errorOmission',         label: 'Errors & Omissions Clause',        required: false },
  { key: 'accessToRecords',       label: 'Access to Records Clause',         required: false },
  { key: 'insolvencyClause',      label: 'Insolvency Clause',                required: false },
  { key: 'catastropheDefinition', label: 'Catastrophe / Event Definition',   required: false },
];

const EXPECTED_DOC_TYPES = [
  { key: 'expiring',  label: 'Expiring Wording', match: /expir|prior.year|renewal.from|previous/i },
  { key: 'draftSlip', label: 'Draft Slip',        match: /draft|provisional/i },
  { key: 'finalSlip', label: 'Final Slip',         match: /final.slip|final.wording|signed.slip|binding/i },
];

const C = {
  found:   { bg: 'rgba(74,222,128,0.12)', border: 'rgba(74,222,128,0.35)',   text: '#4ade80' },
  missing: { bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.35)', text: '#f87171' },
  partial: { bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.35)',  text: '#fbbf24' },
  unknown: { bg: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.15)', text: 'rgba(148,163,184,0.6)' },
  info:    { bg: 'rgba(96,165,250,0.10)',  border: 'rgba(96,165,250,0.25)',  text: '#60a5fa' },
};

async function callLlm(system, user) {
  const data = await api.aiAnalyseJson({
    systemPrompt: system,
    userPrompt: user,
    maxOutputTokens: 4096,
  });
  return data?.text || '';
}

function Badge({ status, label }) {
  const c = C[status] || C.unknown;
  const icon = status === 'found' ? '✓' : status === 'missing' ? '✗' : status === 'partial' ? '~' : '?';
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:12,
      fontSize:10, fontWeight:700, background:c.bg, border:`1px solid ${c.border}`, color:c.text }}>
      {icon} {label}
    </span>
  );
}

function Section({ title, badge, children, expanded, onToggle }) {
  return (
    <div style={{ marginBottom:8, borderRadius:8, border:'1px solid rgba(255,255,255,0.08)', overflow:'hidden' }}>
      {/* Native <button> for the collapsible header — gets Enter/Space + focus
          for free (no manual role/tabIndex/onKeyDown). */}
      <button type="button" aria-expanded={expanded} onClick={onToggle}
        style={{ display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%',
        padding:'8px 12px', cursor:'pointer', border:'none', font:'inherit', textAlign:'left',
        background: expanded ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)' }}>
        <span style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.6)', textTransform:'uppercase', letterSpacing:'0.05em' }}>{title}</span>
          {badge}
        </span>
        <span style={{ fontSize:10, color:'rgba(255,255,255,0.3)' }}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && <div style={{ padding:'12px', borderTop:'1px solid rgba(255,255,255,0.06)' }}>{children}</div>}
    </div>
  );
}

function InfoBox({ items, color = 'rgba(255,255,255,0.55)' }) {
  if (!items?.length) return <div style={{ fontSize:11, color:'rgba(255,255,255,0.3)' }}>None identified.</div>;
  return (
    <ul style={{ margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4 }}>
      {items.map((item, i) => (
        <li key={i} style={{ fontSize:11, color, lineHeight:1.5 }}>{item}</li>
      ))}
    </ul>
  );
}

// Priority order for slip selection
const SLIP_PRIORITY = ['Final Slip', 'Draft Slip', 'Expiring Slip'];

function findBestSlip(docs) {
  if (!docs || !docs.length) return null;
  for (const type of SLIP_PRIORITY) {
    const found = docs.find(d => d.doc_type === type);
    if (found) return found;
  }
  // fallback: any doc with pdf
  return docs.find(d => /pdf/i.test(d.mime_type||'')) || docs[0] || null;
}

export default function WordingChecker({ contractId, parentContractId, docs: propDocs, onClauseResults, quoteMode = false, targetDoc = null, autoRun = false }) {
  // `contractId` is the active entity's id — under a quote it's a
  // quote_id, not a contract_id. The contract-scoped API helpers
  // (getDocuments / getContract) need { quote: true } to hit the
  // quote routes; without it they 404 or read the wrong row. Document
  // text lookups go via document_id and don't care which side owns
  // the contract, so they stay unscoped. parentContractId comes from
  // contract.parent_contract_id and always references the prior-year
  // *treaty* — no quote opt needed there either.
  const apiOpts = useMemo(() => (quoteMode ? { quote: true } : undefined), [quoteMode]);
  const [analysis, setAnalysis] = useState(null);
  const [running,  setRunning]  = useState(false);
  const [step,     setStep]     = useState('');
  const [error,    setError]    = useState('');
  // Primary sections (Coverages, Exclusions, Watchpoints) open by default;
  // secondary sections (Document Types, Clauses, Prior Year) collapsed so
  // the three headline blocks dominate the view.
  const [expanded, setExpanded] = useState({ coverage: true, exclusions: true, watchpoints: true, docTypes: false, clauses: false });
  const toggle = key => setExpanded(p => ({ ...p, [key]: !p[key] }));

  const run = useCallback(async () => {
    if (!contractId) return;
    setRunning(true); setError(''); setAnalysis(null);
    try {
      // ── 1. Load documents (use passed docs if available) ──
      setStep('Loading documents…');
      const currentDocs = propDocs && propDocs.length
        ? propDocs
        : await api.getDocuments(contractId, apiOpts).then(r => Array.isArray(r) ? r : []).catch(()=>[]);

      let priorDocs = [];
      if (parentContractId) {
        const priorRaw = await api.getDocuments(parentContractId).catch(()=>[]);
        priorDocs = Array.isArray(priorRaw) ? priorRaw : [];
      }

      // ── 2. Load contract detail for cross-check ──
      setStep('Loading contract terms…');
      let contractDetail = null;
      try { contractDetail = await api.getContract(contractId, apiOpts); } catch {}

      // ── 3. Classify docs ──
      setStep('Classifying documents…');
      const classifyDoc = d => {
        const str = `${d.title||''} ${d.file_name||''} ${d.doc_type||''}`.toLowerCase();
        if (/expir|prior.year|previous/i.test(str)) return 'expiring';
        if (/final.slip|final.wording|signed.slip|binding/i.test(str)) return 'finalSlip';
        if (/draft|provisional/i.test(str)) return 'draftSlip';
        if (/slip|wording|treaty.wording/i.test(str)) return 'wording';
        return 'other';
      };
      const classified  = currentDocs.map(d => ({ ...d, _docClass: classifyDoc(d) }));
      const priorClassified = priorDocs.map(d => ({ ...d, _docClass: classifyDoc(d) }));

      const docTypeStatus = {};
      EXPECTED_DOC_TYPES.forEach(dt => {
        docTypeStatus[dt.key] = classified.some(d =>
          d._docClass === dt.key || dt.match.test(`${d.title||''} ${d.file_name||''} ${d.doc_type||''}`)
        ) ? 'found' : 'missing';
      });

      // ── 4. Extract text from best wording doc ──
      setStep('Extracting wording text…');
      // When the caller pins a specific slip (e.g. row-level Analyze in
      // DocumentsScreen) we use that doc. Otherwise fall back to the
      // priority heuristic: Final Slip > Draft Slip > Expiring Slip > any PDF.
      const wordingDoc = targetDoc || findBestSlip(currentDocs);
      const priorWordingDoc = findBestSlip(priorDocs);

      let wordingText = '';
      let priorWordingText = '';

      if (wordingDoc) {
        try {
          const docId = wordingDoc.document_id || wordingDoc.id;
          const r = await api.getDocumentText(docId);
          wordingText = r.text || '';
        } catch(e) { console.warn('text extract:', e.message); }
      }
      if (priorWordingDoc) {
        try {
          const docId = priorWordingDoc.document_id || priorWordingDoc.id;
          const r = await api.getDocumentText(docId);
          priorWordingText = r.text || '';
        } catch {}
      }

      const hasText = wordingText.length > 200;
      const isRenewal = !!parentContractId;

      // ── 5. AI comprehensive analysis ──
      let aiResult = null;
      if (hasText) {
        setStep('AI analysing wording…');
        const detail = contractDetail;
        const det = detail?.detail || {};
        const comm = detail?.commissions || {};
        const h = detail?.header || {};
        const treatyTerms = JSON.stringify({
          treaty_type: h.treaty_type_name,
          qs_limit: det.qs_limit,
          retention_pct: det.retention_pct,
          cession_pct: det.cession_pct,
          brokerage_pct: det.brokerage_pct,
          commission_mode: comm.mode,
          inception_date: det.inception_date,
          renewal_date: det.renewal_date,
          experience_start_year: det.experience_start_year,
        });
        const clauseJsonLines = WORDING_CHECKLIST.map(c => `    "${c.key}": "found|missing|partial"`).join(',\n');
        const renewalBlock = parentContractId
          ? `"comparison": {"material_changes": true,"changes": [{"clause": "name","type": "added|removed|amended","description": "what changed"}],"comparison_summary": "overall summary"},`
          : `"new_business_flags": ["e.g. no expiring slip — recommend obtaining prior year terms"],`;
        const priorYearSection = priorWordingText
          ? `PRIOR YEAR WORDING (first 3000 chars):\n${priorWordingText.slice(0, 3000)}`
          : '';
        const userPrompt = [
          `TREATY WORDING (first 6000 chars):`,
          wordingText.slice(0, 6000),
          `CAPTURED TREATY TERMS:`,
          treatyTerms,
          `IS RENEWAL: ${!!parentContractId}`,
          priorYearSection,
          `Analyse and respond with this EXACT JSON structure:`,
          `{`,
          `  "coverage_summary": {"classes_covered": [],"territorial_scope": "","perils_covered": [],"treaty_type_confirmed": "","key_limits": []},`,
          `  "exclusions": {"explicit": [],"standard": [],"notable": []},`,
          `  "grey_areas": [],`,
          `  "watchpoints": [],`,
          `  "terms_match": {"ok": true,"discrepancies": []},`,
          `  "clauses": {`,
          clauseJsonLines,
          `  },`,
          `  "clause_summary": "one sentence overall assessment",`,
          `  ${renewalBlock}`,
          `  "overall_rating": "Green|Amber|Red",`,
          `  "overall_summary": "2-3 sentence executive summary"`,
          `}`,
        ].filter(Boolean).join('\n');

        const raw = await callLlm(
          'You are a senior reinsurance treaty wording analyst with 20+ years experience in MENA/GCC markets. Analyse treaty wording and respond ONLY with valid JSON — no markdown, no explanation outside the JSON.',
          userPrompt
        );


        try {
          aiResult = JSON.parse(raw.replace(/```json|```/g, '').trim());
        } catch {
          // Try to extract partial JSON
          try {
            const start = raw.indexOf('{');
            const end = raw.lastIndexOf('}');
            if (start > -1 && end > start) aiResult = JSON.parse(raw.slice(start, end+1));
          } catch {}
          if (!aiResult) aiResult = { overall_summary: 'AI analysis completed but response could not be parsed.', clause_summary: raw.slice(0,300) };
        }
      }

      // ── 6. Clause results (from AI or unknown) ──
      const clauseResults = {};
      WORDING_CHECKLIST.forEach(c => {
        clauseResults[c.key] = aiResult?.clauses?.[c.key] || 'unknown';
      });

      setAnalysis({
        classified, priorClassified, docTypeStatus, wordingDoc, priorWordingDoc,
        hasText, wordingText: wordingText.slice(0, 500),
        clauseResults, aiResult, isRenewal,
        wordingSource: wordingDoc?.doc_type || wordingDoc?.title || null,
        checkedAt: new Date().toLocaleString(),
      });
      // Fire callback so checklist can auto-populate
      if (onClauseResults && Object.keys(clauseResults).length) {
        onClauseResults(clauseResults);
      }
      setStep('');
    } catch(e) {
      setError(e.message || 'Analysis failed');
      setStep('');
    } finally { setRunning(false); }
  }, [contractId, onClauseResults, parentContractId, propDocs, apiOpts, targetDoc]);

  // Fire the analysis automatically once on mount when autoRun is true.
  // The modal wrapper uses this so the user doesn't have to click "Run"
  // a second time after opening the panel via the row-level Analyze button.
  const ranOnceRef = useRef(false);
  useEffect(() => {
    if (autoRun && !ranOnceRef.current && contractId) {
      ranOnceRef.current = true;
      run();
    }
  }, [autoRun, contractId, run]);

  const ratingColor = { Green: '#4ade80', Amber: '#fbbf24', Red: '#f87171' };
  const rating = analysis?.aiResult?.overall_rating;
  const requiredMissing = analysis ? WORDING_CHECKLIST.filter(c => c.required && analysis.clauseResults[c.key] === 'missing').length : 0;

  return (
    <div style={{ padding:'0 2px' }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <div>
          <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.55)', letterSpacing:'0.06em', textTransform:'uppercase' }}>
            Wording Analysis
            {rating && <span style={{ marginLeft:8, fontSize:12, color: ratingColor[rating]||'#fff' }}>● {rating}</span>}
          </div>
          {analysis && <div style={{ fontSize:10, color:'rgba(255,255,255,0.28)', marginTop:2 }}>Last checked: {analysis.checkedAt}</div>}
        </div>
        <button onClick={run} disabled={running} style={{
          padding:'6px 14px', borderRadius:8, border:'none', cursor: running ? 'wait' : 'pointer',
          background: running ? 'rgba(var(--accent-rgb),0.2)' : 'rgba(var(--accent-rgb),0.85)',
          color: running ? 'rgba(255,255,255,0.5)' : 'var(--accent-contrast)', fontSize:11, fontWeight:700,
        }}>
          {running ? `⟳ ${step}` : analysis ? '↺ Re-analyse' : '▶ Run Analysis'}
        </button>
      </div>

      {error && <div style={{ padding:'8px 12px', borderRadius:8, background:'rgba(248,113,113,0.12)', border:'1px solid rgba(248,113,113,0.3)', color:'#f87171', fontSize:11, marginBottom:10 }}>⚠ {error}</div>}

      {!analysis && !running && (
        <div style={{ padding:'20px', textAlign:'center', color:'rgba(255,255,255,0.28)', fontSize:12 }}>
          Click <b>Run Analysis</b> to analyse coverage, exclusions, clause completeness and compare with prior year.
        </div>
      )}

      {analysis && (<>

        {/* Source + Executive Summary */}
        <div style={{ padding:'10px 14px', borderRadius:8, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.10)', marginBottom:10 }}>
          {analysis.wordingSource && (
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6 }}>
              <span style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', color:'rgba(255,255,255,0.3)' }}>Analysed from</span>
              <span style={{ fontSize:10, fontWeight:800, padding:'2px 8px', borderRadius:8, background:'rgba(34,197,94,0.12)', border:'1px solid rgba(34,197,94,0.3)', color:'rgba(34,197,94,0.9)' }}>{analysis.wordingSource}</span>
            </div>
          )}
          {analysis.aiResult?.overall_summary ? (
            <>
              <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', marginBottom:4 }}>Executive Summary</div>
              <div style={{ fontSize:12, color:'rgba(255,255,255,0.80)', lineHeight:1.7 }}>{analysis.aiResult.overall_summary}</div>
            </>
          ) : (
            <div style={{ fontSize:12, color:'rgba(255,255,255,0.45)' }}>Analysis complete — see sections below for details.</div>
          )}
        </div>

        {/* Coverages */}
        {analysis.aiResult?.coverage_summary && (
          <Section title="Coverages" badge={<Badge status="info" label="AI" />}
            expanded={expanded.coverage} onToggle={() => toggle('coverage')}>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {analysis.aiResult.coverage_summary.treaty_type_confirmed && (
                <div style={{ fontSize:12, color:'#60a5fa', fontWeight:700 }}>{analysis.aiResult.coverage_summary.treaty_type_confirmed}</div>
              )}
              {analysis.aiResult.coverage_summary.territorial_scope && (
                <div>
                  <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', marginBottom:3 }}>Territorial Scope</div>
                  <div style={{ fontSize:11, color:'rgba(255,255,255,0.65)' }}>{analysis.aiResult.coverage_summary.territorial_scope}</div>
                </div>
              )}
              {analysis.aiResult.coverage_summary.classes_covered?.length > 0 && (
                <div>
                  <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', marginBottom:3 }}>Classes Covered</div>
                  <InfoBox items={analysis.aiResult.coverage_summary.classes_covered} color='rgba(255,255,255,0.65)' />
                </div>
              )}
              {analysis.aiResult.coverage_summary.perils_covered?.length > 0 && (
                <div>
                  <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', marginBottom:3 }}>Perils Covered</div>
                  <InfoBox items={analysis.aiResult.coverage_summary.perils_covered} color='rgba(255,255,255,0.65)' />
                </div>
              )}
              {analysis.aiResult.coverage_summary.key_limits?.length > 0 && (
                <div>
                  <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', marginBottom:3 }}>Key Limits</div>
                  <InfoBox items={analysis.aiResult.coverage_summary.key_limits} color='#60a5fa' />
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Exclusions */}
        {analysis.aiResult?.exclusions && (
          <Section title="Exclusions" badge={
            analysis.aiResult.exclusions.notable?.length > 0
              ? <Badge status="partial" label="Notable items" />
              : <Badge status="found" label="Standard" />
          } expanded={expanded.exclusions} onToggle={() => toggle('exclusions')}>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {analysis.aiResult.exclusions.explicit?.length > 0 && (
                <div>
                  <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', marginBottom:3 }}>Explicitly Excluded</div>
                  <InfoBox items={analysis.aiResult.exclusions.explicit} color='#f87171' />
                </div>
              )}
              {analysis.aiResult.exclusions.standard?.length > 0 && (
                <div>
                  <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', marginBottom:3 }}>Standard Exclusions</div>
                  <InfoBox items={analysis.aiResult.exclusions.standard} color='rgba(255,255,255,0.55)' />
                </div>
              )}
              {analysis.aiResult.exclusions.notable?.length > 0 && (
                <div>
                  <div style={{ fontSize:10, fontWeight:700, color:'#fbbf24', textTransform:'uppercase', marginBottom:3 }}>Notable / Unusual</div>
                  <InfoBox items={analysis.aiResult.exclusions.notable} color='#fbbf24' />
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Watchpoints (Concerns)
            Consolidates grey areas + watchpoints + terms-match discrepancies
            + required-but-missing clauses into a single list. Each item has
            a severity dot — amber for soft concerns, red for hard misses.
            One block, ordered red-first, keeps the underwriter's attention
            on the things that should worry them. */}
        {(() => {
          const grey  = analysis.aiResult?.grey_areas || [];
          const watch = analysis.aiResult?.watchpoints || [];
          const disc  = analysis.aiResult?.terms_match?.discrepancies || [];
          const missingRequired = WORDING_CHECKLIST.filter(
            c => c.required && analysis.clauseResults[c.key] === 'missing'
          );
          const items = [
            ...disc.map(text => ({ severity: 'red', text: `Terms discrepancy: ${text}` })),
            ...missingRequired.map(c => ({ severity: 'red', text: `Required clause missing: ${c.label}` })),
            ...watch.map(text => ({ severity: 'amber', text })),
            ...grey.map(text  => ({ severity: 'amber', text })),
          ];
          const redCount = items.filter(i => i.severity === 'red').length;
          const amberCount = items.length - redCount;
          const badge = items.length === 0
            ? <Badge status="found" label="Clear" />
            : redCount > 0
              ? <Badge status="missing" label={`${redCount} red · ${amberCount} amber`} />
              : <Badge status="partial" label={`${amberCount} item(s)`} />;
          return (
            <Section title="Watchpoints (Concerns)" badge={badge}
              expanded={expanded.watchpoints} onToggle={() => toggle('watchpoints')}>
              {items.length === 0 ? (
                <div style={{ fontSize:11, color:'#4ade80' }}>✓ No concerns identified.</div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {items.map((it, i) => {
                    const isRed = it.severity === 'red';
                    const dot   = isRed ? '#f87171' : '#fbbf24';
                    const bg    = isRed ? 'rgba(248,113,113,0.10)' : 'rgba(251,191,36,0.08)';
                    const bd    = isRed ? 'rgba(248,113,113,0.28)' : 'rgba(251,191,36,0.25)';
                    return (
                      <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:8, padding:'6px 10px', borderRadius:6, background:bg, border:`1px solid ${bd}` }}>
                        <span style={{ width:8, height:8, borderRadius:999, background:dot, marginTop:5, flexShrink:0 }} />
                        <div style={{ fontSize:11, color: isRed ? '#f87171' : '#fbbf24', lineHeight:1.5 }}>{it.text}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
          );
        })()}

        {/* Document Types — collapsed by default in the modal view */}
        <Section title="Document Types" badge={
          EXPECTED_DOC_TYPES.every(dt => analysis.docTypeStatus[dt.key]==='found')
            ? <Badge status="found" label="Complete" />
            : <Badge status="missing" label="Incomplete" />
        } expanded={expanded.docTypes} onToggle={() => toggle('docTypes')}>
          <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
            {EXPECTED_DOC_TYPES.map(dt => {
              const st = analysis.docTypeStatus[dt.key];
              const col = C[st] || C.unknown;
              const docs = analysis.classified.filter(d => d._docClass===dt.key || dt.match.test(`${d.title||''} ${d.file_name||''}`));
              return (
                <div key={dt.key} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', borderRadius:6, background:col.bg, border:`1px solid ${col.border}` }}>
                  <span style={{ color:col.text, fontSize:13 }}>{st==='found' ? '✓' : '✗'}</span>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:11, color:'rgba(255,255,255,0.75)', fontWeight:600 }}>{dt.label}</div>
                    {docs.length > 0 && <div style={{ fontSize:10, color:'rgba(255,255,255,0.35)', marginTop:1 }}>{docs.map(d=>d.title||d.file_name).join(', ')}</div>}
                  </div>
                </div>
              );
            })}
            {!analysis.isRenewal && analysis.docTypeStatus.expiring === 'missing' && (
              <div style={{ fontSize:11, color:'#fbbf24', padding:'6px 8px', background:'rgba(251,191,36,0.08)', borderRadius:6, border:'1px solid rgba(251,191,36,0.2)' }}>
                ⚠ New business — recommend obtaining expiring slip or prior year terms for benchmarking.
              </div>
            )}
          </div>
        </Section>

        {/* Clause Checklist */}
        <Section title="Clause Checklist" badge={
          !analysis.hasText ? <Badge status="unknown" label="No text extracted" /> :
          requiredMissing > 0 ? <Badge status="missing" label={`${requiredMissing} required missing`} /> :
          <Badge status="found" label="All required present" />
        } expanded={expanded.clauses} onToggle={() => toggle('clauses')}>
          {analysis.aiResult?.clause_summary && (
            <div style={{ fontSize:11, color:'rgba(255,255,255,0.45)', marginBottom:8, fontStyle:'italic', padding:'5px 8px', background:'rgba(255,255,255,0.04)', borderRadius:6 }}>
              {analysis.aiResult.clause_summary}
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4 }}>
            {WORDING_CHECKLIST.map(c => {
              const st = analysis.clauseResults[c.key] || 'unknown';
              const col = C[st] || C.unknown;
              return (
                <div key={c.key} style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 8px', borderRadius:6, background:col.bg, border:`1px solid ${col.border}` }}>
                  <span style={{ fontSize:12, color:col.text, flexShrink:0 }}>
                    {st==='found'?'✓':st==='missing'?'✗':st==='partial'?'~':'?'}
                  </span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:10, color:'rgba(255,255,255,0.75)', fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.label}</div>
                    {c.required && st !== 'found' && <div style={{ fontSize:9, color:'#f87171', fontWeight:700 }}>REQUIRED</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        {/* Prior Year Comparison */}
        {analysis.isRenewal && (
          <Section title="Prior Year Comparison" badge={
            !analysis.aiResult?.comparison ? <Badge status="unknown" label="No prior text" /> :
            analysis.aiResult.comparison.material_changes ? <Badge status="partial" label="Material changes" /> :
            <Badge status="found" label="No material changes" />
          } expanded={expanded.comparison} onToggle={() => toggle('comparison')}>
            {analysis.aiResult?.comparison ? (<>
              {analysis.aiResult.comparison.comparison_summary && (
                <div style={{ fontSize:11, color:'rgba(255,255,255,0.55)', marginBottom:8, fontStyle:'italic', padding:'6px 8px', background:'rgba(255,255,255,0.04)', borderRadius:6 }}>
                  {analysis.aiResult.comparison.comparison_summary}
                </div>
              )}
              {analysis.aiResult.comparison.changes?.length > 0 ? (
                <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                  {analysis.aiResult.comparison.changes.map((ch,i) => {
                    const tc = ch.type==='added' ? '#4ade80' : ch.type==='removed' ? '#f87171' : '#fbbf24';
                    return (
                      <div key={i} style={{ padding:'6px 10px', borderRadius:6, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', display:'flex', gap:8 }}>
                        <span style={{ fontSize:10, fontWeight:800, color:tc, flexShrink:0, textTransform:'uppercase' }}>{ch.type}</span>
                        <div>
                          <div style={{ fontSize:11, color:'rgba(255,255,255,0.8)', fontWeight:600 }}>{ch.clause}</div>
                          <div style={{ fontSize:10, color:'rgba(255,255,255,0.45)', marginTop:1 }}>{ch.description}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : <div style={{ fontSize:11, color:'rgba(255,255,255,0.35)' }}>No changes detected.</div>}
            </>) : (
              <div style={{ fontSize:11, color:'rgba(255,255,255,0.35)' }}>
                {analysis.priorClassified.length === 0
                  ? 'No documents in prior year contract. Upload prior year slip to enable comparison.'
                  : 'Prior year document found but text could not be extracted (may be a scanned PDF).'}
              </div>
            )}
          </Section>
        )}

        {/* New Business Flags */}
        {!analysis.isRenewal && analysis.aiResult?.new_business_flags?.length > 0 && (
          <Section title="New Business Flags" badge={<Badge status="partial" label={`${analysis.aiResult.new_business_flags.length} flag(s)`} />}
            expanded={expanded.nbFlags} onToggle={() => toggle('nbFlags')}>
            <InfoBox items={analysis.aiResult.new_business_flags} color='#fbbf24' />
          </Section>
        )}

      </>)}
    </div>
  );
}
