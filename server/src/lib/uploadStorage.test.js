import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let tmpUploadDir;

vi.mock('../config/env.js', () => ({
  get env() {
    return { uploadDir: tmpUploadDir };
  },
}));

const {
  storeUploadedFile,
  deleteUploadedFile,
  isRemoteStoragePath,
  resolveLocalStoragePath,
  _resetCloudinaryForTests,
} = await import('./uploadStorage.js');

beforeEach(async () => {
  tmpUploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-storage-test-'));
  delete process.env.CLOUDINARY_URL;
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
