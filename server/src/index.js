// OpenTelemetry MUST be the very first import. Auto-instrumentation
// patches pg/http/express at require-time, so any module loaded
// before this runs goes un-instrumented. The telemetry module is a
// no-op unless OTEL_ENABLED is set.
import './observability/telemetry.js';

import { logger } from './lib/logger.js';
import { bootstrap } from './startup/bootstrap.js';

bootstrap().catch((error) => {
  logger.error('application startup failed', { error });
  process.exit(1);
});
