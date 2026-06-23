// server/src/lib/uploadValidation.js
//
// Pre-storage validation for every document upload (treaty / quote / fac). The
// upload routes use multer memoryStorage, so we have the bytes in hand before
// anything is persisted — this is the place to reject hostile or unexpected
// files BEFORE they reach durable storage or get a DB row.
//
// Three layers, all enforced by assertUploadSafe():
//
//   1. EXTENSION ALLOWLIST. Only the document types the platform actually uses
//      (PDF, Office docs, images, CSV/text) are accepted. Anything else → 415.
//
//   2. CONTENT SNIFFING (magic bytes). The browser-supplied Content-Type is
//      attacker-controlled and never trusted. We sniff the real type from the
//      file's leading bytes and require it to match the extension's family, so
//      `evil.exe` renamed to `slip.pdf` is rejected (422). The mime_type we
//      persist is the canonical type for the verified extension — never the
//      client's declared value.
//
//   3. MALWARE SCAN (optional, fail-closed). When CLAMAV_ENABLED=true every
//      buffer is streamed to clamd (INSTREAM). A FOUND verdict → 422; a scan
//      that cannot complete (clamd down/unreachable) → 503 so an unscanned file
//      is NEVER stored. When disabled it is a no-op (dev/test).
//
// No new dependency: the sniffer is a small magic-byte table and the clamd
// client is a raw TCP socket. Errors carry { status, code } so the central
// errorHandler renders them as the right HTTP response.

import net from 'node:net';

/** Error that the central errorHandler maps to `status` + `{ code }`. */
export class UploadValidationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'UploadValidationError';
    this.status = status;
    this.code = code;
  }
}

// Extension → { mime (canonical, trusted), family (must match sniffed bytes) }.
// `family` groups extensions that share a magic-byte signature (e.g. all OOXML
// files are ZIP containers; .csv/.txt are plain text).
export const ALLOWED_TYPES = Object.freeze({
  pdf:  { mime: 'application/pdf', family: 'pdf' },
  png:  { mime: 'image/png', family: 'png' },
  jpg:  { mime: 'image/jpeg', family: 'jpeg' },
  jpeg: { mime: 'image/jpeg', family: 'jpeg' },
  gif:  { mime: 'image/gif', family: 'gif' },
  csv:  { mime: 'text/csv', family: 'text' },
  txt:  { mime: 'text/plain', family: 'text' },
  // Office Open XML (ZIP containers).
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', family: 'zip' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', family: 'zip' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', family: 'zip' },
  // Legacy OLE2 compound documents.
  xls:  { mime: 'application/vnd.ms-excel', family: 'ole2' },
  doc:  { mime: 'application/msword', family: 'ole2' },
  ppt:  { mime: 'application/vnd.ms-powerpoint', family: 'ole2' },
});

// Binary magic-byte signatures, checked at offset 0 unless noted.
const MAGIC = [
  { family: 'pdf',  bytes: [0x25, 0x50, 0x44, 0x46] },                          // %PDF
  { family: 'png',  bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },  // PNG
  { family: 'jpeg', bytes: [0xff, 0xd8, 0xff] },                                // JPEG SOI
  { family: 'gif',  bytes: [0x47, 0x49, 0x46, 0x38] },                          // GIF8
  { family: 'zip',  bytes: [0x50, 0x4b, 0x03, 0x04] },                          // PK\x03\x04
  { family: 'zip',  bytes: [0x50, 0x4b, 0x05, 0x06] },                          // empty archive
  { family: 'zip',  bytes: [0x50, 0x4b, 0x07, 0x08] },                          // spanned archive
  { family: 'ole2', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },  // OLE2 compound
];

function startsWith(buf, sig) {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) if (buf[i] !== sig[i]) return false;
  return true;
}

