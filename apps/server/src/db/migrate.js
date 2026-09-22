import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, schemaName, withTransaction } from './pool.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * Applies every .sql file in migrations/ that has not run yet, in filename order, each in its own
 * transaction. A migration that fails leaves the database exactly as it was.
 */
export async function migrate(pool) {
  // The schema name is ours, not user input, but quote it anyway: one habit, no exceptions.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName()}"`);
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');

  const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));

  const ran = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(join(MIGRATIONS, name), 'utf8');
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    ran.push(name);
  }
  return ran;
}

// Run directly: node src/db/migrate.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  const ran = await migrate(pool);
  console.log(ran.length ? `applied: ${ran.join(', ')}` : 'already up to date');
  await pool.end();
}
