// ── Shared constants used across PropPricing sub-components ──
import {
  fmtOrEm,
  fmtPct as fmtRatioPct,
  toN,
} from '../../../../utils/format.js';

export const COMPONENT_ROWS = [
  'Attritional Loss Ratio', 'Large Loss Loading', 'Cat Loss Loading',
  'Commissions', 'Brokerage', 'Taxes',
  'Result', 'Maximum Commissions (Reinsurer)',
];

export const SHARE_COLS = [
  { key:'limit_amt',     label:'Limit',              color:'cyan'   },
  { key:'premium_amt',   label:'Premium',            color:'cyan'   },
  { key:'cedant_limit',  label:'Total Cedant Limit', color:'violet' },
  { key:'agg_contrib',   label:'Agg Contribution',   color:'amber'  },
  { key:'country_agg',   label:'Country Agg',        color:'amber'  },
  { key:'event_limit',   label:'Event Limit',        color:'blue'   },
  { key:'downside_amt',  label:'Max Downside',       color:'red'    },
  { key:'shortfall_amt', label:'Expected Shortfall', color:'red'    },
];

export const SHARE_COL_COLORS = {
  cyan:   { th:'rgba(34,211,238,0.80)',  cell:'rgba(34,211,238,0.07)',  border:'rgba(34,211,238,0.22)',  val:'rgba(34,211,238,0.90)'  },
  violet: { th:'rgba(167,139,250,0.80)', cell:'rgba(167,139,250,0.07)', border:'rgba(167,139,250,0.22)', val:'rgba(167,139,250,0.90)' },
  amber:  { th:'rgba(251,191,36,0.80)',  cell:'rgba(251,191,36,0.06)',  border:'rgba(251,191,36,0.20)',  val:'rgba(251,191,36,0.90)'  },
  blue:   { th:'rgba(96,165,250,0.80)',  cell:'rgba(96,165,250,0.06)',  border:'rgba(96,165,250,0.20)',  val:'rgba(96,165,250,0.90)'  },
  red:    { th:'rgba(248,113,113,0.80)', cell:'rgba(248,113,113,0.06)', border:'rgba(248,113,113,0.20)', val:'rgba(248,113,113,0.90)' },
};

export const DEFAULT_SHARE_ROWS = ['1%','2.5%','5%','100%'];

export const INSIGHT_BUTTONS = [
  { key:'LARGE_LOSSES',    label:'Large Losses',      color:'pink'    },
  { key:'CAT_LOSSES',      label:'CAT Losses',        color:'amber'   },
  { key:'RISK_PROFILES',   label:'Risk Profiles',     color:'cyan'    },
  { key:'CLAIMS_PROFILES', label:'Claims Profiles',   color:'slate'   },
  { key:'COUNTRY_AGG',     label:'Cresta Aggregates', color:'violet'  },
  { key:'CEDANT_SUMMARY',  label:'Cedant Summary',    color:'emerald' },
  { key:'CHECKLIST',       label:'Checklist',         color:'ghost'   },
  { key:'INTERNAL_METRICS',label:'Internal Metrics',  color:'ghost'   },
  { key:'TREATY_METRICS',  label:'Treaty Metrics',    color:'teal'    },
  { key:'COMPARE_TERMS',   label:'Compare Terms',     color:'green'   },
];

export const UW_MAX_LIMIT = 50_000_000;

// ── Pure helpers ──
export const cn = toN;
export const fmt = fmtOrEm;
export const fmtPct = fmtRatioPct;
export const parsePct = v => { if(!v)return 0; const s=String(v).trim(); if(s.includes('%')){ const n=Number(s.replace(/%/g,'')); return Number.isFinite(n)?n/100:0; } const n=Number(s); return n>1.5?n/100:n; };

// MBBEFD G(d) — Swiss Re single-parameter exposure curve
export function mbbefdG(d, c) {
  if(d<=0) return 0; if(d>=1) return 1;
  if(Math.abs(c)<1e-10) return d;
  return Math.log(1+(Math.exp(c)-1)*d)/c;
}
export const SWISS_RE_C = { Y1:0, Y2:1.5, Y3:3.0, Y4:5.0 };

// Pareto helpers
export function fitPareto(losses, xm) {
  const v=(losses||[]).filter(l=>l>=xm); const n=v.length;
  if(n===0) return {alpha:0,n:0};
  let s=0; for(const x of v) s+=Math.log(x/xm);
  return {alpha:s>0?n/s:0,n};
}
export function paretoQ(p,a,xm) {
  if(!(p>0&&p<1)||!(a>0)||!(xm>0)) return 0;
  return xm*Math.pow(1-p,-1/a);
}

// Loss Participation Credit
// - When lpSlides has more than one corridor, sum the cedant's
//   participation across each {min_lr, max_lr, share} band:
//   credit += max(0, min(LR, max_lr) − min_lr) × prem × share.
// - Otherwise fall back to the single-corridor min/max/share formula.
// Accepts either snake_case (API shape) or camelCase (treaty-detail shape)
// keys for the slide rows.
export function calcLPC(prem,claims,t) {
  if(!t?.lossPartEnabled||!prem||prem<=0) return 0;
  const lr=claims/prem;
  const slides=(t.lpSlides||t.lp_slides||[])
    .map(r=>({minLr:cn(r.min_lr??r.minLr)/100,maxLr:(cn(r.max_lr??r.maxLr)/100)||1,share:cn(r.share)/100}))
    .filter(r=>r.share>0&&r.maxLr>r.minLr);
  if(slides.length>1){
    let credit=0;
    for(const c of slides){
      const top=Math.min(lr,c.maxLr);
      const band=Math.max(0,top-c.minLr);
      credit+=band*prem*c.share;
    }
    return credit;
  }
  const sharePct=cn(t.reinsurerSharePct); if(sharePct<=0) return 0;
  const minLR=cn(t.minLossRatioPct)/100; const maxLR=(cn(t.maxLossRatioPct)/100)||1;
  if(lr<=minLR) return 0;
  const effectiveLR=Math.min(lr,maxLR);
  return (effectiveLR-minLR)*prem*(sharePct/100);
}
