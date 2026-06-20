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
  // AI governance — fail-closed by default (AI disabled unless explicitly on).
  aiFeaturesEnabled: toBool(values.AI_FEATURES_ENABLED, false),
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
  } else if (auth === INSECURE_SECRET_PLACEHOLDER) {
    errors.push('AUTH_JWT_SECRET must not be the insecure development placeholder.');
  } else if (auth.length < MIN_SECRET_LEN) {
    errors.push(`AUTH_JWT_SECRET must be at least ${MIN_SECRET_LEN} characters.`);
  }

  if (sess) { // only enforce strength when a session secret is configured
    if (sess === INSECURE_SECRET_PLACEHOLDER) {
      errors.push('SESSION_SECRET must not be the insecure development placeholder.');
    } else if (sess.length < MIN_SECRET_LEN) {
      errors.push(`SESSION_SECRET must be at least ${MIN_SECRET_LEN} characters.`);
    }
  }
  return errors;
}

/**
 * Fail-fast secret validation, called at the very top of bootstrap. In
 * production an invalid/missing secret is fatal — we console.error and exit(1)
 * rather than boot with forgeable tokens.
 */
export function validateEnv() {
  const errors = checkSecretsConfig({
    nodeEnv: process.env.NODE_ENV || 'development',
    authJwtSecret: process.env.AUTH_JWT_SECRET || '',
    sessionSecret: process.env.SESSION_SECRET || '',
  });
  if (errors.length) {
    console.error('[env] Refusing to start with an insecure configuration:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
  return env;
}
