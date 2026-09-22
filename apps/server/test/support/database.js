import { randomBytes } from 'node:crypto';
import { startLocalPostgres } from '../../src/db/local-postgres.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool, schemaName } from '../../src/db/pool.js';

/**
 * A database to run one test file against, in a schema of its own that is dropped afterwards.
 *
 * With DATABASE_URL set it uses that database - Supabase, or any other PostgreSQL. Without one it
 * starts a throwaway PostgreSQL on this machine, so the tests run offline with nothing installed.
 */
export async function startTestDatabase() {
  process.env.DB_SCHEMA = `lifafa_test_${randomBytes(4).toString('hex')}`;

  const external = process.env.DATABASE_URL;
  const local = external ? null : await startLocalPostgres();

  const pool = createPool(external ?? local.connectionString);
  await migrate(pool);

  return {
    pool,
    async stop() {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName()}" CASCADE`).catch(() => {});
      await pool.end();
      delete process.env.DB_SCHEMA;
      if (local) await local.stop();
    },
  };
}
