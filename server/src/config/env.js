import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
  runMigrationsOnBoot: toBool(values.RUN_MIGRATIONS_ON_BOOT, true),
  anthropicApiKey: values.ANTHROPIC_API_KEY || '',
  openaiApiKey: values.OPENAI_API_KEY || '',
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
