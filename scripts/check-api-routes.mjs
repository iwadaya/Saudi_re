import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const routeFiles = [
  path.join(root, 'server/src/app.js'),
  ...walk(path.join(root, 'server/src/routes')).filter((file) => file.endsWith('.js') && !file.endsWith('.test.js')),
];
const clientFiles = walk(path.join(root, 'client/src')).filter((file) => {
  const relative = path.relative(root, file);
  return /\.(js|jsx)$/.test(file) &&
    !/\.(test|spec)\.(js|jsx)$/.test(file) &&
    !relative.includes(`${path.sep}client${path.sep}src${path.sep}test${path.sep}`);
});

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function normalizeSlashes(value) {
  const withoutQuery = value.split(/[?#]/)[0];
  const collapsed = withoutQuery.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

function extractServerRoutes() {
  const routes = [];
  const routeCall = /\b(router|app)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])([\s\S]*?)\3/g;
  for (const file of routeFiles) {
    const source = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = routeCall.exec(source))) {
      const [, receiver, method, , rawPath] = match;
      if (!rawPath.startsWith('/')) continue;
      const apiPath = receiver === 'router' && !rawPath.startsWith('/api/')
        ? `/api${rawPath}`
        : rawPath;
      if (!apiPath.startsWith('/api/')) continue;
      routes.push({
        method: method.toUpperCase(),
        path: normalizeSlashes(apiPath),
        file: path.relative(root, file),
        line: lineNumber(source, match.index),
      });
    }
  }
  return routes;
}

function readQuoted(source, index, quote) {
  let value = '';
  let i = index + 1;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      value += ch;
      if (i + 1 < source.length) {
        value += source[i + 1];
        i += 1;
      }
      continue;
    }
    if (ch === quote) return { value, next: i + 1 };
    value += ch;
  }
  return { value, next: i };
}

function skipTemplateExpression(source, index) {
  let depth = 1;
  let i = index;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '"' || ch === "'") {
      i = readQuoted(source, i, ch).next;
      continue;
    }
    if (ch === '`') {
      i = readTemplate(source, i, false).next;
      continue;
    }
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i + 2);
      if (i === -1) return source.length;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

function readTemplate(source, index, collect = true) {
  let value = '';
  let i = index + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      if (collect) value += ch + (source[i + 1] || '');
      i += 2;
      continue;
    }
    if (ch === '`') return { value, next: i + 1 };
    if (ch === '$' && source[i + 1] === '{') {
      if (collect) value += '${}';
      i = skipTemplateExpression(source, i + 2);
      continue;
    }
    if (collect) value += ch;
    i += 1;
  }
  return { value, next: i };
}

function collectStringLiterals(source) {
  const values = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i + 2);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const literal = readQuoted(source, i, ch);
      values.push(literal.value);
      i = literal.next;
      continue;
    }
    if (ch === '`') {
      const literal = readTemplate(source, i);
      values.push(literal.value);
      i = literal.next;
      continue;
    }
    i += 1;
  }
  return values;
}

function normalizeClientPath(rawValue) {
  if (!rawValue.startsWith('/api/')) return null;
  let value = normalizeSlashes(rawValue);
  value = value.replace(/\/\$\{\}/g, '/__DYN__');
  value = value.replace(/\$\{\}/g, '');
  value = value.replace(/\/{2,}/g, '/');
  value = value.length > 1 ? value.replace(/\/$/, '') : value;
  if (!value.startsWith('/api/')) return null;
  return value;
}

function extractClientPaths() {
  const paths = new Map();
  for (const file of clientFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const literal of collectStringLiterals(source)) {
      const apiPath = normalizeClientPath(literal.trim());
      if (!apiPath) continue;
      const key = apiPath;
      if (!paths.has(key)) paths.set(key, { path: apiPath, files: new Set() });
      paths.get(key).files.add(path.relative(root, file));
    }
  }
  return [...paths.values()].map((entry) => ({
    ...entry,
    files: [...entry.files].sort(),
  })).sort((a, b) => a.path.localeCompare(b.path));
}

function escapeRegexChar(ch) {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

function routeRegex(routePath) {
  let out = '^';
  let i = 0;
  while (i < routePath.length) {
    if (routePath.startsWith('${', i)) {
      const end = routePath.indexOf('}', i + 2);
      out += '[^/]+';
      i = end === -1 ? routePath.length : end + 1;
      continue;
    }
    const ch = routePath[i];
    if (ch === ':' && (i === 0 || routePath[i - 1] === '/')) {
      i += 1;
      while (i < routePath.length && /[A-Za-z0-9_]/.test(routePath[i])) i += 1;
      out += '[^/]+';
      continue;
    }
    out += escapeRegexChar(ch);
    i += 1;
  }
  out += '/?$';
  return new RegExp(out);
}

const serverRoutes = extractServerRoutes();
const clientPaths = extractClientPaths();
const serverMatchers = serverRoutes.map((route) => ({ ...route, regex: routeRegex(route.path) }));
const unmatched = clientPaths.filter((clientPath) => !serverMatchers.some((route) => route.regex.test(clientPath.path)));

if (unmatched.length) {
  console.error('[api-routes] Unmatched client API paths:');
  for (const item of unmatched) {
    console.error(`  ${item.path}`);
    console.error(`    referenced by ${item.files.join(', ')}`);
  }
  console.error(`[api-routes] ${unmatched.length} unmatched path(s) out of ${clientPaths.length} client paths.`);
  process.exit(1);
}

const uniqueServerPatterns = new Set(serverRoutes.map((route) => route.path));
console.log(
  `[api-routes] PASS ${clientPaths.length} client API paths match ${uniqueServerPatterns.size} server route patterns ` +
  `(${serverRoutes.length} declarations).`,
);
