import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const clientEntries = ['client/src/main.jsx'];
const serverEntries = [
  'server/src/index.js',
  'server/src/db/migrate.js',
  'server/src/db/migrateStatus.js',
  'server/src/db/seeds/run.js',
  'server/src/jobs/refreshLdfBenchmarks.js',
];

const allowlistedDormantFiles = new Set([
  // Test fixtures/helpers are not production entries.
  'client/src/test/bindPathFixtures.js',
  'client/src/test/bindPathTestUtils.jsx',
  'client/src/test/setup.js',
  // JSDoc typedef modules kept as documentation contracts.
  'client/src/types/domain.js',
  'server/src/types/domain.js',
  // Imported by tests/docs today; keep on the watch list instead of
  // failing the hygiene gate until a production caller lands or it is removed.
  'server/src/db/partialUpdate.js',
  // Manual data-generation entry point, not part of normal boot.
  'server/src/db/seeds/seed_1000_test_contracts.js',
]);

function walk(dir, extensions) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function isTestLike(file) {
  const relative = path.relative(root, file);
  return /\.(test|spec)\.(js|jsx)$/.test(file) ||
    relative.includes(`${path.sep}src${path.sep}test${path.sep}`) ||
    relative.endsWith(`${path.sep}setup.js`);
}

function resolveImport(fromFile, specifier, allFiles) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
  ]) {
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

function buildGraph(files) {
  const allFiles = new Set(files.map((file) => path.resolve(file)));
  const graph = new Map();
  const importRe = /\b(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"`]([^'"`]+)['"`]|\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const deps = [];
    let match;
    while ((match = importRe.exec(source))) {
      const target = resolveImport(file, match[1] || match[2], allFiles);
      if (target) deps.push(target);
    }
    graph.set(path.resolve(file), deps);
  }
  return graph;
}

function reachableFrom(entries, graph) {
  const seen = new Set();
  const stack = entries.map((entry) => path.resolve(root, entry));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of graph.get(file) || []) stack.push(dep);
  }
  return seen;
}

function checkSide(label, baseDir, extensions, entries) {
  const files = walk(path.join(root, baseDir), extensions).filter((file) => !isTestLike(file));
  const graph = buildGraph(files);
  const reachable = reachableFrom(entries, graph);
  const dormant = [];
  const unknown = [];

  for (const file of files) {
    const relative = path.relative(root, file);
    if (reachable.has(path.resolve(file))) continue;
    if (allowlistedDormantFiles.has(relative)) dormant.push(relative);
    else unknown.push(relative);
  }

  return {
    label,
    files: files.length,
    reachable: reachable.size,
    dormant: dormant.sort(),
    unknown: unknown.sort(),
  };
}

const results = [
  checkSide('client', 'client/src', ['.js', '.jsx'], clientEntries),
  checkSide('server', 'server/src', ['.js'], serverEntries),
];

function checkVisualStyle() {
  const files = walk(path.join(root, 'client/src'), ['.css', '.js', '.jsx'])
    .filter((file) => !isTestLike(file));
  const findings = [];
  const rules = [
    {
      name: 'nonzero CSS letter-spacing',
      regex: /(?<![-\w])letter-spacing\s*:\s*(?!\s*['"]?0(?:\s*!important)?\s*(?:[;}]))[^;}\n]+/gi,
    },
    {
      name: 'nonzero JSX letterSpacing',
      regex: /letterSpacing\s*:\s*(?!\s*['"]?0['"]?\s*(?:[,}\n]))[^,}\n]+/g,
    },
    {
      name: 'nonzero letter-spacing token',
      regex: /--num-th-letter-spacing\s*:\s*(?!\s*0\s*[;}])[^;}\n]+/g,
    },
    {
      name: 'viewport-scaled font-size',
      regex: /(?:font-size|fontSize)\s*:\s*['"]?[^;,'"`}]*\bvw\b/gi,
    },
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const rule of rules) {
      let match;
      rule.regex.lastIndex = 0;
      while ((match = rule.regex.exec(source))) {
        const line = source.slice(0, match.index).split(/\r?\n/).length;
        findings.push(`${path.relative(root, file)}:${line} ${rule.name}`);
      }
    }
  }
  return findings.sort();
}

const unknown = results.flatMap((result) => result.unknown.map((file) => `${result.label}: ${file}`));
if (unknown.length) {
  console.error('[hygiene] Unknown production-unreachable files:');
  for (const file of unknown) console.error(`  ${file}`);
  console.error('[hygiene] Remove these files, wire them into an entry path, or add a documented allowlist entry.');
  process.exit(1);
}

const visualFindings = checkVisualStyle();
if (visualFindings.length) {
  console.error('[hygiene] Visual formatting findings:');
  for (const finding of visualFindings) console.error(`  ${finding}`);
  console.error('[hygiene] Keep app typography crisp: zero letter-spacing and no viewport-scaled font sizes.');
  process.exit(1);
}

for (const result of results) {
  console.log(`[hygiene] PASS ${result.label}: ${result.reachable}/${result.files} files reachable from production entries.`);
  if (result.dormant.length) {
    console.log(`[hygiene] ${result.label} dormant allowlist: ${result.dormant.join(', ')}`);
  }
}
console.log('[hygiene] PASS visual formatting: zero letter-spacing and no viewport-scaled font sizes in production client source.');
