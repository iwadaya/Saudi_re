import pkg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool } = pkg;

function redactConnectionString(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return value.replace(/:[^@]*@/, ':***@');
  }
}

logger.info('DB pool connecting', { url: redactConnectionString(env.databaseUrl) });

// Pool sizing for ~30 concurrent users.
//
// Each save transaction holds a connection for 100–500 ms; GETs are
// sub-50 ms. Rule of thumb: peak concurrent connections ≈ users ×
// in-flight-requests. For 30 users with 2–3 parallel XHRs (dashboard
// loads, autosave, lookups) → 60–90 peak. A pool of 50 with queue
// spill-over handles that without hitting Postgres' default 100
// max_connections (leaves headroom for migrations and manual queries).
//
// Knobs can be overridden via env:
//   DB_POOL_MAX, DB_POOL_MIN, DB_IDLE_TIMEOUT_MS, DB_CONNECT_TIMEOUT_MS
const poolMax = Number(process.env.DB_POOL_MAX) || 50;
const poolMin = Number(process.env.DB_POOL_MIN) || 4;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: poolMax,
  min: poolMin,                // warm connections ready for traffic spikes
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30_000,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 5_000,
  statement_timeout: 30_000,   // kill runaway queries — prevents pool starvation
  query_timeout: 30_000,
  keepAlive: true,             // TCP keep-alive so idle conns don't get reaped by NAT
});

// Observability — log pool exhaustion + client errors so we can see
// under-provisioning in production.
pool.on('error', (err) => {
  logger.error('pg pool error', { message: err.message, code: err.code });
});

logger.info('DB pool configured', { max: poolMax, min: poolMin });

export const dashboardPool = env.dashboardDatabaseUrl
  ? new Pool({ connectionString: env.dashboardDatabaseUrl, max: 10, min: 1, keepAlive: true })
  : null;

/**
 * Snapshot of pool usage — surfaced by GET /api/health/db for ops
 * visibility under load. totalCount = open connections (idle + busy);
 * idleCount = ready for work; waitingCount = requests queued because
 * the pool is at max. waitingCount > 0 is the signal to bump DB_POOL_MAX.
 */
export function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    max: poolMax,
    min: poolMin,
  };
}

let poolsClosed = false;

export async function closePools() {
  if (poolsClosed) return;
  poolsClosed = true;
  await pool.end();
  if (dashboardPool) {
    await dashboardPool.end();
  }
}


export async function verifyDatabaseConnection() {
  const client = await pool.connect();
  try {
    await client.query('select 1');
  } finally {
    client.release();
  }
}