// Heuristic: is this buffer plain text? No NUL byte in the inspected window and
// it decodes as valid UTF-8. Distinguishes a real CSV from a binary blob given a
// .csv extension (a renamed PDF/zip sniffs to its own family and is rejected on
// mismatch; a renamed binary fails this check → UNREADABLE_FILE).
function looksLikeText(buf) {
  const window = buf.subarray(0, Math.min(buf.length, 8192));
  if (window.includes(0x00)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(window);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sniff the content family from the bytes. Returns 'pdf'|'png'|'jpeg'|'gif'|
 * 'zip'|'ole2'|'text' or null when nothing matches.
 * @param {Buffer} buffer
 */
export function sniffFamily(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  for (const sig of MAGIC) if (startsWith(buffer, sig.bytes)) return sig.family;
  return looksLikeText(buffer) ? 'text' : null;
}

function extensionOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/**
 * Validate a file's extension against the allowlist and confirm its real
 * contents match. Throws UploadValidationError; returns { ext, mime, family }
 * with the TRUSTED canonical mime to persist.
 * @param {{ originalname?: string, buffer: Buffer }} file
 */
export function validateFileType(file) {
  const ext = extensionOf(file?.originalname);
  const allow = ALLOWED_TYPES[ext];
  if (!allow) {
    throw new UploadValidationError(
      415, 'UNSUPPORTED_FILE_TYPE',
      `File type ".${ext || ''}" is not allowed. Accepted: ${Object.keys(ALLOWED_TYPES).join(', ')}.`,
    );
  }
  const detected = sniffFamily(file.buffer);
  if (detected === null) {
    throw new UploadValidationError(
      422, 'UNREADABLE_FILE',
      'Could not verify the file type from its contents.',
    );
  }
  if (detected !== allow.family) {
    throw new UploadValidationError(
      422, 'CONTENT_TYPE_MISMATCH',
      `File contents do not match the ".${ext}" extension.`,
    );
  }
  return { ext, mime: allow.mime, family: allow.family };
}

/** True when malware scanning is switched on (production must enable it). */
export function malwareScanEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.CLAMAV_ENABLED || '').toLowerCase());
}

// Stream a buffer to clamd via the INSTREAM command and resolve with its reply
// string. Rejects on connection/timeout error so the caller can fail closed.
function clamdInstream(buffer, { host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let reply = '';
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(arg);
    };
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(reject, new Error('clamd scan timed out')));
    socket.on('error', (err) => finish(reject, err));
    socket.on('data', (chunk) => { reply += chunk.toString('utf8'); });
    socket.on('end', () => finish(resolve, reply.replace(/\0/g, '').trim()));
    socket.on('connect', () => {
      // 'z' prefix = NUL-terminated command; then 4-byte BE length-prefixed
      // chunks, terminated by a zero-length chunk.
      socket.write('zINSTREAM\0');
      const CHUNK = 64 * 1024;
      for (let off = 0; off < buffer.length; off += CHUNK) {
        const slice = buffer.subarray(off, Math.min(off + CHUNK, buffer.length));
        const size = Buffer.alloc(4);
        size.writeUInt32BE(slice.length, 0);
        socket.write(size);
        socket.write(slice);
      }
      socket.write(Buffer.from([0, 0, 0, 0]));
    });
  });
}

/**
 * Scan a buffer for malware when CLAMAV_ENABLED. No-op (returns
 * { scanned:false }) when disabled. When enabled it is FAIL-CLOSED: a FOUND
 * verdict throws 422 MALWARE_DETECTED; any scan that cannot complete throws
 * 503 MALWARE_SCAN_UNAVAILABLE so an unscanned file is never accepted.
 * @param {Buffer} buffer
 * @param {{ host?, port?, timeoutMs? }} [opts]  test/config overrides
 */
export async function scanForMalware(buffer, opts = {}) {
  if (!malwareScanEnabled()) return { scanned: false, clean: true };
  const host = opts.host || process.env.CLAMAV_HOST || '127.0.0.1';
  const port = Number(opts.port || process.env.CLAMAV_PORT) || 3310;
  const timeoutMs = Number(opts.timeoutMs || process.env.CLAMAV_TIMEOUT_MS) || 30000;

  let reply;
  try {
    reply = await clamdInstream(buffer, { host, port, timeoutMs });
  } catch (err) {
    throw new UploadValidationError(
      503, 'MALWARE_SCAN_UNAVAILABLE',
      `Upload rejected: malware scan could not be completed (${err?.message || 'scanner unreachable'}).`,
    );
  }
  if (/\bFOUND\b/.test(reply)) {
    const sig = (reply.match(/:\s*(.+?)\s+FOUND/) || [])[1] || 'unknown';
    throw new UploadValidationError(422, 'MALWARE_DETECTED', `Upload rejected: malware detected (${sig}).`);
  }
  if (/\bOK\b/.test(reply)) return { scanned: true, clean: true };
  // ERROR / unexpected reply → fail closed.
  throw new UploadValidationError(
    503, 'MALWARE_SCAN_UNAVAILABLE',
    `Upload rejected: unexpected malware-scanner response (${reply || 'empty'}).`,
  );
}

/**
 * One call the upload routes make after multer and before storeUploadedFile.
 * Enforces presence → non-empty → extension allowlist → content sniff →
 * malware scan. Returns the validated { ext, mime, family } to persist.
 * @param {{ originalname?: string, buffer?: Buffer }} file  multer memory file
 */
export async function assertUploadSafe(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new UploadValidationError(400, 'NO_FILE', 'No file provided.');
  }
  if (file.buffer.length === 0) {
    throw new UploadValidationError(422, 'EMPTY_FILE', 'The uploaded file is empty.');
  }
  const detected = validateFileType(file);
  await scanForMalware(file.buffer, { filename: file.originalname });
  return detected;
}
