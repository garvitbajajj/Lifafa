import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, schemaName } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

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

async function startLocalPostgres() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const directory = await mkdtemp(join(tmpdir(), 'lifafa-pg-'));
  // A random high port, so two test files can run at once without fighting over one.
  const port = 55000 + Math.floor(Math.random() * 5000);
  const postgres = new EmbeddedPostgres({
    databaseDir: directory,
    user: 'lifafa',
    password: 'lifafa',
    port,
    persistent: false,
  });

  await postgres.initialise();
  await postgres.start();
  return {
    connectionString: `postgresql://lifafa:lifafa@127.0.0.1:${port}/postgres`,
    async stop() {
      await postgres.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
