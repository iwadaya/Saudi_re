import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import {
  sniffFamily,
  validateFileType,
  scanForMalware,
  assertUploadSafe,
  malwareScanEnabled,
  UploadValidationError,
  ALLOWED_TYPES,
} from './uploadValidation.js';

// Minimal magic-byte fixtures.
const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from('-1.7\n%body')]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
const CSV = Buffer.from('policy_id,premium\nA1,1000\nA2,2000\n', 'utf8');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]); // "MZ" PE header

afterEach(() => {
  delete process.env.CLAMAV_ENABLED;
  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_PORT;
});

describe('sniffFamily', () => {
  it('detects each supported binary family from magic bytes', () => {
    expect(sniffFamily(PDF)).toBe('pdf');
    expect(sniffFamily(PNG)).toBe('png');
    expect(sniffFamily(JPEG)).toBe('jpeg');
    expect(sniffFamily(ZIP)).toBe('zip');
    expect(sniffFamily(OLE2)).toBe('ole2');
  });
  it('detects plain text and rejects binary / empty', () => {
    expect(sniffFamily(CSV)).toBe('text');
    expect(sniffFamily(EXE)).toBeNull();          // unknown binary, has no signature
    expect(sniffFamily(Buffer.alloc(0))).toBeNull();
    expect(sniffFamily(Buffer.from([0x00, 0x01, 0x02]))).toBeNull(); // NUL → not text
  });
});

describe('validateFileType (extension allowlist + content match)', () => {
  it('accepts an allowed type whose bytes match, returning the trusted mime', () => {
    expect(validateFileType({ originalname: 'slip.pdf', buffer: PDF }))
      .toEqual({ ext: 'pdf', mime: 'application/pdf', family: 'pdf' });
    expect(validateFileType({ originalname: 'sheet.xlsx', buffer: ZIP }).mime)
      .toBe(ALLOWED_TYPES.xlsx.mime);
    expect(validateFileType({ originalname: 'data.CSV', buffer: CSV }).family).toBe('text');
  });

  it('rejects a disallowed extension with 415', () => {
    try {
      validateFileType({ originalname: 'payload.exe', buffer: EXE });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UploadValidationError);
      expect(e.status).toBe(415);
      expect(e.code).toBe('UNSUPPORTED_FILE_TYPE');
    }
  });

  it('rejects a content/extension mismatch (exe renamed to .pdf) with 422', () => {
    expect(() => validateFileType({ originalname: 'evil.pdf', buffer: ZIP }))
      .toThrowError(/do not match/i);
    try {
      validateFileType({ originalname: 'evil.pdf', buffer: ZIP });
    } catch (e) {
      expect(e.status).toBe(422);
      expect(e.code).toBe('CONTENT_TYPE_MISMATCH');
    }
  });

  it('rejects an unreadable binary given a text extension with 422', () => {
    try {
      validateFileType({ originalname: 'notes.csv', buffer: EXE });
    } catch (e) {
      expect(e.status).toBe(422);
      expect(e.code).toBe('UNREADABLE_FILE');
    }
  });
});

describe('assertUploadSafe presence/empty guards', () => {
  it('rejects a missing file (400) and an empty buffer (422)', async () => {
    await expect(assertUploadSafe(null)).rejects.toMatchObject({ status: 400, code: 'NO_FILE' });
    await expect(assertUploadSafe({ originalname: 'x.pdf', buffer: Buffer.alloc(0) }))
      .rejects.toMatchObject({ status: 422, code: 'EMPTY_FILE' });
  });

  it('returns the trusted descriptor when scanning is disabled (no-op)', async () => {
    expect(malwareScanEnabled()).toBe(false);
    await expect(assertUploadSafe({ originalname: 'r.pdf', buffer: PDF }))
      .resolves.toEqual({ ext: 'pdf', mime: 'application/pdf', family: 'pdf' });
  });
});

// A tiny stand-in clamd that consumes the INSTREAM frames and replies with a
// configurable verdict, exercising the real socket protocol in scanForMalware.
function fakeClamd(verdict) {
  const server = net.createServer((socket) => {
    socket.on('data', (buf) => {
      // The final frame is a zero-length chunk (4 zero bytes); reply after it.
      if (buf.length >= 4 && buf.subarray(buf.length - 4).equals(Buffer.from([0, 0, 0, 0]))) {
        socket.end(`${verdict}\0`);
      }
    });
    socket.on('error', () => {});
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

describe('scanForMalware (clamd INSTREAM, fail-closed)', () => {
  beforeEach(() => { process.env.CLAMAV_ENABLED = 'true'; });

  it('passes a clean verdict', async () => {
    const server = fakeClamd('stream: OK');
    const port = await listen(server);
    try {
      await expect(scanForMalware(PDF, { host: '127.0.0.1', port })).resolves.toMatchObject({ clean: true, scanned: true });
    } finally {
      server.close();
    }
  });

  it('rejects a FOUND verdict with 422 MALWARE_DETECTED', async () => {
    const server = fakeClamd('stream: Eicar-Test-Signature FOUND');
    const port = await listen(server);
    try {
      await expect(scanForMalware(PDF, { host: '127.0.0.1', port }))
        .rejects.toMatchObject({ status: 422, code: 'MALWARE_DETECTED' });
    } finally {
      server.close();
    }
  });

  it('fails CLOSED (503) when clamd is unreachable', async () => {
    // Nothing listening on this port → connection refused.
    await expect(scanForMalware(PDF, { host: '127.0.0.1', port: 1, timeoutMs: 500 }))
      .rejects.toMatchObject({ status: 503, code: 'MALWARE_SCAN_UNAVAILABLE' });
  });

  it('is a no-op when CLAMAV_ENABLED is not set', async () => {
    delete process.env.CLAMAV_ENABLED;
    await expect(scanForMalware(PDF)).resolves.toEqual({ scanned: false, clean: true });
  });
});
