import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../.env'),
];

let loadedEnvPath = null;
for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false });
    loadedEnvPath = loadedEnvPath || candidate;
  }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1).default('postgresql://postgres:postgres@localhost:5432/reinsurance_tool'),
  DASHBOARD_DATABASE_URL: z.string().optional().or(z.literal('')),
  // Shared store for distributed rate limiting across instances. When unset,
  // the rate limiters use a per-instance in-memory store (see lib/rateLimitStore.js).
  REDIS_URL: z.string().optional().or(z.literal('')),
  UPLOAD_DIR: z.string().optional(),
  CLIENT_DIST_DIR: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),
  RUN_MIGRATIONS_ON_BOOT: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  // AI/data-governance gate. Fail-closed: when AI_FEATURES_ENABLED is unset no
  // external LLM call is made. Enabling requires customer/legal approval and a
  // configured provider. AI_CUSTOMER_OPTOUT blocks all AI for the tenant.
  AI_FEATURES_ENABLED: z.string().optional(),
  AI_CUSTOMER_OPTOUT: z.string().optional(),
  AI_REDACTION_ENABLED: z.string().optional(),
  // Axco Insurance Intelligence — optional. When unset, the market
  // intelligence route falls back to a web-search-only OpenAI call.
  AXCO_API_KEY: z.string().optional(),
  AXCO_BASE_URL: z.string().url().optional(),
  // Auth/session secrets. Optional at parse time; validateEnv() enforces them
  // for production (a weak/missing secret would let anyone forge tokens).
  AUTH_JWT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const values = parsed.data;
const nodeEnv = values.NODE_ENV;

// The literal that used to be hard-coded into authToken.js — explicitly
// rejected so it can never be used as a real secret.
export const INSECURE_SECRET_PLACEHOLDER = 'dev-insecure-secret-change-me';

// Resolve the auth-token signing secret. In production a missing secret stays
// empty and validateEnv() refuses to boot. In dev/test we mint a per-process
// ephemeral secret (never a fixed literal) so local runs work but tokens don't
// survive a restart.
function resolveAuthSecret() {
  const raw = values.AUTH_JWT_SECRET;
  if (raw && raw.length) return raw;
  if (nodeEnv === 'production') return '';
  const ephemeral = randomBytes(32).toString('hex');
  console.warn('[env] AUTH_JWT_SECRET not set — using a per-process ephemeral secret; tokens will not survive a restart.');
  return ephemeral;
}
const authJwtSecret = resolveAuthSecret();

const rootDir = path.resolve(__dirname, '../../..');
const defaultUploadDir = path.resolve(rootDir, 'uploads');
const defaultClientDistDir = path.resolve(rootDir, 'client/dist');

export const env = Object.freeze({
  loadedEnvPath,
  rootDir,
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: values.PORT,
  databaseUrl: values.DATABASE_URL,
  dashboardDatabaseUrl: values.DASHBOARD_DATABASE_URL || '',
  redisUrl: values.REDIS_URL || '',
  uploadDir: values.UPLOAD_DIR ? path.resolve(rootDir, values.UPLOAD_DIR) : defaultUploadDir,
  clientDistDir: values.CLIENT_DIST_DIR ? path.resolve(rootDir, values.CLIENT_DIST_DIR) : defaultClientDistDir,
  clientSourceDir: path.resolve(rootDir, 'client'),
  corsOrigin: values.CORS_ORIGIN,
  // Default to OFF: a bad migration on boot can take the whole API
  // down. Run `npm run migrate:up` as an explicit pre-deploy step
  // (see render.yaml, DEPLOYMENT.md). docker-compose sets this to
  // true for the convenience of the local dev path.
  runMigrationsOnBoot: toBool(values.RUN_MIGRATIONS_ON_BOOT, false),
  anthropicApiKey: values.ANTHROPIC_API_KEY || '',
  openaiApiKey: values.OPENAI_API_KEY || '',
  geminiApiKey: values.GEMINI_API_KEY || '',
  // AI governance. The gate defaults ON in every environment, production
  // included, so the AI features work without per-environment setup. This is
  // an explicit product decision: AI calls send treaty and document content to
  // an external provider, so the deployment owner is responsible for the
  // customer/legal approval and the no-retention provider route that
  // lib/aiGovernance.js documents. Set AI_FEATURES_ENABLED=false (or
  // AI_CUSTOMER_OPTOUT=true for a tenant) to close the gate again.
  // A provider key is still required: with none configured the gate raises
  // AI_NOT_CONFIGURED rather than attempting a call.
  aiFeaturesEnabled: toBool(values.AI_FEATURES_ENABLED, true),
  aiCustomerOptOut: toBool(values.AI_CUSTOMER_OPTOUT, false),
  aiRedactionEnabled: toBool(values.AI_REDACTION_ENABLED, true),
  axcoApiKey: values.AXCO_API_KEY || '',
  axcoBaseUrl: values.AXCO_BASE_URL || '',
  authJwtSecret,
  sessionSecret: values.SESSION_SECRET || '',
});

export function validateRuntimeEnv() {
  const missing = [];
  if (!env.databaseUrl) missing.push('DATABASE_URL');
  if (!env.port) missing.push('PORT');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return env;
}

const MIN_SECRET_LEN = 32;

