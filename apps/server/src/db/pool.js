import pg from 'pg';

// BIGINT arrives as a string, because it can hold values JavaScript cannot. Every BIGINT here is
// paise or a row id, both far inside the safe range, so they are parsed to numbers once, centrally
// - and anything that somehow is not safe throws rather than silently losing precision.
// Without this, "50000" + 25000 is "5000025000".
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`BIGINT ${value} is outside the safe integer range`);
  return parsed;
});

/**
 * Lifafa keeps its tables in their own schema, so it can share a database with anything else
 * without colliding - and on Supabase, a schema that is not exposed is not reachable from the
 * auto-generated API either.
 */
export const schemaName = () => process.env.DB_SCHEMA ?? 'lifafa';

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schemaName()}` });

  // An idle connection the database drops - a restart, a failover, Supabase recycling it - emits
  // 'error'. With no listener, Node treats that as an uncaught exception and kills the process:
  // one database restart would take the whole service down. The pool discards the dead
  // connection and opens a new one on the next query, so logging it is all that is needed.
  pool.on('error', (error) => console.error(`database connection lost: ${error.message}`));
  // A connection being closed can still receive the server's goodbye after the pool has let go of
  // it. It is on its way out anyway; the error means nothing.
  pool.on('connect', (client) => client.on('error', () => {}));

  return pool;
}

/**
 * Runs fn inside one transaction, on one connection.
 *
 * This matters more than it looks. pool.query() takes any free connection, so a BEGIN, an INSERT
 * and a COMMIT sent through the pool can land on three different connections - no transaction at
 * all, and nothing warns you. Everything that must be atomic takes the client passed here.
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
