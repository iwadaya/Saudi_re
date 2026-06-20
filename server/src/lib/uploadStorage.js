// server/src/lib/uploadStorage.js
//
// Shared upload sink for document routes (treaty, quote, fac). Three
// near-identical copies used to live in routes/*.js with subtly
// different error handling — most damagingly, quotes.js swallowed
// Cloudinary failures and persisted a row pointing at a `pending/...`
// path that no file was ever written to. This module collapses them
// onto one path:
//
//   • Cloudinary if CLOUDINARY_URL is set — returns the secure URL.
//   • Local disk under env.uploadDir otherwise — returns a path
//     relative to env.uploadDir so the read side can `path.join`
//     and serve it without needing to know which sink was used.
//
// Errors from either sink propagate; the route decides how to surface
// them (a 502 is the obvious default).

import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

let _cloudinary = null;

async function getCloudinary() {
  if (!_cloudinary && process.env.CLOUDINARY_URL) {
    const mod = await import('cloudinary');
    _cloudinary = mod.v2;
    _cloudinary.config({ secure: true });
  }
  return _cloudinary;
}

// Test seam: lets the unit tests reset the cached client between cases.
export function _resetCloudinaryForTests() {
  _cloudinary = null;
}

function safeFilename(originalname) {
  return String(originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Persist an uploaded file and return the storage_path/storage_key to
 * write on the document row. The returned value is either a Cloudinary
 * https:// URL or a path relative to env.uploadDir.
 *
 * @param {object} args
 * @param {string} args.folder    e.g. `quotes/<id>`, `fac/<id>`,
 *                                `universe3/<id>`. Used as the
 *                                Cloudinary folder and the local-disk
 *                                subdirectory.
 * @param {{ buffer: Buffer, originalname: string }} args.file  multer
 *                                memory-storage file.
 * @returns {Promise<string>}
 */
export async function storeUploadedFile({ folder, file }) {
  if (!folder) throw new Error('storeUploadedFile: folder is required');
  if (!file?.buffer) throw new Error('storeUploadedFile: file.buffer is required');

  const filename = `${Date.now()}_${safeFilename(file.originalname)}`;
  const relPath = `${folder}/${filename}`;

  const cld = await getCloudinary();
  if (cld) {
    return new Promise((resolve, reject) => cld.uploader.upload_stream(
      {
        folder,
        public_id: filename,
        resource_type: 'raw',
        use_filename: false,
        // Private delivery: 'authenticated' assets are NOT publicly reachable —
        // each read must be an app-minted, short-lived signed URL (see
        // getSignedReadUrl). Never 'upload'/access_mode:'public', which would
        // hand out a permanent world-readable link.
        type: 'authenticated',
      },
      (err, result) => (err ? reject(err) : resolve(result.secure_url)),
    ).end(file.buffer));
  }

  const absDir = path.resolve(env.uploadDir, folder);
  await fs.mkdir(absDir, { recursive: true });
  const absPath = path.resolve(env.uploadDir, relPath);
  await fs.writeFile(absPath, file.buffer);
  return relPath;
}

/**
 * True when the stored path looks like a Cloudinary (or other remote)
 * URL. Callers use this to decide between redirect/fetch vs. disk read.
 */
export function isRemoteStoragePath(storagePath) {
  return typeof storagePath === 'string' && /^https?:\/\//i.test(storagePath);
}

// Short-lived TTL for app-minted signed read URLs. Kept small so a leaked link
// is useless within minutes; the app re-mints on every authorised read.
export const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes

/**
 * Cloudinary delivery type encoded in a stored secure_url. New assets are
 * 'authenticated' (private); legacy rows may be 'upload' (public) or 'private'.
 */
export function remoteDeliveryType(url) {
  if (typeof url !== 'string') return 'upload';
  if (url.includes('/authenticated/')) return 'authenticated';
  if (url.includes('/private/')) return 'private';
  return 'upload';
}

/**
 * Derive the Cloudinary public_id from a stored secure_url, stripping the
 * delivery-type segment, any signature (s--SIG--), version (v123) and extension.
 */
export function publicIdFromRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/(?:authenticated|private|upload)\/(.+)$/);
  if (!m) return null;
  return m[1]
    .replace(/^s--[^/]+--\//, '') // signature segment
    .replace(/^v\d+\//, '')        // version segment
    .replace(/\.[^/.]+$/, '');      // file extension
}

/**
 * Mint a short-lived, app-signed read URL for a remote (Cloudinary) asset.
 * Returns null for local-disk paths (streamed directly) or when Cloudinary is
 * not configured / the public_id can't be derived. The URL is time-limited
 * (expires_at) so it cannot be replayed beyond the TTL — callers must only mint
 * AFTER the document ACL check passes, and must never hand out the permanent
 * stored URL.
 *
 * @param {string} storagePath  the stored secure_url.
 * @param {{ ttlSeconds?: number }} [opts]
 * @returns {Promise<string|null>}
 */
export async function getSignedReadUrl(storagePath, { ttlSeconds = SIGNED_URL_TTL_SECONDS } = {}) {
  if (!isRemoteStoragePath(storagePath)) return null;
  const cld = await getCloudinary();
  if (!cld) return null;
  const publicId = publicIdFromRemoteUrl(storagePath);
  if (!publicId) return null;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return cld.url(publicId, {
    resource_type: 'raw',
    type: 'authenticated',
    sign_url: true,
    secure: true,
    expires_at: expiresAt,
  });
}

/**
 * Resolve a stored relative path to an absolute path inside
 * env.uploadDir. Throws if the resolved path escapes the directory,
 * which would only happen with a poisoned DB row.
 */
export function resolveLocalStoragePath(relPath) {
  const root = path.resolve(env.uploadDir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('storage path escapes upload directory');
  }
  return abs;
}

/**
 * Delete a previously stored file from whichever sink holds it.
 * Best-effort: a missing local file or failed Cloudinary destroy is
 * logged by the caller, not raised, because the DB row has typically
 * already been removed.
 *
 * Returns true if the underlying asset was acted on (or didn't exist
 * locally — ENOENT is normal); throws on unexpected I/O errors so the
 * caller can decide whether to log.
 */
export async function deleteUploadedFile(storagePath) {
  if (!storagePath) return false;
  if (isRemoteStoragePath(storagePath)) {
    const cld = await getCloudinary();
    if (!cld) return false;
    // URL format: https://res.cloudinary.com/{cloud}/raw/{type}/[s--SIG--/]v{ver}/{public_id}.{ext}
    // where {type} is authenticated (new), upload (legacy public) or private.
    const publicId = publicIdFromRemoteUrl(storagePath);
    if (!publicId) return false;
    await cld.uploader.destroy(publicId, { resource_type: 'raw', type: remoteDeliveryType(storagePath) });
    return true;
  }
  const abs = resolveLocalStoragePath(storagePath);
  try {
    await fs.unlink(abs);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    throw err;
  }
}
