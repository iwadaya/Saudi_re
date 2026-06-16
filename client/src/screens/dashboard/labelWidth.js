// client/src/screens/dashboard/labelWidth.js
// Sizes the dashboard tables' first (row-label) column to the widest label seen
// this session, via the --dash-label-w CSS custom property. Tracks a high-water
// mark so the column only ever grows — fixed and stable, never reflowing as you
// switch tabs.

let _maxPx = 0; // session high-water mark → never shrinks (no wobble)

export function fitLabelColumn(labels, fontEl) {
  if (!labels?.length) return;
  const cs = getComputedStyle(fontEl || document.body);
  const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const canvas = (fitLabelColumn._c ||= document.createElement('canvas'));
  const c = canvas.getContext('2d');
  if (!c) return; // no 2d context (e.g. non-browser) → leave the CSS fallback width
  c.font = font;
  for (const s of labels) {
    const w = c.measureText(String(s ?? '')).width;
    if (w > _maxPx) _maxPx = w;
  }
  const px = Math.min(320, Math.max(140, Math.ceil(_maxPx) + 28)); // pad + clamp
  document.documentElement.style.setProperty('--dash-label-w', px + 'px');
}
