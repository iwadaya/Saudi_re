// ecosystem.config.cjs — PM2 configuration for horizontal scaling.
//
// Single-box cluster mode. Run via:
//   npm run start:cluster          # spins up N workers behind one port
//   npm run cluster:reload         # zero-downtime rolling reload
//   npm run cluster:stop           # stops all workers
//
// Why cluster mode: Node is single-threaded, so on a 4-core box a
// single `node server/src/index.js` leaves 75% of CPU idle under load.
// PM2 cluster_mode uses the built-in `cluster` module to fork one
// worker per core; incoming connections are round-robined by the OS
// via SO_REUSEPORT. No nginx required — we still bind a single port,
// the kernel does the balancing.
//
// ── Things you MUST know before deploying this ────────────────────
//
// 1. DB_POOL_MAX is per-worker, not cluster-wide. Postgres default
//    max_connections is 100; with 4 workers × DB_POOL_MAX=50 you'd
//    blow past it. Override DB_POOL_MAX on the whole env so total
//    stays under 80 (leaving 20 for migrations + manual queries):
//        DB_POOL_MAX = floor(80 / num_workers)
//    This file sets a sane default assuming a 4-core box → 20.
//
// 2. _refCache (in server/src/routes/lookups.js) is per-process and
//    per-worker will diverge for up to REF_TTL_MS (5min). Acceptable
//    for the demo — brokers/reinsurers don't change intra-day. If
//    you ever need strict consistency, add Redis.
//
// 3. The in-memory express-rate-limit is per-process. A cluster of
//    4 effectively multiplies the per-user cap 4×. Either:
//      (a) accept it (our current per-user cap is 300/min; 1200/min
//          across a cluster is still safe)
//      (b) front with nginx/HAProxy and do rate limiting there
//      (c) switch to rate-limit-redis when you add Redis
//
// 4. Migrations are guarded by a Postgres advisory lock (see
//    startup/runMigrations.js). All workers can safely run bootstrap
//    in parallel — only one actually applies pending files.

const os = require('os');

// Default to #CPUs but cap at 4 — more than 4 workers on a modest
// box costs more in context-switching than it earns. Override with
// PM2_INSTANCES=8 on a bigger host.
const instances = Number(process.env.PM2_INSTANCES) || Math.min(os.cpus().length, 4);

// Per-worker pool so the sum stays under Postgres' max_connections.
// If DB_POOL_MAX is already exported, we respect it verbatim; otherwise
// we derive a safe default from the instance count.
const derivedPoolMax = Math.max(8, Math.floor(80 / instances));
const dbPoolMax = Number(process.env.DB_POOL_MAX) || derivedPoolMax;

module.exports = {
  apps: [
    {
      name: 'universe',
      script: 'server/src/index.js',

      // ── Clustering ────────────────────────────────────────────
      exec_mode: 'cluster',
      instances,

      // ── Graceful lifecycle ────────────────────────────────────
      // Wait for existing connections to drain on reload.
      // kill_timeout MUST be >= SHUTDOWN_GRACE_MS (default 10s) so
      // PM2 doesn't SIGKILL the worker mid-drain.
      kill_timeout: 15000,
      wait_ready: false,          // we don't emit process.send('ready')
      listen_timeout: 10000,

      // Restart on crash with backoff; give up after 10 rapid
      // consecutive failures so a broken deploy doesn't thrash CPU.
      max_restarts: 10,
      restart_delay: 2000,
      min_uptime: 10_000,

      // ── Resource ceilings ────────────────────────────────────
      // Restart a worker if it exceeds 1GB RSS (catches leaks).
      max_memory_restart: '1G',

      // ── Logging ───────────────────────────────────────────────
      // App already emits structured JSON to stdout; PM2 appends
      // {pid, timestamp} wrappers we don't need. Merge logs across
      // workers into one stream so operators can grep by requestId.
      merge_logs: true,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      // ── Runtime env ───────────────────────────────────────────
      env: {
        NODE_ENV: 'production',
        // Reject pricing drift (422) instead of warn-only. Prod also defaults to
        // strict in code; this pins it. Set "0" only for a rehearsed rollback.
        PRICING_STRICT: '1',
        DB_POOL_MAX: String(dbPoolMax),
        // Only worker 0 starts the pool watchdog — it would log N
        // duplicate warnings otherwise. All workers still observe
        // pool pressure individually via the x-pool-waiting header.
        POOL_WATCHDOG_CLUSTER: '1',
      },
    },
  ],
};
