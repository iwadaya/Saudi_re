// components/PropPricingBanners.jsx — Phase 4.2 (docs/frontend-hardening.md).
//
// The screen's in-flow alert banners, extracted from PropPricing.jsx with
// the JSX (and its conditional gates) verbatim. Props in, callbacks out.

/** Placeholder-LDF + stale-loss-selection warnings, top of the page. */
export function PropPricingStatusBanners({ usedPlaceholderLdfs, lossStale }) {
  return (
    <>
      {usedPlaceholderLdfs && (
        <div role="alert" style={{ margin: '0 0 12px', padding: '12px 16px', borderRadius: 10, background: 'rgba(249,115,22,0.14)', border: '2px solid #f97316', color: 'var(--accent-amber)', fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>
          No saved development factors found — projection is using placeholder benchmark curves. Go to the Development Factors screen to select and save factors before relying on these figures.
        </div>
      )}
      {lossStale && (
        <div role="alert" style={{ margin: '0 0 12px', padding: '10px 14px', borderRadius: 10, background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.30)', color: 'var(--accent-amber)', fontSize: 12, lineHeight: 1.5 }}>
          Loss selection is outdated — losses have changed since the last selection was saved.
        </div>
      )}
    </>
  );
}

/** Terminal-status (SIGNED / NTU / DECLINED) read-only banner. */
export function PropPricingReadOnlyBanner({ isReadOnly, offerStatus, setShowOffer }) {
  return (
    <>
      {isReadOnly && (
        <div style={{ padding: '10px 16px', borderRadius: 10, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 10,
          background: offerStatus === 'SIGNED' ? 'rgba(74,222,128,0.08)' : offerStatus === 'DECLINED' ? 'rgba(248,113,113,0.08)' : 'rgba(249,115,22,0.08)',
          border: `1px solid ${offerStatus === 'SIGNED' ? 'rgba(74,222,128,0.25)' : offerStatus === 'DECLINED' ? 'rgba(248,113,113,0.25)' : 'rgba(249,115,22,0.25)'}` }}>
          <span style={{ fontSize: 16 }}>{offerStatus === 'SIGNED' ? '✅' : offerStatus === 'DECLINED' ? '❌' : '🚫'}</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 13, color: offerStatus === 'SIGNED' ? 'var(--accent)' : offerStatus === 'DECLINED' ? 'var(--accent-rose)' : 'var(--accent-amber)' }}>
              Contract {offerStatus.replace(/_/g, ' ')} — Read Only
            </div>
            <div style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.45)', marginTop: 1 }}>
              Pricing data is locked. Open the {offerStatus === 'SIGNED' || offerStatus === 'NTU' ? 'offer modal to review details' : 'offer modal to review this decision'}.
            </div>
          </div>
          <button className="bbg-btn" style={{ marginLeft: 'auto' }} onClick={() => setShowOffer(true)}>View Details →</button>
        </div>
      )}
    </>
  );
}
