import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { startLocalPostgres } from '../db/local-postgres.js';
import { createPool } from '../db/pool.js';
import { loadOrCreateKeys } from '../keystore.js';
import { byName, scenarios } from './catalogue.js';
import { createWorld } from './harness.js';

/**
 * Runs named scenarios against a real settlement service and reports what happened.
 *
 *   npm run scenarios -- list
 *   npm run scenarios -- all
 *   npm run scenarios -- duplicate-storm double-spend
 *
 * Exits non-zero if any defence did not hold, so this can gate a build.
 */
export async function runScenarios(names, { pool, keys, out = console }) {
  const chosen = names.includes('all') ? scenarios : names.map((name) => must(byName(name), name));
  const results = [];

  for (const scenario of chosen) {
    const world = await createWorld({ pool, keys });
    let outcome;
    try {
      outcome = await scenario.run(world);
    } catch (error) {
      outcome = { passed: false, detail: `threw: ${error.message}` };
    }
    // The ledger must still balance after every attack, whatever the attack was.
    const invariants = await world.invariants();
    if (!invariants.holds) {
      outcome = { passed: false, detail: `${outcome.detail}; LEDGER DRIFTED: ${JSON.stringify(invariants)}` };
    }

    results.push({ name: scenario.name, ...outcome });
    out.log(`${outcome.passed ? 'ok  ' : 'FAIL'}  ${scenario.name.padEnd(22)} ${outcome.detail}`);
  }

  const failed = results.filter((result) => !result.passed);
  out.log(`\n${results.length - failed.length} of ${results.length} defences held.`);
  return { results, failed };
}

function must(scenario, name) {
  if (!scenario) throw new Error(`unknown scenario '${name}'; try 'list'`);
  return scenario;
}

function list() {
  console.log('Scenarios:\n');
  for (const scenario of scenarios) console.log(`  ${scenario.name.padEnd(22)} ${scenario.defence}`);
  console.log("\nRun one or more by name, or 'all'.");
}

if (process.argv[1]?.endsWith('run.js')) {
  const names = process.argv.slice(2);
  if (names.length === 0 || names.includes('list')) {
    list();
  } else {
    loadConfig({ LIFAFA_DEMO: 'true' });
    // With no DATABASE_URL, run against a throwaway database so this works on a fresh clone.
    const local = process.env.DATABASE_URL ? null : await startLocalPostgres();
    const pool = createPool(process.env.DATABASE_URL ?? local.connectionString);
    await migrate(pool);

    const keys = await loadOrCreateKeys(pool);
    const { failed } = await runScenarios(names, { pool, keys });

    await pool.end();
    if (local) await local.stop();
    if (failed.length > 0) process.exitCode = 1;
  }
}
