import { fmtPct, UW_MAX_LIMIT } from './propPricingConstants.js';
import { useGlobalToast } from '../../../../hooks/useToast';
import PctInput from '../../../../components/PctInput';

/*
  PropOfferModal — the full-screen offer, approval & workflow modal.

  Props:
    show              – bool
    onClose           – fn
    offerStatus       – string
    offerLine, setOfferLine
    offerComment, setOfferComment
    offerApprover, setOfferApprover
    returnReason, setReturnReason
    signedLinePct, setSignedLinePct
    approvalTrail     – array
    isCU, actorName
    isTerminal        – bool
    marginAct, marginUw, crAct, crUw
    epi, limit, eventLimit
    fxInverse, safeCcy, money
    aiCalc            – {aiLinePct, aiPremLine, aiLimitLine, aiWithinAuth, heatLabel, heatColor, reason, premScore, margScore}
    onSubmitForApproval, onMarkApproved, onMarkSigned, onMarkNTU, onReturnToUW, onDecline
*/
export default function PropOfferModal({
  show, onClose, offerStatus, offerLine, setOfferLine,
  offerComment, setOfferComment, offerApprover, setOfferApprover,
  returnReason, setReturnReason, signedLinePct, setSignedLinePct: _setSignedLinePct,
  approvalTrail, isCU, actorName, isTerminal,
  marginAct, marginUw, crAct, crUw, epi, limit, eventLimit,
  fxInverse, safeCcy, money, aiCalc,
  onSubmitForApproval, onMarkApproved, onMarkSigned: _onMarkSigned, onMarkNTU: _onMarkNTU, onReturnToUW,
  onDecline, onRecall,
  eligibleApprovers,
  // Quote → signed/bind is disabled in this build. When true, the
  // AWAITING_SIGNED_LINE workflow renders as a terminal "Quote
  // Approved (standalone)" card instead of showing the Mark
  // Signed / NTU UI. Treaty mode is unaffected. The unused
  // setSignedLinePct/onMarkSigned/onMarkNTU props are accepted but
  // intentionally inert until the bind workflow is re-enabled.
  isQuote = false,
}) {
  const showToast = useGlobalToast();
  if(!show) return null;

  const stepIndex = offerStatus==='DRAFT'?0:offerStatus==='AWAITING_APPROVAL'?1:offerStatus==='AWAITING_SIGNED_LINE'?2:3;
  const steps = [
    {k:'Draft',s:'DRAFT'},{k:'Awaiting Approval',s:'AWAITING_APPROVAL'},
    {k:'Awaiting Signed Line',s:'AWAITING_SIGNED_LINE'},
    {k:offerStatus==='NTU'?'NTU':'Signed/Complete',s:'COMPLETE'},
  ];

  const uwMaxLimitCcy = Math.round(UW_MAX_LIMIT*(fxInverse>0?fxInverse:1));
  const linePctNum = (()=>{ const n=parseFloat(String(offerLine||'').replace(/%/g,'').trim()); return Number.isFinite(n)?n/100:0; })();
  const linePremium = Math.round(epi*linePctNum);
  const lineLimit   = Math.round(limit*linePctNum);
  const overLimit   = lineLimit>uwMaxLimitCcy;

  return (
    <div className="bbg-modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="bbg-modal bbg-modal--fullscreen off-modal">
        <div className="bbg-modal-head" style={{flexShrink:0}}>
          <span className="bbg-modal-title">
            {isCU&&offerStatus==='AWAITING_APPROVAL'?'🔐 Chief Underwriter Review':'Offer Treaty'}
          </span>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <span style={{fontSize:11,color:'rgba(255,255,255,0.38)'}}>Viewing as <b style={{color:'rgba(255,255,255,0.7)'}}>{actorName}</b></span>
            <span className={`bbg-status bbg-status--${offerStatus.toLowerCase()}`}>{offerStatus.replace(/_/g,' ')}</span>
            <button className="bbg-modal-x" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="bbg-modal-body" style={{overflowY:'auto',flex:1,minHeight:0,padding:'16px 20px',display:'flex',flexDirection:'column',gap:14}}>
          {/* Stepper */}
          <div className="off-steps">
            {steps.map((s,i)=>{
              const isDone=i<stepIndex,isActive=i===stepIndex;
              return (<div key={i} className={`off-step${isDone?' done-line':''}`}>
                <div className={`off-step-dot ${isDone?'done':isActive?'active':''}`}>{isDone?'✓':i+1}</div>
                <div className={`off-step-label ${isActive?'active':''}`}>{s.k}</div>
              </div>);
            })}
          </div>

          {/* 3-col grid */}
          <div className="off-body">
            {/* COL 1: Line + mandates */}
            <div className="off-col">
              <div className="off-card">
                <div className="off-card-title">Written Line</div>
                <PctInput className="off-line-input"
                  value={offerLine}
                  onChange={v=>{if(!isTerminal)setOfferLine(v);}}
                  placeholder="0.0%" readOnly={isTerminal}
                  style={isTerminal?{opacity:0.65,cursor:'not-allowed'}:{}}/>
                <div className="off-row"><span className="off-k">100% Premium</span><span className="off-v">{money(epi)}</span></div>
                <div className="off-row"><span className="off-k">100% Limit</span><span className="off-v">{money(limit)}</span></div>
                <div className="off-row"><span className="off-k">100% Event Limit</span><span className="off-v">{money(eventLimit)}</span></div>
                <div className="off-row" style={{marginTop:6,paddingTop:8,borderTop:'1px solid rgba(255,255,255,0.08)'}}>
                  <span className="off-k">Line Premium</span><span className="off-v">{linePremium?money(linePremium):'—'}</span></div>
                <div className="off-row"><span className="off-k">Line Limit</span><span className={`off-v ${overLimit?'bad':''}`}>{lineLimit?money(lineLimit):'—'}{overLimit?' ⚠':''}</span></div>
                <div className="off-row"><span className="off-k" style={{color:'rgba(255,255,255,0.3)'}}>Authority Max</span><span className="off-v" style={{color:'rgba(255,255,255,0.35)'}}>{money(uwMaxLimitCcy)}{safeCcy!=='USD'?<span style={{fontSize:10,opacity:0.5,marginLeft:4}}>(USD 50m)</span>:''}</span></div>
              </div>

              {/* Standalone-quote terminal: APPROVED is the end of the road
                  for quotes in this build (sign + bind are disabled). */}
              {isQuote && (offerStatus==='APPROVED'||offerStatus==='AWAITING_SIGNED_LINE') && (
                <div className="off-card" style={{border:'1px solid rgba(35,209,139,0.30)',background:'rgba(35,209,139,0.04)'}}>
                  <div className="off-card-title" style={{color:'#23d18b'}}>✅ Quote Approved</div>
                  <div style={{fontSize:12,color:'rgba(255,255,255,0.55)',marginTop:6}}>
                    Quotes run as standalone artefacts in this build — no Mark Signed, no Bind to Contract.
                    Use Request Amendment if the cedant comes back with changes.
                  </div>
                </div>
              )}

              <div className="off-card">
                <div className="off-card-title">Underwriter Mandates</div>
                <div className="off-check"><span className="off-check-icon">{overLimit?'❌':'✅'}</span><div><div className="off-check-label">Within authority limit</div>{overLimit&&<div className="off-check-sub">Limit {money(lineLimit)} exceeds {money(uwMaxLimitCcy)}</div>}</div></div>
                <div className="off-check"><span className="off-check-icon">✅</span><div><div className="off-check-label">Mandated classes only</div></div></div>
              </div>
            </div>

            {/* COL 2: AI + heatmap */}
            <div className="off-col">
              <div className="off-ai">
                <div className="off-ai-head">
                  <div className="off-ai-label">✦ AI Suggested Line Size</div>
                  {!isTerminal&&<button className="off-ai-apply" type="button" onClick={()=>setOfferLine(String(aiCalc.aiLinePct))}>Apply →</button>}
                </div>
                <div className="off-ai-number"><div className="off-ai-pct">{aiCalc.aiLinePct.toFixed(1)}</div><div className="off-ai-unit">%</div></div>
                <div className="off-ai-reason">{aiCalc.reason}</div>
                <div className="off-ai-econ">
                  <div className="off-ai-econ-item"><span className="off-ai-econ-k">Line Premium</span><span className="off-ai-econ-v">{aiCalc.aiPremLine?money(aiCalc.aiPremLine):'—'}</span></div>
                  <div className="off-ai-econ-item"><span className="off-ai-econ-k">Line Limit</span><span className={`off-ai-econ-v ${!aiCalc.aiWithinAuth?'bad':''}`}>{aiCalc.aiLimitLine?money(aiCalc.aiLimitLine):'—'}</span></div>
                  <div className="off-ai-econ-item"><span className="off-ai-econ-k">Authority</span><span className={`off-ai-econ-v ${aiCalc.aiWithinAuth?'ok':'bad'}`}>{aiCalc.aiWithinAuth?'✓ Within':'✗ Exceeds'}</span></div>
                </div>
              </div>
              <div className="off-hm-wrap">
                <div className="off-hm-title">Treaty Classification</div>
                <div className="off-hm-matrix">
                  <div className="off-hm-axlabel"></div><div className="off-hm-axlabel">LOW MARGIN</div><div className="off-hm-axlabel">HIGH MARGIN</div>
                  <div className="off-hm-axlabel vert">HIGH PREM</div>
                  <div className={`off-hm-cell off-hm-c-blue ${aiCalc.premScore>65&&aiCalc.margScore<=65?'off-hm-active':''}`}><span className="off-hm-cell-name">Premium<br/>Driver</span><span className="off-hm-cell-sub">Bulk volume,<br/>thin margin</span></div>
                  <div className={`off-hm-cell off-hm-c-purple ${aiCalc.premScore>65&&aiCalc.margScore>65?'off-hm-active':''}`}><span className="off-hm-cell-name">Premium &amp;<br/>Margin Driver</span><span className="off-hm-cell-sub">Best of both</span></div>
                  <div className="off-hm-axlabel vert">LOW PREM</div>
                  <div className={`off-hm-cell off-hm-c-slate ${aiCalc.premScore<=65&&aiCalc.margScore<=65?'off-hm-active':''}`}><span className="off-hm-cell-name">Balanced</span><span className="off-hm-cell-sub">Average<br/>profile</span></div>
                  <div className={`off-hm-cell off-hm-c-green ${aiCalc.premScore<=65&&aiCalc.margScore>65?'off-hm-active':''}`}><span className="off-hm-cell-name">Margin<br/>Driver</span><span className="off-hm-cell-sub">High quality,<br/>lower volume</span></div>
                </div>
                <div className="off-hm-scores">
                  <div className="off-hm-score-item">Premium Score <b style={{color:'#00d4ff'}}>{aiCalc.premScore}/100</b></div>
                  <div className="off-hm-score-item">Margin Score <b style={{color:'#4ade80'}}>{aiCalc.margScore}/100</b></div>
                  <div className="off-hm-score-item">Classification <b style={{color:aiCalc.heatColor}}>{aiCalc.heatLabel}</b></div>
                </div>
              </div>
            </div>

            {/* COL 3: Metrics + CU/UW action cards */}
            <div className="off-col">
              <div className="off-card">
                <div className="off-card-title">Portfolio Metrics</div>
                <div className="off-row"><span className="off-k">Actuarial Margin</span><span className={`off-v ${marginAct>=0.05?'ok':marginAct>=0?'':'bad'}`}>{fmtPct(marginAct)}</span></div>
                <div className="off-row"><span className="off-k">UW Margin</span><span className={`off-v ${marginUw>=0.05?'ok':'bad'}`}>{fmtPct(marginUw)}</span></div>
                <div className="off-row"><span className="off-k">Engine CR</span><span className={`off-v ${crAct<=1?'ok':'bad'}`}>{fmtPct(crAct)}</span></div>
                <div className="off-row"><span className="off-k">UW CR</span><span className={`off-v ${crUw<=1?'ok':'bad'}`}>{fmtPct(crUw)}</span></div>
                <div className="off-row"><span className="off-k">UW Result</span><span className={`off-v ${marginUw>=0.08?'ok':marginUw>=0.03?'':'bad'}`}>{fmtPct(marginUw)}</span></div>
              </div>

              {/* CU decision */}
              {isCU&&offerStatus==='AWAITING_APPROVAL'&&(
                <div className="off-card" style={{border:'1px solid rgba(251,191,36,0.30)',background:'rgba(251,191,36,0.04)'}}>
                  <div className="off-card-title" style={{color:'#fbbf24'}}>🔐 Chief Underwriter Decision</div>
                  <div style={{fontSize:12,color:'rgba(255,255,255,0.50)',marginBottom:8}}>Submitted by underwriter for your review. You may adjust the written line before approving.</div>
                  <div style={{marginBottom:10}}>
                    <div style={{fontSize:11,fontWeight:700,letterSpacing: 0, textTransform:'uppercase',color:'rgba(255,255,255,0.35)',marginBottom:4}}>Written Line</div>
                    <PctInput className="off-line-input"
                      value={offerLine}
                      onChange={v=>setOfferLine(v)}
                      placeholder="0.0%" style={{fontSize:22,padding:'6px 10px',marginBottom:6}}/>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'4px 10px',fontSize:12}}>
                      <div style={{color:'rgba(255,255,255,0.45)'}}>Line Premium</div>
                      <div style={{color:'#60a5fa',fontWeight:700,textAlign:'right'}}>{linePremium?money(linePremium):'—'}</div>
                      <div style={{color:'rgba(255,255,255,0.45)'}}>Line Limit</div>
                      <div style={{color:overLimit?'#f87171':'#4ade80',fontWeight:700,textAlign:'right'}}>{lineLimit?money(lineLimit):'—'}{overLimit?' ⚠':''}</div>
                      <div style={{color:'rgba(255,255,255,0.45)'}}>Authority Max</div>
                      <div style={{color:'rgba(255,255,255,0.35)',textAlign:'right'}}>{money(uwMaxLimitCcy)}</div>
                    </div>
                    {overLimit&&<div style={{fontSize:11,color:'#f87171',marginTop:4}}>⚠ Line limit exceeds authority. Consider reducing the written line.</div>}
                  </div>
                  <textarea className="bbg-textarea" rows={3} value={returnReason} onChange={e=>setReturnReason(e.target.value)}
                    placeholder="Decision note / reason for returning or declining…" style={{width:'100%',boxSizing:'border-box',marginBottom:8}}/>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    <button className="bbg-btn bbg-btn--offer" style={{flex:1}} onClick={onMarkApproved}>✓ Approve</button>
                    <button className="bbg-btn" style={{flex:1,borderColor:'rgba(251,191,36,0.45)',color:'#fbbf24'}} onClick={()=>{if(!returnReason?.trim()){showToast('Please enter a reason for returning.');return;}onReturnToUW();}}>↩ Return to UW</button>
                    <button className="bbg-btn bbg-btn--decline" style={{flex:1}} onClick={()=>{if(window.confirm('Decline this treaty? This cannot be undone.')){if(onDecline)onDecline();else window.dispatchEvent(new CustomEvent('prop-decline-from-cu'));}}}>✗ Decline</button>
                  </div>
                </div>
              )}

              {/* UW signed-line capture has moved to the Final Bind
                  screen — keep this column free of duplicated controls. */}

              {/* Terminal summary */}
              {isTerminal&&(
                <div className="off-card" style={{
                  border:`1px solid ${offerStatus==='SIGNED'?'rgba(74,222,128,0.30)':offerStatus==='DECLINED'?'rgba(248,113,113,0.30)':'rgba(249,115,22,0.30)'}`,
                  background:offerStatus==='SIGNED'?'rgba(74,222,128,0.04)':offerStatus==='DECLINED'?'rgba(248,113,113,0.04)':'rgba(249,115,22,0.04)'}}>
                  <div className="off-card-title" style={{color:offerStatus==='SIGNED'?'#4ade80':offerStatus==='DECLINED'?'#f87171':'#fb923c'}}>
                    {offerStatus==='SIGNED'?'✅ Signed':offerStatus==='DECLINED'?'❌ Declined':'🚫 NTU'}
                  </div>
                  {offerStatus==='SIGNED'&&signedLinePct&&(()=>{
                    const sn=parseFloat(String(signedLinePct).replace(/%/g,'').trim())/100;
                    const sp=Number.isFinite(sn)?Math.round(epi*sn):0,sl=Number.isFinite(sn)?Math.round(limit*sn):0;
                    return (<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'4px 10px',fontSize:12,marginTop:6}}>
                      <div style={{color:'rgba(255,255,255,0.45)'}}>Signed Line</div><div style={{color:'#4ade80',fontWeight:800,textAlign:'right'}}>{signedLinePct}%</div>
                      <div style={{color:'rgba(255,255,255,0.45)'}}>Signed Premium</div><div style={{color:'#60a5fa',fontWeight:700,textAlign:'right'}}>{sp?money(sp):'—'}</div>
                      <div style={{color:'rgba(255,255,255,0.45)'}}>Signed Limit</div><div style={{color:'#4ade80',fontWeight:700,textAlign:'right'}}>{sl?money(sl):'—'}</div>
                      <div style={{color:'rgba(255,255,255,0.45)'}}>Written Line</div><div style={{color:'rgba(255,255,255,0.45)',textAlign:'right'}}>{offerLine?`${offerLine}%`:'—'}</div>
                    </div>);
                  })()}
                  {offerStatus==='DECLINED'&&(()=>{
                    const ev=approvalTrail.find(e=>e.event_type==='DECLINED');
                    const reason=ev?.payload?.reason||ev?.comment;
                    return reason?<div style={{fontSize:12,color:'rgba(255,255,255,0.50)',marginTop:6,fontStyle:'italic'}}>"{reason}"</div>:null;
                  })()}
                  <div style={{fontSize:11,color:'rgba(255,255,255,0.35)',marginTop:8,paddingTop:6,borderTop:'1px solid rgba(255,255,255,0.06)'}}>This contract is now read-only.</div>
                </div>
              )}

              {/* UW draft comment */}
              {!isCU&&!isTerminal&&offerStatus!=='AWAITING_SIGNED_LINE'&&(
                <div className="off-card" style={{flex:1}}>
                  <div className="off-card-title">Comment</div>
                  <textarea className="bbg-textarea" rows={4} value={offerComment} onChange={e=>setOfferComment(e.target.value)}
                    placeholder="Short offer note…" style={{width:'100%',boxSizing:'border-box'}}/>
                </div>
              )}
            </div>
          </div>

          {/* Approval trail */}
          {approvalTrail.length>0&&(
            <div style={{marginTop:4}}>
              <div style={{fontSize:11,fontWeight:800,letterSpacing: 0, textTransform:'uppercase',color:'rgba(255,255,255,0.35)',marginBottom:8}}>Approval Trail</div>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {approvalTrail.map((ev,i)=>{
                  const evC={SUBMITTED_FOR_APPROVAL:{bg:'rgba(96,165,250,0.08)',border:'rgba(96,165,250,0.25)',label:'#60a5fa',icon:'📤'},APPROVED:{bg:'rgba(74,222,128,0.08)',border:'rgba(74,222,128,0.25)',label:'#4ade80',icon:'✅'},RETURNED_TO_UW:{bg:'rgba(251,191,36,0.08)',border:'rgba(251,191,36,0.25)',label:'#fbbf24',icon:'↩'},RETURNED:{bg:'rgba(251,191,36,0.08)',border:'rgba(251,191,36,0.25)',label:'#fbbf24',icon:'↩'},DECLINED:{bg:'rgba(248,113,113,0.08)',border:'rgba(248,113,113,0.25)',label:'#f87171',icon:'❌'},SIGNED:{bg:'rgba(74,222,128,0.06)',border:'rgba(74,222,128,0.20)',label:'#4ade80',icon:'✍'},NTU:{bg:'rgba(249,115,22,0.08)',border:'rgba(249,115,22,0.25)',label:'#fb923c',icon:'🚫'},OFFERED:{bg:'rgba(167,139,250,0.08)',border:'rgba(167,139,250,0.25)',label:'#a78bfa',icon:'📋'}};
                  const c=evC[ev.event_type]||{bg:'rgba(255,255,255,0.04)',border:'rgba(255,255,255,0.12)',label:'rgba(255,255,255,0.6)',icon:'•'};
                  const reason=ev.payload?.reason||ev.payload?.comment||null,linePct=ev.payload?.line_pct||null;
                  return (
                    <div key={i} style={{display:'flex',gap:10,padding:'8px 12px',borderRadius:8,background:c.bg,border:`1px solid ${c.border}`}}>
                      <span style={{fontSize:14,flexShrink:0}}>{c.icon}</span>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:'flex',gap:8,alignItems:'baseline',flexWrap:'wrap'}}>
                          <span style={{fontWeight:700,fontSize:12,color:c.label}}>{ev.event_type.replace(/_/g,' ')}</span>
                          <span style={{fontSize:11,color:'rgba(255,255,255,0.40)'}}>by {ev.actor}</span>
                          {linePct&&<span style={{fontSize:11,color:'rgba(255,255,255,0.40)'}}>· Line {linePct}%</span>}
                          <span style={{fontSize:11,color:'rgba(255,255,255,0.28)',marginLeft:'auto'}}>{new Date(ev.created_at).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</span>
                        </div>
                        {reason&&<div style={{fontSize:11,color:'rgba(255,255,255,0.45)',marginTop:2,fontStyle:'italic'}}>"{reason}"</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="off-footer">
            {!isCU&&!isTerminal&&offerStatus==='DRAFT'&&(
              <div className="off-footer-left">
                <span style={{fontSize:11,color:'rgba(255,255,255,0.38)',whiteSpace:'nowrap'}}>Send to</span>
                <select className="bbg-select" value={offerApprover} onChange={e=>setOfferApprover(e.target.value)} style={{maxWidth:220}}>
                  <option value="">Select approver…</option>
                  {(eligibleApprovers||[]).map(a=><option key={a.user_id} value={a.user_id}>{a.role_name}</option>)}
                </select>
              </div>
            )}
            {(isCU||isTerminal||offerStatus==='AWAITING_APPROVAL'||offerStatus==='AWAITING_SIGNED_LINE')&&<div className="off-footer-left"/>}
            <div style={{display:'flex',gap:8,flexShrink:0}}>
              <button className="bbg-btn" onClick={onClose}>Close</button>
              {!isCU&&!isTerminal&&offerStatus==='DRAFT'&&(
                <button className="bbg-btn bbg-btn--offer" onClick={onSubmitForApproval}>Submit for Approval →</button>
              )}
              {!isCU&&!isTerminal&&offerStatus==='AWAITING_APPROVAL'&&(<>
                <span style={{fontSize:12,color:'rgba(255,255,255,0.40)',alignSelf:'center'}}>⏳ Awaiting CU review…</span>
                <button className="bbg-btn" style={{borderColor:'rgba(251,191,36,0.45)',color:'#fbbf24'}}
                  onClick={()=>{if(window.confirm('Recall this submission? The treaty will return to Draft.'))onRecall&&onRecall();}}>↩ Recall</button>
              </>)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
