import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let tmpUploadDir;
let isProductionEnv = false; // toggled by the durable-storage guard tests

vi.mock('../config/env.js', () => ({
  get env() {
    return { uploadDir: tmpUploadDir, isProduction: isProductionEnv };
  },
}));

// Mocked Cloudinary v2 client — lets us assert upload/delivery options and signed
// URL minting without a real account. Reset per test via _resetCloudinaryForTests.
const { cldMock } = vi.hoisted(() => ({
  cldMock: {
    config: vi.fn(),
    url: vi.fn((publicId, opts) => `https://signed.example/${publicId}?exp=${opts.expires_at}`),
    uploader: {
      upload_stream: vi.fn((opts, cb) => ({
        end: () => cb(null, {
          secure_url: `https://res.cloudinary.com/cloud/raw/${opts.type}/v1/${opts.folder}/${opts.public_id}`,
        }),
      })),
      destroy: vi.fn(() => Promise.resolve({ result: 'ok' })),
    },
  },
}));
vi.mock('cloudinary', () => ({ v2: cldMock }));

const {
  storeUploadedFile,
  deleteUploadedFile,
  isRemoteStoragePath,
  resolveLocalStoragePath,
  getSignedReadUrl,
  publicIdFromRemoteUrl,
  remoteDeliveryType,
  remoteStorageConfigured,
  localUploadsAllowed,
  SIGNED_URL_TTL_SECONDS,
  _resetCloudinaryForTests,
} = await import('./uploadStorage.js');

beforeEach(async () => {
  tmpUploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-storage-test-'));
  isProductionEnv = false;
  delete process.env.CLOUDINARY_URL;
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_API_KEY;
  delete process.env.CLOUDINARY_API_SECRET;
  delete process.env.ALLOW_LOCAL_UPLOADS;
  _resetCloudinaryForTests();
});

afterEach(async () => {
  await fs.rm(tmpUploadDir, { recursive: true, force: true });
});

describe('storeUploadedFile (local disk fallback)', () => {
  it('writes the buffer under env.uploadDir/<folder>/<timestamp>_<safeName>', async () => {
    const file = { buffer: Buffer.from('hello world'), originalname: 'my report.pdf' };
    const rel = await storeUploadedFile({ folder: 'quotes/abc', file });

    expect(rel).toMatch(/^quotes\/abc\/\d+_my_report\.pdf$/);
    const abs = path.resolve(tmpUploadDir, rel);
    const written = await fs.readFile(abs);
    expect(written.toString()).toBe('hello world');
  });

  it('sanitises filenames so the file stays under env.uploadDir', async () => {
    const file = { buffer: Buffer.from('x'), originalname: '../etc/passwd 🚨.txt' };
    const rel = await storeUploadedFile({ folder: 'fac/1', file });

    expect(rel.startsWith('fac/1/')).toBe(true);
    // No path separators or non-safe characters in the filename portion
    const filename = rel.slice('fac/1/'.length);
    expect(filename).not.toMatch(/[^a-zA-Z0-9._-]/);
    // And the resolved write target lives under the temp upload dir
    const abs = path.resolve(tmpUploadDir, rel);
    expect(abs.startsWith(tmpUploadDir + path.sep)).toBe(true);
    await expect(fs.access(abs)).resolves.toBeUndefined();
  });

  it('creates intermediate directories as needed', async () => {
    const file = { buffer: Buffer.from('data'), originalname: 'a.bin' };
    await storeUploadedFile({ folder: 'deep/nested/place', file });

    const dir = path.resolve(tmpUploadDir, 'deep/nested/place');
    const entries = await fs.readdir(dir);
    expect(entries).toHaveLength(1);
  });

  it('throws when folder is missing', async () => {
    await expect(
      storeUploadedFile({ folder: '', file: { buffer: Buffer.from('x'), originalname: 'a' } }),
    ).rejects.toThrow(/folder is required/);
  });

  it('throws when file.buffer is missing', async () => {
    await expect(
      storeUploadedFile({ folder: 'f', file: { originalname: 'a' } }),
    ).rejects.toThrow(/file\.buffer is required/);
  });
});

