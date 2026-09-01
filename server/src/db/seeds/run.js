import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../pool.js';
import { logger } from '../../lib/logger.js';

const seedsDir = dirname(fileURLToPath(import.meta.url));
const files = ['001_roles.sql', '002_reference_data.sql', '003_ghana_reference.sql'];

(async () => {
  try {
    for (const file of files) {
      const sql = await readFile(join(seedsDir, file), 'utf8');
      logger.info('seed running', { file });
      await pool.query(sql);
      logger.info('seed complete', { file });
    }
    logger.info('seeds complete');
    await pool.end();
  } catch (err) {
    logger.error('seeds failed', { error: err?.message, stack: err?.stack });
    process.exit(1);
  }
})();
