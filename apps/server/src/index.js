import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createApp } from './http/app.js';
import { loadOrCreateKeys } from './keystore.js';

/** Starts the settlement service. Configuration is checked before anything else happens. */
export async function start(env = process.env) {
  const config = loadConfig(env);
  const pool = createPool();
  await migrate(pool);

  const { keyRing, serviceIdentity } = await loadOrCreateKeys(pool);
  const app = createApp({ pool, keys: { keyRing, serviceIdentity }, config });

  const server = app.listen(config.port, () => {
    const address = server.address();
    console.log(`lifafa listening on ${address.port}${config.demo ? ' (demo mode)' : ''}`);
  });

  return { app, server, pool, config };
}

if (process.argv[1]?.endsWith('index.js')) {
  await start();
}
