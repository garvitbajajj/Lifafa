import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquire, find, markRejected, markSettled, release } from '../src/claims.js';
import { withTransaction } from '../src/db/pool.js';
import { balance, fund, openAccount, transfer } from '../src/ledger.js';
import { startTestDatabase } from './support/database.js';

let database;
let pool;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 120_000);

afterAll(async () => {
  await database.stop();
});

const newKey = () => `alice@lifafa/${randomUUID()}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Two funded accounts, unique per test. */
async function twoAccounts() {
  const suffix = randomUUID().slice(0, 8);
  const alice = `alice${suffix}@lifafa`;
  const bob = `bob${suffix}@lifafa`;
  await withTransaction(pool, async (client) => {
    await openAccount(client, { vpa: alice, holderName: 'Alice' });
    await openAccount(client, { vpa: bob, holderName: 'Bob' });
    await fund(client, { idempotencyKey: `topup/${alice}`, vpa: alice, amountPaise: 100_000 });
  });
  return { alice, bob };
}

describe('claiming a payment intent', () => {
  it('the first delivery takes the claim and the second is told someone else holds it', async () => {
    const key = newKey();
    expect((await acquire(pool, key)).status).toBe('ACQUIRED');
    expect((await acquire(pool, key)).status).toBe('HELD_ELSEWHERE');
  });

  it('eight deliveries arriving at once produce exactly one claim', async () => {
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 8 }, () => acquire(pool, key)));

    expect(results.filter((result) => result.status === 'ACQUIRED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'HELD_ELSEWHERE')).toHaveLength(7);
  });

  it('a decided payment answers later copies with the decision, not a bare duplicate', async () => {
    const key = newKey();
    const { holder } = await acquire(pool, key);
    await withTransaction(pool, (client) => markRejected(client, key, holder, 'INSUFFICIENT_FUNDS', 'balance 0'));

    const result = await acquire(pool, key);
    expect(result.status).toBe('ALREADY_DECIDED');
    expect(result.claim.state).toBe('REJECTED');
    expect(result.claim.reason_code).toBe('INSUFFICIENT_FUNDS');
    expect(result.claim.reason).toBe('balance 0');
  });

  it('a crash mid-settlement is recovered by the next delivery once the lease expires', async () => {
    const key = newKey();
    // A one-millisecond lease stands in for a process that died holding a normal one.
    expect((await acquire(pool, key, 1)).status).toBe('ACQUIRED');
    await pause(20);

    expect((await acquire(pool, key, 30_000)).status).toBe('ACQUIRED');
  });

  it('a live lease is not taken over', async () => {
    const key = newKey();
    await acquire(pool, key, 30_000);
    expect((await acquire(pool, key, 30_000)).status).toBe('HELD_ELSEWHERE');
  });

  it('releasing after a transient failure lets the next delivery try straight away', async () => {
    const key = newKey();
    const { holder } = await acquire(pool, key);
    await release(pool, key, holder);

    expect((await acquire(pool, key)).status).toBe('ACQUIRED');
    expect((await find(pool, key)).state).toBe('IN_PROGRESS');
  });

  it('releasing a decided claim does nothing: a decision is final', async () => {
    const key = newKey();
    const { holder } = await acquire(pool, key);
    await withTransaction(pool, (client) => markRejected(client, key, holder, 'UNKNOWN_PAYEE', 'no such account'));

    await release(pool, key, holder);
    expect((await find(pool, key)).state).toBe('REJECTED');
  });

  it('a delivery whose lease was taken over can no longer decide the payment', async () => {
    const { alice, bob } = await twoAccounts();
    const key = `${alice}/${randomUUID()}`;

    const stalled = await acquire(pool, key, 1);
    await pause(20);
    const tookOver = await acquire(pool, key, 30_000);
    expect(tookOver.status).toBe('ACQUIRED');

    // The stalled delivery comes back to life and tries to record its own decision.
    await expect(
      withTransaction(pool, async (client) => {
        const entryId = await transfer(client, { idempotencyKey: key, from: alice, to: bob, amountPaise: 10_000 });
        await markSettled(client, key, stalled.holder, entryId);
      }),
    ).rejects.toThrow(/no longer held by this caller/);

    // And nothing it did survives: the money never moved.
    expect(await balance(pool, bob)).toBe(0);
    expect((await find(pool, key)).state).toBe('IN_PROGRESS');
  });
});

describe('the decision and the money commit together', () => {
  it('settles the payment and records it in one transaction', async () => {
    const { alice, bob } = await twoAccounts();
    const key = `${alice}/${randomUUID()}`;

    const { holder } = await acquire(pool, key);
    await withTransaction(pool, async (client) => {
      const entryId = await transfer(client, { idempotencyKey: key, from: alice, to: bob, amountPaise: 30_000 });
      await markSettled(client, key, holder, entryId);
    });

    const claim = await find(pool, key);
    expect(claim.state).toBe('SETTLED');
    expect(claim.journal_entry_id).toBeTypeOf('number');
    expect(await balance(pool, bob)).toBe(30_000);
  });

  it('a failure after the postings leaves the money unmoved and the claim undecided', async () => {
    const { alice, bob } = await twoAccounts();
    const key = `${alice}/${randomUUID()}`;

    const { holder } = await acquire(pool, key);
    await expect(
      withTransaction(pool, async (client) => {
        const entryId = await transfer(client, { idempotencyKey: key, from: alice, to: bob, amountPaise: 30_000 });
        await markSettled(client, key, holder, entryId);
        throw new Error('the writer died here');
      }),
    ).rejects.toThrow('the writer died here');

    // Both were in the same transaction, so neither happened. The lease will hand this payment
    // to the next delivery that arrives.
    expect((await find(pool, key)).state).toBe('IN_PROGRESS');
    expect(await balance(pool, alice)).toBe(100_000);
    expect(await balance(pool, bob)).toBe(0);
  });
});