// A secret is a "placeholder" if it's the old hard-coded literal OR matches the
// CHANGE_ME* templates shipped in .env.example. The .env.example value
// (CHANGE_ME_RUN_NODE_RANDOMBYTES_48_BASE64URL) is 43 chars and is NOT the
// legacy literal, so without this it would sail past the length + equality
// checks — meaning `cp .env.example .env` could boot production with a signing
// key that is public in the repo (forgeable auth tokens → full auth bypass).
function isPlaceholderSecret(value) {
  return value === INSECURE_SECRET_PLACEHOLDER || /^CHANGE_ME/i.test(value);
}

/**
 * Pure secret-strength checker (testable). Returns an array of error strings;
 * empty means OK. Secrets are only enforced in production. SESSION_SECRET is
 * validated only when present (it's required only if cookies/sessions use it).
 */
export function checkSecretsConfig({ nodeEnv: ne, authJwtSecret: auth, sessionSecret: sess } = {}) {
  const errors = [];
  if (ne !== 'production') return errors;

  if (!auth) {
    errors.push('AUTH_JWT_SECRET is required in production (set it as a secret env var).');
  } else if (isPlaceholderSecret(auth)) {
    errors.push('AUTH_JWT_SECRET must not be a placeholder — generate a real secret (e.g. `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"`).');
  } else if (auth.length < MIN_SECRET_LEN) {
    errors.push(`AUTH_JWT_SECRET must be at least ${MIN_SECRET_LEN} characters.`);
  }

  if (sess) { // only enforce strength when a session secret is configured
    if (isPlaceholderSecret(sess)) {
      errors.push('SESSION_SECRET must not be a placeholder — generate a real secret.');
    } else if (sess.length < MIN_SECRET_LEN) {
      errors.push(`SESSION_SECRET must be at least ${MIN_SECRET_LEN} characters.`);
    }
  }
  return errors;
}

/**
 * Pure demo-auth fence (testable). ALLOW_DEMO_AUTH turns on the universal
 * demo-password backdoor AND the x-user-* header auth bypass (see
 * middleware/requestContext.js, routes/auth.js) — dev/test conveniences that
 * would be a full auth bypass in production. Returns an array of error strings;
 * empty means OK. Only enforced in production.
 */
export function checkDemoAuthConfig({ nodeEnv: ne, allowDemoAuth } = {}) {
  const errors = [];
  if (ne !== 'production') return errors;
  if (toBool(allowDemoAuth, false)) {
    errors.push('ALLOW_DEMO_AUTH must not be enabled in production — it activates the demo-password backdoor and header-based auth bypass. Unset it (or set it to false) before deploying.');
  }
  return errors;
}

/**
 * Fail-closed MFA enforcement (opt-in). When IDENTITY_ENFORCE_MFA is truthy the
 * operator is asserting "MFA must be enforced." We then refuse to boot on a
 * config that would NOT actually enforce it — SSO off (nothing carries the
 * assurance claims) or SSO on with no IDENTITY_REQUIRED_ACR/AMR (the acr/amr
 * check is a no-op). Unset ⇒ no-op, so existing deployments are unaffected.
 * Reads raw env (no import of the identity module) to stay dependency-free.
 */
export function checkMfaEnforcementConfig({ enforceMfa, ssoEnabled, requiredAcr, requiredAmr } = {}) {
  const errors = [];
  if (!toBool(enforceMfa, false)) return errors; // opt-in only
  if (!toBool(ssoEnabled, false)) {
    errors.push('IDENTITY_ENFORCE_MFA is set but IDENTITY_SSO_ENABLED is off — MFA is enforced via SSO acr/amr claims. Enable SSO or unset IDENTITY_ENFORCE_MFA.');
    return errors;
  }
  const hasAcr = String(requiredAcr || '').trim().length > 0;
  const hasAmr = String(requiredAmr || '').trim().length > 0;
  if (!hasAcr && !hasAmr) {
    errors.push('IDENTITY_ENFORCE_MFA is set but neither IDENTITY_REQUIRED_ACR nor IDENTITY_REQUIRED_AMR is configured — the in-app acr/amr check would be a no-op. Set the required assurance level/methods so MFA is actually enforced (fail-closed).');
  }
  return errors;
}

/**
 * Fail-fast secret validation, called at the very top of bootstrap. In
 * production an invalid/missing secret — or an enabled demo-auth backdoor — is
 * fatal: we console.error and exit(1) rather than boot with forgeable tokens or
 * an open auth bypass.
 */
export function validateEnv() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const errors = [
    ...checkSecretsConfig({
      nodeEnv,
      authJwtSecret: process.env.AUTH_JWT_SECRET || '',
      sessionSecret: process.env.SESSION_SECRET || '',
    }),
    ...checkDemoAuthConfig({ nodeEnv, allowDemoAuth: process.env.ALLOW_DEMO_AUTH }),
    ...checkMfaEnforcementConfig({
      enforceMfa: process.env.IDENTITY_ENFORCE_MFA,
      ssoEnabled: process.env.IDENTITY_SSO_ENABLED,
      requiredAcr: process.env.IDENTITY_REQUIRED_ACR,
      requiredAmr: process.env.IDENTITY_REQUIRED_AMR,
    }),
  ];
  if (errors.length) {
    console.error('[env] Refusing to start with an insecure configuration:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
  return env;
}
