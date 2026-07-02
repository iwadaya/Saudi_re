// server/src/lib/uploadStorage.js
//
// Shared upload sink for document routes (treaty, quote, fac). Three
// near-identical copies used to live in routes/*.js with subtly
// different error handling — most damagingly, quotes.js swallowed
// Cloudinary failures and persisted a row pointing at a `pending/...`
// path that no file was ever written to. This module collapses them
// onto one path:
//
//   • Cloudinary if configured (CLOUDINARY_URL or the three CLOUDINARY_*
//     vars) — private 'authenticated' delivery; returns the secure URL.
//   • Local disk under env.uploadDir otherwise — returns a path
//     relative to env.uploadDir so the read side can `path.join`
//     and serve it without needing to know which sink was used.
//
// Durable-storage policy (P1 #2): in production the local-disk sink is
// refused (503 STORAGE_NOT_DURABLE) unless ALLOW_LOCAL_UPLOADS=true, because
// a web dyno's disk is ephemeral and per-instance. Configure object storage
// for any real deployment.
//
// Errors from either sink propagate; the route decides how to surface
// them (a 502 is the obvious default).

import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { recordUpload, folderType } from '../observability/businessMetrics.js';

let _cloudinary = null;

/**
 * True when a durable remote store (Cloudinary) is configured — either via the
 * single CLOUDINARY_URL the SDK reads, or the three discrete CLOUDINARY_*
 * variables documented in .env.example. (Previously only CLOUDINARY_URL was
 * honoured, so the documented three-var form silently fell back to local disk.)
 */
export function remoteStorageConfigured() {
  if (process.env.CLOUDINARY_URL) return true;
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME
    && process.env.CLOUDINARY_API_KEY
    && process.env.CLOUDINARY_API_SECRET,
  );
}

async function getCloudinary() {
  if (_cloudinary) return _cloudinary;
  if (!remoteStorageConfigured()) return null;
  const mod = await import('cloudinary');
  _cloudinary = mod.v2;
  if (process.env.CLOUDINARY_URL) {
    _cloudinary.config({ secure: true }); // SDK reads CLOUDINARY_URL from env
  } else {
    _cloudinary.config({
      secure: true,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }
  return _cloudinary;
}

// Test seam: lets the unit tests reset the cached client between cases.
export function _resetCloudinaryForTests() {
  _cloudinary = null;
}

/** Explicit opt-in to ephemeral local-disk uploads in production. */
export function localUploadsAllowed() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.ALLOW_LOCAL_UPLOADS || '').toLowerCase());
}

// Durable-storage policy (P1): production must use durable, private object
// storage for uploads — local disk on a web dyno is ephemeral (lost on every
// deploy/restart) and not shared across instances. We fail closed: if no remote
// store is configured in production, refuse to write to local disk unless the
// operator has explicitly accepted the trade-off with ALLOW_LOCAL_UPLOADS=true.
function assertLocalStorageAllowed() {
  if (env.isProduction && !localUploadsAllowed()) {
    const err = new Error(
      'Durable object storage is required in production. Configure Cloudinary '
      + '(CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET), or set '
      + 'ALLOW_LOCAL_UPLOADS=true to explicitly accept ephemeral local-disk storage.',
    );
    err.status = 503;
    err.code = 'STORAGE_NOT_DURABLE';
    throw err;
  }
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
  const sink = cld ? 'cloudinary' : 'disk';
  // Record outcome for the upload-failures dashboard. A failure from either
  // sink propagates to the route (typically surfaced as 502).
  try {
    let stored;
    if (cld) {
      stored = await new Promise((resolve, reject) => cld.uploader.upload_stream(
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
    } else {
      // Refuse ephemeral local disk as the production default (P1 #2).
      assertLocalStorageAllowed();
      const absDir = path.resolve(env.uploadDir, folder);
      await fs.mkdir(absDir, { recursive: true });
      const absPath = path.resolve(env.uploadDir, relPath);
      await fs.writeFile(absPath, file.buffer);
      stored = relPath;
    }
    recordUpload({ folderType: folderType(folder), sink, outcome: 'success' });
    return stored;
  } catch (err) {
    recordUpload({ folderType: folderType(folder), sink, outcome: 'error' });
    throw err;
  }
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

// The only remote host we ever fetch stored assets from. Cloudinary secure_urls
// are always https://res.cloudinary.com/... (see publicIdFromRemoteUrl). Keeping
// the fetch pinned to this host is what makes stored-URL reads SSRF-safe: an
// attacker who plants an arbitrary URL (e.g. http://169.254.169.254/...) in a
// document row can never cause an outbound request off this allowlist.
const REMOTE_ASSET_HOST = 'res.cloudinary.com';

/**
 * True only for URLs we are willing to fetch server-side: https to the
 * Cloudinary asset host. Everything else (other hosts, http, private IPs,
 * anything user-controlled) is rejected — the caller must fall back to a
 * disk read or refuse.
 */
export function isFetchableRemoteAssetUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  return u.protocol === 'https:' && u.hostname.toLowerCase() === REMOTE_ASSET_HOST;
}

/**
 * SSRF-safe fetch of a stored remote asset. Refuses any URL that isn't https to
 * the Cloudinary asset host, disables redirects (so an allowlisted URL can't
 * bounce to an internal address), applies a timeout, and caps the response size.
 *
 * @param {string} url            the stored secure_url to fetch.
 * @param {{ timeoutMs?: number, maxBytes?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function fetchRemoteAsset(url, { timeoutMs = 15_000, maxBytes = 50 * 1024 * 1024 } = {}) {
  if (!isFetchableRemoteAssetUrl(url)) {
    throw new Error('refusing to fetch non-allowlisted remote asset URL');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: 'error', signal: controller.signal });
    if (!r.ok) throw new Error(`failed to fetch remote asset: ${r.status}`);
    const declared = Number(r.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error('remote asset exceeds size limit');
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('remote asset exceeds size limit');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}
