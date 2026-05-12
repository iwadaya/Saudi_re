function now() {
  return new Date().toISOString();
}

function serializeValue(value) {
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeValue(v)]));
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
