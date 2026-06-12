#!/usr/bin/env node
// frontend-budget.mjs — ratcheting quality gate for the screens layer.
//
// Counts hardening metrics across client/src/screens/** (test files excluded)
// and compares them against the committed baseline in
// scripts/frontend-budget.baseline.json. Any GATED metric above its baseline
// fails the run, so the numbers can only go down. When a metric improves,
// re-baseline so the ratchet locks in the gain:
//
//   npm run budget:frontend -- --update-baseline
//
// Full context + the metric table live in docs/frontend-hardening.md.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS_DIR = path.join(ROOT, 'client', 'src', 'screens');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'frontend-budget.baseline.json');
const LOC_BUDGET = 800;

// Metrics that gate CI (ratchet: may never exceed baseline).
const GATED = ['inlineStyles', 'filesOver800Loc', 'onClickNonInteractive', 'consoleCalls'];
// Metrics tracked for the hardening doc but not (yet) gated.
const INFORMATIONAL = ['useStateCalls', 'setLoadingCalls'];

function listScreenSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listScreenSources(full));
    } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function countMatches(content, regex) {
  const m = content.match(regex);
  return m ? m.length : 0;
}

// Count onClick handlers on non-interactive elements (<div>, <span>, <td>,
// <tr>). Opening tags can span lines and contain arrow functions, so we scan
// each tag to its closing `>` with brace-depth tracking instead of a single
// regex.
function countOnClickNonInteractive(content) {
  let count = 0;
  const tagOpen = /<(div|span|td|tr)\b/g;
  let match;
  while ((match = tagOpen.exec(content)) !== null) {
    let depth = 0;
    let end = -1;
    for (let i = match.index + match[0].length; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth <= 0) { end = i; break; }
    }
    if (end === -1) continue;
    const tag = content.slice(match.index, end);
    if (/\bonClick\s*=/.test(tag)) count++;
  }
  return count;
}

function measure() {
  const files = listScreenSources(SCREENS_DIR);
  const metrics = {
    inlineStyles: 0,
    filesOver800Loc: 0,
    onClickNonInteractive: 0,
    consoleCalls: 0,
    useStateCalls: 0,
    setLoadingCalls: 0,
  };
  const oversized = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const loc = content.split('\n').length;
    if (loc > LOC_BUDGET) {
      metrics.filesOver800Loc++;
      oversized.push({ file: path.relative(ROOT, file), loc });
    }
    metrics.inlineStyles += countMatches(content, /style=\{\{/g);
    metrics.consoleCalls += countMatches(content, /\bconsole\.[a-zA-Z]+/g);
    metrics.useStateCalls += countMatches(content, /\buseState\s*[(<]/g);
    metrics.setLoadingCalls += countMatches(content, /\bsetLoading\s*\(/g);
    metrics.onClickNonInteractive += countOnClickNonInteractive(content);
  }

  oversized.sort((a, b) => b.loc - a.loc);
  return { fileCount: files.length, metrics, oversized };
}

function main() {
  const updateBaseline = process.argv.includes('--update-baseline');
  const { fileCount, metrics, oversized } = measure();

  console.log(`frontend-budget: scanned ${fileCount} screen source files`);
  for (const key of [...GATED, ...INFORMATIONAL]) {
    const tag = GATED.includes(key) ? 'gated' : 'info ';
    console.log(`  [${tag}] ${key.padEnd(22)} ${metrics[key]}`);
  }

  if (updateBaseline || !existsSync(BASELINE_PATH)) {
    const baseline = {
      generatedAt: new Date().toISOString().slice(0, 10),
      note: 'Ratchet baseline for scripts/frontend-budget.mjs — see docs/frontend-hardening.md',
      metrics,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\nBaseline ${updateBaseline ? 'updated' : 'created'} at ${path.relative(ROOT, BASELINE_PATH)}`);
    return 0;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const regressions = [];
  const improvements = [];
  for (const key of GATED) {
    const base = baseline.metrics?.[key];
    if (typeof base !== 'number') {
      regressions.push(`${key}: missing from baseline — re-run with --update-baseline`);
      continue;
    }
    if (metrics[key] > base) regressions.push(`${key}: ${metrics[key]} > baseline ${base}`);
    else if (metrics[key] < base) improvements.push(`${key}: ${metrics[key]} (baseline ${base})`);
  }

  if (regressions.length > 0) {
    console.error('\n✖ frontend budget exceeded — the screens layer may not regress:');
    for (const r of regressions) console.error(`    ${r}`);
    if (oversized.length > 0) {
      console.error('  files over 800 LOC:');
      for (const o of oversized) console.error(`    ${String(o.loc).padStart(5)}  ${o.file}`);
    }
    console.error('  See docs/frontend-hardening.md for the budget rationale.');
    return 1;
  }

  if (improvements.length > 0) {
    console.log('\n✓ budget passed — metrics improved; lock in the gains by re-baselining:');
    for (const i of improvements) console.log(`    ${i}`);
    console.log('  Run: npm run budget:frontend -- --update-baseline');
  } else {
    console.log('\n✓ budget passed (no regression vs baseline)');
  }
  return 0;
}

process.exit(main());
