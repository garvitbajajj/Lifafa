import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase } from './support/database.js';

let database;
let pool;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
});

afterAll(async () => {
  await database.stop();
});

describe('the connection pool', () => {
  it('survives the database dropping its idle connections, and keeps working', async () => {
    // Open three connections and leave them idle in the pool, remembering which backends they are.
    const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    const pids = [];
    for (const client of clients) {
      pids.push((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      client.release();
    }

    // Kill exactly those backends from outside the pool - what a database restart does to them.
    const killer = new pg.Client({ connectionString: pool.options.connectionString });
    await killer.connect();
    await killer.query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid', [pids]);
    await killer.end();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Without an error listener on the pool, the dropped connections would have raised an uncaught
    // exception - which Vitest reports, and which in production ends the process. Instead the pool
    // has discarded them and simply opens a new connection.
    const { rows } = await pool.query('SELECT 1 AS alive');
    expect(rows[0].alive).toBe(1);
  });
});
