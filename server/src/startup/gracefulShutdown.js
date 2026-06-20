// server/src/startup/gracefulShutdown.js
// Drain HTTP cleanly on SIGTERM/SIGINT so deploys don't kill in-flight
// saves. Three-stage shutdown:
//
//   1. server.close() — stop accepting new connections; let in-flight
//      requests complete their response.
//   2. After GRACE_MS, force-close idle keep-alive sockets so deploy
//      scripts don't wait forever for clients holding the connection.
//   3. After HARD_DEADLINE_MS total, exit non-zero so the orchestrator
//      knows we couldn't finish cleanly (better than hanging the
//      deploy queue).
//
// All knobs overridable via env:
//   SHUTDOWN_GRACE_MS   (default 10s)
//   SHUTDOWN_DEADLINE_MS (default 25s)

import { logger } from '../lib/logger.js';
import { closePools } from '../db/pool.js';
import { closeRateLimitStore } from '../lib/rateLimitStore.js';

const GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10_000;
const HARD_DEADLINE_MS = Number(process.env.SHUTDOWN_DEADLINE_MS) || 25_000;

let installed = false;

export function installGracefulShutdown(server) {
  if (installed) return; // idempotent — bootstrap may be called twice in tests
  installed = true;

  // Track open sockets so we can destroy idle keep-alive connections
  // after the grace period.
  const openSockets = new Set();
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      logger.warn('second shutdown signal received — exiting immediately', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info('shutdown requested', { signal, openSockets: openSockets.size });

    // Hard deadline timer — last resort if everything below stalls.
    const deadlineTimer = setTimeout(() => {
      logger.error('shutdown deadline exceeded — forcing exit', { deadlineMs: HARD_DEADLINE_MS });
      process.exit(1);
    }, HARD_DEADLINE_MS);
    deadlineTimer.unref();

    // Stage 1: stop accepting new connections.
    server.close(async () => {
      try {
        await closeRateLimitStore();
        await closePools();
        logger.info('database pools closed — clean shutdown');
      } catch (err) {
        logger.error('failed to close pools cleanly', { error: err.message });
      } finally {
        clearTimeout(deadlineTimer);
        process.exit(0);
      }
    });

    // Stage 2: after GRACE_MS, kill idle keep-alive sockets so the
    // server.close() callback can fire even when clients refuse to
    // hang up.
    setTimeout(() => {
      let killed = 0;
      for (const socket of openSockets) {
        // Only destroy sockets that aren't actively writing a response.
        if (!socket.destroyed && socket.writable && socket._httpMessage == null) {
          socket.destroy();
          killed++;
        }
      }
      if (killed > 0) {
        logger.info('forced-closed idle keep-alive sockets', { killed });
      }
    }, GRACE_MS).unref();
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT',  () => { void shutdown('SIGINT'); });

  // Last-ditch crash logging
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { error: err.message, stack: err.stack });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error('unhandledRejection', { reason: msg });
  });
}
