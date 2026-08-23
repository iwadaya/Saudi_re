import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { meta, chapters } from './manual-data.mjs';

import { fileURLToPath } from 'node:url';

const OUTDIR = path.dirname(fileURLToPath(import.meta.url));
const IMGDIR = path.join(OUTDIR, 'screens');
const RAW    = process.env.MANUAL_RAW_DIR || path.join(OUTDIR, 'raw');
const PDF    = path.join(OUTDIR, '..', 'Universe3-Underwriter-Manual.pdf');
const IMG_WIDTH = 1400, IMG_QUALITY = 78;
fs.mkdirSync(IMGDIR, { recursive: true });

// web/ holds the web-weight JPEG of each screen and is the committed image
// source; raw/ holds the full-resolution PNG captures and is local-only.
// When raw/ is present, any screen missing from web/ is (re)derived from it.
const WEB = path.join(OUTDIR, 'web');
fs.mkdirSync(WEB, { recursive: true });
for (const f of (fs.existsSync(RAW) ? fs.readdirSync(RAW) : []).filter(f => f.endsWith('.png'))) {
  const to = path.join(WEB, f.replace('.png', '.jpg'));
  if (fs.existsSync(to)) continue;
  await sharp(path.join(RAW, f)).resize({ width: IMG_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: IMG_QUALITY, mozjpeg: true }).toFile(to);
}
const SRC = WEB;

// Copy the screenshots the manual references. A full-height capture of a long
// screen is far taller than an A4 page: shrunk to fit it becomes an unreadable
// sliver, so anything taller than ~1.35× its width is sliced into page-shaped
// bands (with a small overlap so nothing is lost at the seam) and shown as
// consecutive figures.
const BAND_RATIO = 1.16;     // band height as a multiple of image width
const OVERLAP    = 44;       // px of overlap between consecutive bands
const MAX_BANDS  = { 'np-history': 2, 'prop-history': 2 };   // repetitive lists: first bands are enough
const DEFAULT_MAX_BANDS = 4;

const used = new Set();
for (const ch of chapters) for (const s of (ch.screens || [])) used.add(s.key);

/** @type {Map<string,{files:string[],truncated:boolean}>} */
const figures = new Map();

for (const k of used) {
  const from = path.join(SRC, `${k}.jpg`);
  if (!fs.existsSync(from)) { console.warn('MISSING SCREENSHOT:', k); continue; }
  const meta0 = await sharp(from).metadata();
  const bandH = Math.round(meta0.width * BAND_RATIO);
  if (meta0.height <= bandH * 1.08) {
    fs.copyFileSync(from, path.join(IMGDIR, `${k}.jpg`));
    figures.set(k, { files: [`${k}.jpg`], truncated: false });
    continue;
  }
  const cap = MAX_BANDS[k] ?? DEFAULT_MAX_BANDS;
  const total = Math.ceil(meta0.height / bandH);
  const n = Math.min(total, cap);
  const files = [];
  for (let i = 0; i < n; i++) {
    const top = Math.max(0, i * bandH - (i ? OVERLAP : 0));
    const h = Math.min(bandH + (i ? OVERLAP : 0), meta0.height - top);
    const out = `${k}-${i + 1}.jpg`;
    await sharp(from).extract({ left: 0, top, width: meta0.width, height: h })
      .jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(IMGDIR, out));
    files.push(out);
  }
  figures.set(k, { files, truncated: n < total });
  console.log(`sliced ${k}: ${meta0.width}x${meta0.height} -> ${n}/${total} bands`);
}

const esc = (s) => String(s);
const today = process.env.MANUAL_DATE || '';

function renderFigures(s) {
  const f = figures.get(s.key);
  if (!f) return '';
  const n = f.files.length;
  return f.files.map((file, i) => {
    const part = n > 1 ? ` <span class="part">(${i + 1} of ${n}${f.truncated && i === n - 1 ? ', continues below the fold' : ''})</span>` : '';
    return `<figure><img src="screens/${file}" alt="${esc(s.title)} screen"><figcaption>${s.title} — <code>${s.route}</code>${part}</figcaption></figure>`;
  }).join('');
}

