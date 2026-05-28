import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const checks = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function pass(name, ok, detail = '') {
  checks.push({ name, ok, detail });
}

function parseVersion(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(actual, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (actual[i] > required[i]) return true;
    if (actual[i] < required[i]) return false;
  }
  return true;
}

const packageJson = JSON.parse(read('package.json'));
const nodeVersion = parseVersion(process.version);
const requiredNode = parseVersion(packageJson.engines?.node || '20.18.0');
pass(
  'Node runtime satisfies package engines',
  Boolean(nodeVersion && requiredNode && atLeast(nodeVersion, requiredNode)),
  `${process.version} vs ${packageJson.engines?.node || 'missing engine'}`,
);

const envExample = read('.env.example');
pass('.env.example disables boot migrations', /^RUN_MIGRATIONS_ON_BOOT=false$/m.test(envExample));
pass('.env.example uses explicit CORS origin', /^CORS_ORIGIN=(?!\*)\S+/m.test(envExample));

const envJs = read('server/src/config/env.js');
pass('runtime default keeps boot migrations off', /runMigrationsOnBoot:\s*toBool\(values\.RUN_MIGRATIONS_ON_BOOT,\s*false\)/.test(envJs));
pass('client dist override is configurable', /CLIENT_DIST_DIR/.test(envJs) && /clientDistDir/.test(envJs));

const renderYaml = read('render.yaml');
pass('Render health check targets lightweight endpoint', /healthCheckPath:\s*\/api\/health/.test(renderYaml));
pass('Render runs migrations before deploy start', /preDeployCommand:.*migrate:up --prefix server/.test(renderYaml));

const dockerfile = read('Dockerfile');
pass('Docker runner includes shared pricing primitives', /COPY shared \.\/shared/.test(dockerfile));

const appJs = read('server/src/app.js');
pass('health endpoint is DB-free and no-store', /app\.get\('\/api\/health'/.test(appJs) && /Cache-Control', 'no-store'/.test(appJs));
pass('SPA fallback excludes hashed assets', /app\.get\(\/\^\(\?!\\\/api\\\/\)\(\?!\\\/assets\\\/\)/.test(appJs));
pass('API request timeout middleware is installed', /app\.use\('\/api', requestTimeout/.test(appJs));

pass('built client artifact exists', fs.existsSync(path.join(root, 'client/dist/index.html')), 'run npm run build before this check');

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  const status = check.ok ? 'PASS' : 'FAIL';
  const detail = check.detail ? ` (${check.detail})` : '';
  console.log(`[ops] ${status} ${check.name}${detail}`);
}

if (failed.length) {
  console.error(`[ops] ${failed.length} readiness check(s) failed.`);
  process.exit(1);
}
