function now() {
  return new Date().toISOString();
}

// Keys whose VALUES must never reach the logs (secrets / PII). Matched
// case-insensitively by exact key name; anything logged under one of these is
// replaced with '[REDACTED]' — recursively, so a secret nested deep in a meta
// object is still scrubbed. Kept cheap: a single Set lookup per key on the
// serialization path we already walk.
const REDACT_KEYS = new Set([
  'password', 'pass', 'token', 'secret', 'authorization', 'cookie',
  'api_key', 'apikey', 'jwt', 'session', 'ssn', 'otp',
]);
// Authorization/Cookie-like headers carry bearer tokens / cookie jars that are
// both sensitive AND bulky; these are redacted outright (the strongest form of
// truncation) rather than emitted at any length.
const TRUNCATE_KEYS = new Set(['authorization', 'cookie']);
const REDACTED = '[REDACTED]';

function serializeValue(value) {
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      const lk = String(k).toLowerCase();
      if (TRUNCATE_KEYS.has(lk) || REDACT_KEYS.has(lk)) return [k, REDACTED];
      return [k, serializeValue(v)];
    }));
  }
  return value;
}

export function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    status: error.status || error.statusCode || undefined,
  };
}

function write(level, message, meta = {}) {
  const payload = {
    ts: now(),
    level,
    message,
    ...serializeValue(meta),
  };

  const line = JSON.stringify(payload);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info(message, meta) {
    write('info', message, meta);
  },
  warn(message, meta) {
    write('warn', message, meta);
  },
  error(message, meta) {
    write('error', message, meta);
  },
  debug(message, meta) {
    write('debug', message, meta);
  },
  child(baseMeta = {}) {
    return {
      info(message, meta) {
        write('info', message, { ...baseMeta, ...meta });
      },
      warn(message, meta) {
        write('warn', message, { ...baseMeta, ...meta });
      },
      error(message, meta) {
        write('error', message, { ...baseMeta, ...meta });
      },
      debug(message, meta) {
        write('debug', message, { ...baseMeta, ...meta });
      },
    };
  },
};