let toc = '';
let bodyHtml = '';

for (const ch of chapters) {
  toc += `<li class="toc-ch"><a href="#${ch.id}"><span>${ch.title}</span></a></li>`;
  for (const s of (ch.screens || [])) {
    toc += `<li class="toc-scr"><a href="#${ch.id}-${s.key}"><span>${s.title}</span><code>${s.route}</code></a></li>`;
  }

  const noBody = !(ch.body || []).length;
  bodyHtml += `<section class="chapter${noBody ? ' no-body' : ''}" id="${ch.id}"><h1>${ch.title}</h1>`;
  for (const blk of (ch.body || [])) {
    if (blk.h) bodyHtml += `<h2>${blk.h}</h2>`;
    for (const para of (blk.p || [])) bodyHtml += `<p>${para}</p>`;
    if (blk.glossary) {
      bodyHtml += '<dl class="glossary">';
      for (const [t, d] of blk.glossary) bodyHtml += `<dt>${t}</dt><dd>${d}</dd>`;
      bodyHtml += '</dl>';
    }
  }
  for (const s of (ch.screens || [])) {
    bodyHtml += `<section class="screen" id="${ch.id}-${s.key}">
      <h2 class="screen-h">${s.title}<code class="route">${s.route}</code></h2>
      <p class="purpose">${s.purpose}</p>
      ${renderFigures(s)}
      <h3>On this screen</h3>
      <ul>${(s.bullets || []).map(b => `<li>${b}</li>`).join('')}</ul>
    </section>`;
  }
  bodyHtml += `</section>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${meta.title}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  :root{
    --ink:#101a16; --muted:#5b6b64; --rule:#d8e2dd; --accent:#0f7a54;
    --accent-soft:#eaf5f0; --code:#2b3a34;
  }
  *{box-sizing:border-box}
  body{
    margin:0; color:var(--ink); font-size:10.2pt; line-height:1.55;
    font-family:"Source Sans 3","Segoe UI",Helvetica,Arial,sans-serif;
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }
  code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;font-size:.86em;color:var(--code)}

  /* ── cover ── */
  .cover{height:245mm;display:flex;flex-direction:column;justify-content:center;page-break-after:always}
  .cover .mark{width:52px;height:52px;border-radius:14px;background:var(--accent);color:#fff;
    display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px;margin-bottom:26mm}
  .cover h1{font-size:34pt;line-height:1.1;margin:0 0 6mm;letter-spacing:-.5px;font-weight:700}
  .cover .sub{font-size:14pt;color:var(--muted);margin:0 0 22mm;font-weight:400}
  .cover dl{display:grid;grid-template-columns:34mm 1fr;gap:3mm 6mm;margin:0;font-size:10pt;
    border-top:1px solid var(--rule);padding-top:6mm;max-width:135mm}
  .cover dt{color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-size:8.4pt;padding-top:1px}
  .cover dd{margin:0}

  /* ── contents ── */
  .toc{page-break-after:always}
  .toc h1{font-size:18pt;margin:0 0 6mm;font-weight:700}
  .toc ol{list-style:none;margin:0;padding:0;column-count:2;column-gap:12mm}
  .toc li{break-inside:avoid}
  .toc a{text-decoration:none;color:inherit;display:flex;gap:4mm;align-items:baseline;justify-content:space-between}
  .toc-ch{margin:3.2mm 0 1mm;font-weight:700;font-size:10pt;color:var(--accent);line-height:1.3}
  .toc-ch:first-child{margin-top:0}
  .toc-scr{font-size:8.6pt;padding-left:4mm;color:var(--muted);margin:.15mm 0;line-height:1.35}
  .toc-scr code{font-size:7.6pt;color:#93a49c;white-space:nowrap}

  /* ── chapters ── */
  .chapter{page-break-before:always}
  .chapter > h1{
    font-size:20pt;font-weight:700;margin:0 0 7mm;padding-bottom:3.5mm;
    border-bottom:2.5px solid var(--accent);letter-spacing:-.3px;
  }
  h2{font-size:12.5pt;font-weight:700;margin:8mm 0 2.5mm;page-break-after:avoid}
  h3{font-size:9.2pt;font-weight:700;margin:5mm 0 1.5mm;text-transform:uppercase;
     letter-spacing:.09em;color:var(--accent);page-break-after:avoid}
  p{margin:0 0 3mm;text-align:justify;hyphens:auto}
  ul{margin:0 0 3mm;padding-left:5mm}
  li{margin:0 0 1.6mm}

  /* ── screen blocks ── */
  .screen{page-break-before:always}
  .chapter.no-body > .screen:first-of-type{page-break-before:auto}
  .screen-h{
    margin:0 0 2mm;font-size:14pt;display:flex;align-items:baseline;gap:4mm;
    justify-content:space-between;border-bottom:1px solid var(--rule);padding-bottom:2mm;
  }
  .screen-h .route{font-size:8.6pt;color:var(--muted);font-weight:400;white-space:nowrap}
  .purpose{font-size:10.6pt;color:#26332e;margin:0 0 4mm}
  figure{margin:0 0 4mm;text-align:center;page-break-inside:avoid}
  figure img{
    max-width:100%;max-height:196mm;object-fit:contain;
    border:1px solid var(--rule);border-radius:5px;
  }
  figcaption{font-size:7.8pt;color:var(--muted);margin-top:1.8mm}
  figcaption code{font-size:7.6pt}
  figcaption .part{color:#93a49c}
  figure + figure{margin-top:5mm}

  /* ── glossary ── */
  .glossary{display:grid;grid-template-columns:32mm 1fr;gap:1.6mm 5mm;margin:3mm 0 0;font-size:9.6pt}
  .glossary dt{font-weight:700;color:var(--accent)}
  .glossary dd{margin:0}
  .glossary dt,.glossary dd{break-inside:avoid}

  b{font-weight:700}
</style></head><body>

<section class="cover">
  <div class="mark">U</div>
  <h1>${meta.title.replace(' — ', '<br>')}</h1>
  <p class="sub">${meta.subtitle}</p>
  <dl>
    <dt>Audience</dt><dd>${meta.audience}</dd>
    <dt>Covers</dt><dd>Proportional treaty · Non-proportional treaty · Facultative · Claims · Finance · Administration</dd>
    <dt>Screens</dt><dd>${used.size} screens, captured from a running instance with a seeded portfolio</dd>
    <dt>Revision</dt><dd>${meta.version}${today ? ' · ' + today : ''}</dd>
  </dl>
</section>

<section class="toc">
  <h1>Contents</h1>
  <ol>${toc}</ol>
</section>

${bodyHtml}
</body></html>`;

fs.writeFileSync(path.join(OUTDIR, 'manual.html'), html);
console.log('html written:', path.join(OUTDIR, 'manual.html'));

const browser = await chromium.launch(process.env.MANUAL_CHROME ? { executablePath: process.env.MANUAL_CHROME } : {});
const page = await browser.newPage();
await page.goto('file://' + path.join(OUTDIR, 'manual.html'), { waitUntil: 'load' });
await page.waitForTimeout(2500);
const pdfPath = PDF;
await page.pdf({
  path: pdfPath, format: 'A4', printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: `<div style="width:100%;font-size:7.5pt;color:#93a49c;
      font-family:'Segoe UI',Helvetica,Arial,sans-serif;padding:0 16mm;display:flex;justify-content:space-between">
      <span>${meta.title}</span><span class="pageNumber"></span></div>`,
  margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' },
});
await browser.close();
const kb = (fs.statSync(pdfPath).size / 1048576).toFixed(1);
console.log(`pdf written: ${pdfPath} (${kb} MB)`);
