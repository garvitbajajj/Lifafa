import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scenarios } from '../src/scenarios/catalogue.js';
import { createWorld } from '../src/scenarios/harness.js';
import { loadOrCreateKeys } from '../src/keystore.js';
import { startTestDatabase } from './support/database.js';

/**
 * The same catalogue the command line runs. A defence that stops holding fails the build here,
 * rather than being discovered when someone reads the README and tries it.
 */
let database;
let pool;
let keys;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  keys = await loadOrCreateKeys(pool);
}, 120_000);

afterAll(async () => {
  await database.stop();
});

describe('named attack scenarios', () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario]))('%s', async (_name, scenario) => {
    const world = await createWorld({ pool, keys });

    const outcome = await scenario.run(world);
    const invariants = await world.invariants();

    expect(outcome.passed, `${scenario.defence} - ${outcome.detail}`).toBe(true);
    expect(invariants.holds, JSON.stringify(invariants)).toBe(true);
  }, 60_000);
});
