import { randomUUID } from 'node:crypto';

/**
 * Claims on payment intents: the mechanism that makes many deliveries of one payment settle once.
 *
 * Two phases, and the split is the whole point:
 *
 *   1. acquire() writes IN_PROGRESS in its own committed transaction, so every other delivery can
 *      see it immediately.
 *   2. the caller decides the payment and calls markSettled/markRejected inside the same
 *      transaction as the ledger postings, so money moving and the decision being recorded are
 *      one atomic act.
 *
 * If the process dies between the two, the lease expires and the next delivery takes the claim
 * over. A payment is delayed, never lost and never paid twice.
 *
 * Every acquire mints a holder id, and deciding requires it. Without that, a delivery that stalled
 * past its lease could wake up after someone else took over and overwrite their decision - the
 * state alone cannot tell the two holders apart, because a taken-over claim is IN_PROGRESS again.
 */

/** How long a delivery may hold a claim before another delivery may take it over. */
export const DEFAULT_LEASE_MS = 30_000;

/**
 * Tries to take the claim.
 *
 * One statement does the work. The INSERT wins when nobody holds the claim; the ON CONFLICT
 * branch wins when a previous holder's lease has expired. Anything else conflicts and writes
 * nothing, and then we look at why.
 *
 * @returns {Promise<{status: 'ACQUIRED', holder: string}
 *                 | {status: 'ALREADY_DECIDED', claim: object}
 *                 | {status: 'HELD_ELSEWHERE'}>}
 */
export async function acquire(db, idempotencyKey, leaseMs = DEFAULT_LEASE_MS) {
  const holder = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO idempotency_claims (idempotency_key, state, holder, lease_expires_at)
     VALUES ($1, 'IN_PROGRESS', $3, now() + make_interval(secs => $2))
     ON CONFLICT (idempotency_key) DO UPDATE
        SET holder           = EXCLUDED.holder,
            lease_expires_at = EXCLUDED.lease_expires_at,
            claimed_at       = now()
      WHERE idempotency_claims.state = 'IN_PROGRESS'
        AND idempotency_claims.lease_expires_at < now()
     RETURNING holder`,
    [idempotencyKey, leaseMs / 1000, holder],
  );
  if (rows.length > 0) return { status: 'ACQUIRED', holder };

  const claim = await find(db, idempotencyKey);
  // The holder may have released it in the moment between the two statements.
  if (!claim) return { status: 'HELD_ELSEWHERE' };
  return isDecided(claim) ? { status: 'ALREADY_DECIDED', claim } : { status: 'HELD_ELSEWHERE' };
}

export const isDecided = (claim) => claim.state === 'SETTLED' || claim.state === 'REJECTED';

export async function find(db, idempotencyKey) {
  const { rows } = await db.query('SELECT * FROM idempotency_claims WHERE idempotency_key = $1', [idempotencyKey]);
  return rows[0];
}

/**
 * Records that the payment settled. Takes a client, not a pool: this must commit with the ledger
 * postings it describes, or neither should exist.
 */
export async function markSettled(client, idempotencyKey, holder, journalEntryId) {
  await updateDecision(client, idempotencyKey, holder, {
    state: 'SETTLED',
    journalEntryId,
    reasonCode: null,
    reason: null,
  });
}

/** Records that the payment was refused. A refusal is a decision, and it is just as final. */
export async function markRejected(client, idempotencyKey, holder, reasonCode, reason) {
  await updateDecision(client, idempotencyKey, holder, {
    state: 'REJECTED',
    journalEntryId: null,
    reasonCode,
    reason,
  });
}

async function updateDecision(client, idempotencyKey, holder, { state, journalEntryId, reasonCode, reason }) {
  const { rowCount } = await client.query(
    `UPDATE idempotency_claims
        SET state = $3, journal_entry_id = $4, reason_code = $5, reason = $6,
            lease_expires_at = NULL, decided_at = now()
      WHERE idempotency_key = $1
        AND holder = $2
        AND state = 'IN_PROGRESS'`,
    [idempotencyKey, holder, state, journalEntryId, reasonCode, reason ?? ''],
  );
  // Nothing updated means this delivery no longer holds the claim - its lease ran out and another
  // delivery took over. Deciding anyway would overwrite that one's decision.
  if (rowCount === 0) throw new Error(`claim ${idempotencyKey} is no longer held by this caller`);
}

/**
 * Gives the claim back after a failure that says nothing about the payment - a database blip, a
 * timeout. The next delivery can then try immediately rather than waiting out the lease.
 */
export async function release(db, idempotencyKey, holder) {
  await db.query(
    "DELETE FROM idempotency_claims WHERE idempotency_key = $1 AND holder = $2 AND state = 'IN_PROGRESS'",
    [idempotencyKey, holder],
  );
}

export async function countByState(db) {
  const { rows } = await db.query('SELECT state, COUNT(*)::int AS count FROM idempotency_claims GROUP BY state');
  return Object.fromEntries(rows.map((row) => [row.state, row.count]));
}
