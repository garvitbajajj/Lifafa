import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { startLocalPostgres } from './db/local-postgres.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createApp } from './http/app.js';
import { loadOrCreateKeys } from './keystore.js';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

/** Starts the settlement service. Configuration is checked before anything else happens. */
export async function start(env = process.env) {
  const config = loadConfig(env);

  // A demo with no database of its own starts one, so the whole thing is a single command on a
  // fresh clone. Anything real sets DATABASE_URL.
  const local = env.DATABASE_URL ? null : config.demo ? await startLocalPostgres() : null;
  const pool = createPool(env.DATABASE_URL ?? local?.connectionString);
  await migrate(pool);

  const { keyRing, serviceIdentity } = await loadOrCreateKeys(pool);
  const app = createApp({ pool, keys: { keyRing, serviceIdentity }, config, webRoot: WEB_ROOT });

  const server = app.listen(config.port, () => {
    console.log(`lifafa listening on http://127.0.0.1:${server.address().port}${config.demo ? ' (demo mode)' : ''}`);
  });

  // Without this, a port already in use surfaces as "cannot read properties of null", because the
  // listening callback never runs and address() is null. Say what actually happened.
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`port ${config.port} is already in use. Set PORT to a free one, for example: PORT=3100`);
      process.exit(1);
    }
    throw error;
  });

  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    if (local) await local.stop();
  };

  return { app, server, pool, config, stop };
}

if (process.argv[1]?.endsWith('index.js')) {
  // --demo is the same as LIFAFA_DEMO=true, and works the same on every shell.
  const env = process.argv.includes('--demo') ? { ...process.env, LIFAFA_DEMO: 'true' } : process.env;
  const { stop } = await start(env);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => stop().then(() => process.exit(0)));
  }
}
