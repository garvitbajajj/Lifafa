import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db/pool.js';
import { HOUSE_VPA, InsufficientFunds, balance, checkInvariants, fund, openAccount, post, transfer } from '../src/ledger.js';
import { startTestDatabase } from './support/database.js';

let database;
let pool;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 120_000);

afterAll(async () => {
  // Whatever the tests above did, the ledger must still add up. Checked once, before teardown.
  const report = await checkInvariants(pool);
  await database.stop();
  expect(report.holds, JSON.stringify(report)).toBe(true);
});

/** Fresh accounts per test, so one test's balances can never explain another's result. */
let alice;
let bob;

beforeEach(async () => {
  const suffix = randomUUID().slice(0, 8);
  alice = `alice${suffix}@lifafa`;
  bob = `bob${suffix}@lifafa`;
  await withTransaction(pool, async (client) => {
    await openAccount(client, { vpa: alice, holderName: 'Alice' });
    await openAccount(client, { vpa: bob, holderName: 'Bob' });
    await fund(client, { idempotencyKey: `topup/${alice}`, vpa: alice, amountPaise: 100_000, memo: 'opening balance' });
  });
});

describe('the ledger', () => {
  it('moves money between two accounts and leaves postings that sum to zero', async () => {
    await withTransaction(pool, (client) =>
      transfer(client, { idempotencyKey: `${alice}/${randomUUID()}`, from: alice, to: bob, amountPaise: 25_000 }),
    );

    expect(await balance(pool, alice)).toBe(75_000);
    expect(await balance(pool, bob)).toBe(25_000);
    expect((await checkInvariants(pool)).holds).toBe(true);
  });

  it('issues money from the house account, so even funding has a matching posting', async () => {
    const before = await balance(pool, HOUSE_VPA);
    await withTransaction(pool, (client) =>
      fund(client, { idempotencyKey: `topup/${bob}/1`, vpa: bob, amountPaise: 40_000 }),
    );

    expect(await balance(pool, bob)).toBe(40_000);
    expect(await balance(pool, HOUSE_VPA)).toBe(before - 40_000);
  });

  it('refuses to spend money that is not there, and changes nothing', async () => {
    await expect(
      withTransaction(pool, (client) =>
        transfer(client, { idempotencyKey: `${alice}/${randomUUID()}`, from: alice, to: bob, amountPaise: 100_001 }),
      ),
    ).rejects.toThrow(InsufficientFunds);

    expect(await balance(pool, alice)).toBe(100_000);
    expect(await balance(pool, bob)).toBe(0);
  });

  it('refuses a second entry under the same idempotency key', async () => {
    const key = `${alice}/${randomUUID()}`;
    await withTransaction(pool, (client) => transfer(client, { idempotencyKey: key, from: alice, to: bob, amountPaise: 10_000 }));

    await expect(
      withTransaction(pool, (client) => transfer(client, { idempotencyKey: key, from: alice, to: bob, amountPaise: 10_000 })),
    ).rejects.toThrow(/duplicate key|unique/i);

    expect(await balance(pool, bob)).toBe(10_000);
  });

  it('refuses postings that do not sum to zero', async () => {
    await expect(
      withTransaction(pool, (client) =>
        post(client, {
          idempotencyKey: `${alice}/${randomUUID()}`,
          kind: 'PAYMENT',
          movements: [
            { vpa: alice, amountPaise: -10_000 },
            { vpa: bob, amountPaise: 9_000 },
          ],
        }),
      ),
    ).rejects.toThrow(/sum to zero/);
  });

  it('rolls back the whole entry when anything in the transaction fails', async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await transfer(client, { idempotencyKey: `${alice}/${randomUUID()}`, from: alice, to: bob, amountPaise: 10_000 });
        throw new Error('something went wrong after the postings');
      }),
    ).rejects.toThrow('something went wrong');

    expect(await balance(pool, alice)).toBe(100_000);
    expect(await balance(pool, bob)).toBe(0);
  });

  it('cannot be raced into an overdraft by concurrent payments', async () => {
    // Twelve payments of 10,000 paise against a balance of 100,000. Ten can succeed; the rest
    // must be refused. Without the row lock in post(), each transaction would read the same
    // balance and all twelve would pass their check.
    const attempts = Array.from({ length: 12 }, () =>
      withTransaction(pool, (client) =>
        transfer(client, { idempotencyKey: `${alice}/${randomUUID()}`, from: alice, to: bob, amountPaise: 10_000 }),
      ).then(
        () => 'settled',
        () => 'refused',
      ),
    );

    const settled = (await Promise.all(attempts)).filter((outcome) => outcome === 'settled').length;

    expect(settled).toBe(10);
    expect(await balance(pool, alice)).toBe(0);
    expect(await balance(pool, bob)).toBe(100_000);
    expect((await checkInvariants(pool)).holds).toBe(true);
  }, 30_000);

  it('reports drift when a balance is edited behind the ledger', async () => {
    await pool.query('UPDATE accounts SET balance_paise = balance_paise + 1 WHERE vpa = $1', [alice]);

    const report = await checkInvariants(pool);
    expect(report.holds).toBe(false);
    expect(report.drifts.map((drift) => drift.vpa)).toContain(alice);

    await pool.query('UPDATE accounts SET balance_paise = balance_paise - 1 WHERE vpa = $1', [alice]);
    expect((await checkInvariants(pool)).holds).toBe(true);
  });
});
