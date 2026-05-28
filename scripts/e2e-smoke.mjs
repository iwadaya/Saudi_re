import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const clientDist = path.join(root, 'client/dist');
const indexHtml = path.join(clientDist, 'index.html');

if (!fs.existsSync(indexHtml)) {
  console.error('[e2e] client/dist/index.html is missing. Run npm run build first.');
  process.exit(1);
}

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelling-tool-e2e-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  CLIENT_DIST_DIR: clientDist,
  UPLOAD_DIR: uploadDir,
  RUN_MIGRATIONS_ON_BOOT: 'false',
  POOL_WATCHDOG_MS: '0',
  CORS_ORIGIN: 'http://127.0.0.1',
  REQUEST_TIMEOUT_MS: '1500',
  DB_CONNECT_TIMEOUT_MS: '250',
});

const { createApp } = await import('../server/src/app.js');
const { closePools } = await import('../server/src/db/pool.js');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(server));
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePools();
  fs.rmSync(uploadDir, { recursive: true, force: true });
}

async function check(name, fn) {
  await fn();
  console.log(`[e2e] PASS ${name}`);
}

const server = await listen(createApp());
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  await check('lightweight health endpoint', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  await check('SPA route serves built index without caching', async () => {
    const res = await fetch(`${baseUrl}/login`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    assert.match(await res.text(), /id="root"/);
  });

  await check('missing hashed asset returns a real 404', async () => {
    const res = await fetch(`${baseUrl}/assets/e2e-missing-chunk.js`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const text = await res.text();
    assert.doesNotMatch(text, /id="root"/);
  });

  await check('unknown API route returns JSON 404 after role gate', async () => {
    const res = await fetch(`${baseUrl}/api/e2e-missing-route`, {
      headers: {
        'x-user-id': 'e2e-smoke',
        'x-user-name': 'E2E Smoke',
        'x-user-role': 'TUW',
      },
    });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.code, 'NOT_FOUND');
  });
} finally {
  await close(server);
}