describe('durable-storage guard (P1 #2 — no local disk as the prod default)', () => {
  it('refuses local-disk writes in production without an opt-in (503 STORAGE_NOT_DURABLE)', async () => {
    isProductionEnv = true;
    const file = { buffer: Buffer.from('x'), originalname: 'a.pdf' };
    await expect(storeUploadedFile({ folder: 'fac/1', file }))
      .rejects.toMatchObject({ code: 'STORAGE_NOT_DURABLE', status: 503 });
    // Nothing was written.
    await expect(fs.readdir(path.resolve(tmpUploadDir, 'fac/1'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows local-disk writes in production when ALLOW_LOCAL_UPLOADS=true', async () => {
    isProductionEnv = true;
    process.env.ALLOW_LOCAL_UPLOADS = 'true';
    const rel = await storeUploadedFile({ folder: 'fac/1', file: { buffer: Buffer.from('ok'), originalname: 'a.pdf' } });
    expect(rel.startsWith('fac/1/')).toBe(true);
    expect(localUploadsAllowed()).toBe(true);
  });

  it('allows local-disk writes outside production (dev/test default)', async () => {
    isProductionEnv = false;
    const rel = await storeUploadedFile({ folder: 'fac/1', file: { buffer: Buffer.from('ok'), originalname: 'a.pdf' } });
    expect(rel.startsWith('fac/1/')).toBe(true);
  });
});

describe('remoteStorageConfigured', () => {
  it('is true for CLOUDINARY_URL or the three discrete vars, false otherwise', () => {
    expect(remoteStorageConfigured()).toBe(false);
    process.env.CLOUDINARY_URL = 'cloudinary://k:s@cloud';
    expect(remoteStorageConfigured()).toBe(true);
    delete process.env.CLOUDINARY_URL;
    process.env.CLOUDINARY_CLOUD_NAME = 'c';
    process.env.CLOUDINARY_API_KEY = 'k';
    expect(remoteStorageConfigured()).toBe(false); // secret still missing
    process.env.CLOUDINARY_API_SECRET = 's';
    expect(remoteStorageConfigured()).toBe(true);
  });
});

describe('deleteUploadedFile (local fallback)', () => {
  it('unlinks the file when given a relative storage path', async () => {
    const file = { buffer: Buffer.from('x'), originalname: 'gone.txt' };
    const rel = await storeUploadedFile({ folder: 'q/1', file });
    const abs = path.resolve(tmpUploadDir, rel);
    await expect(fs.access(abs)).resolves.toBeUndefined();

    await deleteUploadedFile(rel);
    await expect(fs.access(abs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a missing local file as a success (idempotent cleanup)', async () => {
    await expect(deleteUploadedFile('never-existed/abc.txt')).resolves.toBe(true);
  });

  it('returns false for an empty path', async () => {
    await expect(deleteUploadedFile('')).resolves.toBe(false);
    await expect(deleteUploadedFile(null)).resolves.toBe(false);
  });

  it('rejects traversal attempts via resolveLocalStoragePath', () => {
    expect(() => resolveLocalStoragePath('../../etc/passwd')).toThrow(/escapes upload directory/);
  });
});

describe('Cloudinary delivery (mocked) — private uploads + signed read URLs', () => {
  beforeEach(() => {
    process.env.CLOUDINARY_URL = 'cloudinary://key:secret@cloud';
    _resetCloudinaryForTests();
    cldMock.url.mockClear();
    cldMock.uploader.upload_stream.mockClear();
    cldMock.uploader.destroy.mockClear();
  });
  afterEach(() => {
    delete process.env.CLOUDINARY_URL;
    _resetCloudinaryForTests();
  });

  it('uploads as private (type:authenticated) and never public', async () => {
    const url = await storeUploadedFile({ folder: 'universe3/c1', file: { buffer: Buffer.from('x'), originalname: 'r.pdf' } });
    const opts = cldMock.uploader.upload_stream.mock.calls[0][0];
    expect(opts.type).toBe('authenticated');
    expect(opts.access_mode).toBeUndefined(); // no public delivery
    expect(url).toContain('/raw/authenticated/'); // stored secure_url is private-delivery
  });

  it('getSignedReadUrl mints a short-lived, app-signed URL for a remote asset', async () => {
    const stored = 'https://res.cloudinary.com/cloud/raw/authenticated/v1/universe3/c1/1700000000_r.pdf';
    const before = Math.floor(Date.now() / 1000);
    const signed = await getSignedReadUrl(stored);
    const [publicId, opts] = cldMock.url.mock.calls[0];

    expect(opts.type).toBe('authenticated');
    expect(opts.sign_url).toBe(true);
    expect(opts.resource_type).toBe('raw');
    // Expiry is short and in the near future (now + TTL), never permanent.
    expect(SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(opts.expires_at).toBeGreaterThanOrEqual(before + SIGNED_URL_TTL_SECONDS);
    expect(opts.expires_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS + 2);
    // public_id is derived without the delivery-type/version/extension segments.
    expect(publicId).toBe('universe3/c1/1700000000_r.pdf'.replace(/\.[^/.]+$/, ''));
    expect(signed).toBe(`https://signed.example/${publicId}?exp=${opts.expires_at}`);
    expect(signed).not.toBe(stored); // never the permanent stored URL
  });

  it('getSignedReadUrl honours a custom (shorter) TTL', async () => {
    await getSignedReadUrl('https://res.cloudinary.com/cloud/raw/authenticated/v1/f.pdf', { ttlSeconds: 30 });
    const now = Math.floor(Date.now() / 1000);
    expect(cldMock.url.mock.calls[0][1].expires_at).toBeLessThanOrEqual(now + 31);
  });

  it('getSignedReadUrl returns null for local-disk paths (no remote minting)', async () => {
    expect(await getSignedReadUrl('quotes/abc/123_file.pdf')).toBeNull();
    expect(cldMock.url).not.toHaveBeenCalled();
  });

  it('deleteUploadedFile destroys an authenticated asset with the right delivery type', async () => {
    await deleteUploadedFile('https://res.cloudinary.com/cloud/raw/authenticated/s--SIG--/v1/universe3/c1/file.pdf');
    expect(cldMock.uploader.destroy).toHaveBeenCalledWith(
      'universe3/c1/file', { resource_type: 'raw', type: 'authenticated' },
    );
  });
});

describe('getSignedReadUrl without Cloudinary configured', () => {
  beforeEach(() => { delete process.env.CLOUDINARY_URL; _resetCloudinaryForTests(); });
  it('returns null for a remote path when Cloudinary is not configured (never leaks the stored URL)', async () => {
    expect(await getSignedReadUrl('https://res.cloudinary.com/cloud/raw/authenticated/v1/f.pdf')).toBeNull();
  });
});

describe('remote URL parsing helpers', () => {
  it('publicIdFromRemoteUrl strips delivery type, signature, version and extension', () => {
    expect(publicIdFromRemoteUrl('https://res.cloudinary.com/c/raw/upload/v123/folder/file.pdf')).toBe('folder/file');
    expect(publicIdFromRemoteUrl('https://res.cloudinary.com/c/raw/authenticated/s--ABCD--/v9/a/b.csv')).toBe('a/b');
    expect(publicIdFromRemoteUrl('not-a-url')).toBeNull();
  });
  it('remoteDeliveryType detects authenticated/private/upload', () => {
    expect(remoteDeliveryType('https://x/raw/authenticated/v1/f.pdf')).toBe('authenticated');
    expect(remoteDeliveryType('https://x/raw/private/v1/f.pdf')).toBe('private');
    expect(remoteDeliveryType('https://x/raw/upload/v1/f.pdf')).toBe('upload');
  });
});

describe('isRemoteStoragePath', () => {
  it('recognises http and https URLs', () => {
    expect(isRemoteStoragePath('https://res.cloudinary.com/x/raw/upload/v1/f.pdf')).toBe(true);
    expect(isRemoteStoragePath('http://example.com/f.pdf')).toBe(true);
  });

  it('treats relative paths as local', () => {
    expect(isRemoteStoragePath('quotes/abc/123_file.pdf')).toBe(false);
    expect(isRemoteStoragePath('')).toBe(false);
    expect(isRemoteStoragePath(null)).toBe(false);
    expect(isRemoteStoragePath(undefined)).toBe(false);
  });
});
