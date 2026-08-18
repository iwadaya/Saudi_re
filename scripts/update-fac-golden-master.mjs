#!/usr/bin/env node
// scripts/update-fac-golden-master.mjs
//
// Regenerates shared/fac/__golden__/families.json from the fixtures.
//
// The point of a golden master is that a rate change becomes a DIFF somebody
// has to look at. Run this only when you intended the change, read the diff
// before committing it, and say in the commit message why the numbers moved.
// A re-baseline with no explanation is the same as having no golden master.
//
//   node scripts/update-fac-golden-master.mjs
//   node scripts/update-fac-golden-master.mjs --check   (exit 1 if stale)

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../shared/fac/__golden__/families.json');

const { priceFacRiskFull } = await import('../shared/fac/index.js');
const { FIXTURES, pinnedShape } = await import('../shared/fac/goldenMaster.fixtures.js');

const master = {
  note: 'Golden masters for the facultative rating families. Regenerate with '
    + 'scripts/update-fac-golden-master.mjs, and only when the change was intended — '
    + 'read the diff before committing it.',
  families: {},
};

for (const fixture of FIXTURES) {
  master.families[fixture.family] = {
    why: fixture.why,
    expected: pinnedShape(priceFacRiskFull(fixture.args)),
  };
}

const serialised = `${JSON.stringify(master, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error('fac golden master: missing — run scripts/update-fac-golden-master.mjs');
    process.exit(1);
  }
  if (readFileSync(OUT, 'utf8') !== serialised) {
    console.error('fac golden master: STALE — the engines produce different numbers than the '
      + 'committed master. If that was intended, regenerate and explain the diff.');
    process.exit(1);
  }
  console.log(`fac golden master: current (${FIXTURES.length} families)`);
  process.exit(0);
}

writeFileSync(OUT, serialised);
console.log(`fac golden master: wrote ${FIXTURES.length} families to ${OUT}`);
