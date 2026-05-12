// server/src/observability/poolMetrics.js
//
// Register gauges that reflect pg-pool pressure. These are the top
// signals for "is the DB the bottleneck?" — a non-zero waiting count
// is the leading indicator that pool capacity is under-provisioned.
//
// All three are async observable gauges — OTel polls them on each
// metric collection, so there's no hot-path cost per request.

import { metrics } from '@opentelemetry/api';
import { pool } from '../db/pool.js';

export function registerPoolMetrics() {
  const meter = metrics.getMeter('universe.db.pool');

  const size = meter.createObservableGauge('pg_pool_size', {
    description: 'Open pg pool connections (idle + busy)',
    unit: 'connection',
  });
  const idle = meter.createObservableGauge('pg_pool_idle', {
    description: 'Idle pg pool connections ready to serve a query',
    unit: 'connection',
  });
  const waiting = meter.createObservableGauge('pg_pool_waiting', {
    description: 'Requests waiting for a connection — the leading indicator of pool starvation',
    unit: 'request',
  });

  meter.addBatchObservableCallback(
    (obs) => {
      obs.observe(size,    pool.totalCount);
      obs.observe(idle,    pool.idleCount);
      obs.observe(waiting, pool.waitingCount);
    },
    [size, idle, waiting],
  );
}
