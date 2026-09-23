import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A throwaway PostgreSQL for development and tests, so neither needs a database installed or a
 * container running. Real deployments set DATABASE_URL and never come here.
 */
export async function startLocalPostgres() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const directory = await mkdtemp(join(tmpdir(), 'lifafa-pg-'));
  const port = await freePort();

  const postgres = new EmbeddedPostgres({
    databaseDir: directory,
    user: 'lifafa',
    password: 'lifafa',
    port,
    // Keep the library from deleting the folder itself: it does so inside stop() with no retry,
    // which on Windows fails with EBUSY while the server is still letting go of its files.
    // stop() below removes it instead, patiently.
    persistent: true,
  });

  await postgres.initialise();
  await postgres.start();

  return {
    connectionString: `postgresql://lifafa:lifafa@127.0.0.1:${port}/postgres`,
    async stop() {
      await postgres.stop();
      // On Windows the server process keeps its files open for a moment after stop() resolves, so
      // deleting the folder straight away fails with EBUSY. Retry briefly, then leave it: a stray
      // folder in the temp directory must never fail a test run.
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
    },
  };
}

/** A port the operating system says is free, so parallel runs cannot collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
