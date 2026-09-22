import { fingerprint, idempotencyKey as intentOf, open as openEnvelope } from '@lifafa/protocol';
import * as claims from './claims.js';
import { withTransaction } from './db/pool.js';
import { InsufficientFunds, transfer } from './ledger.js';
import * as receipts from './receipts.js';
import { authorize, consumeAllowance, limitProblem, recordSequence, revoke } from './registry.js';

/**
 * One delivery of one envelope, from opening it to deciding it.
 *
 * The order matters. Garbage is rejected before a claim is taken, so a carrier cannot burn
 * someone else's payment intent by sending rubbish. The claim is taken before anything is
 * decided, so concurrent deliveries cannot both decide. The decision and the money commit
 * together, so a crash cannot separate them.
 */

/** An envelope older than this is refused however long the mesh took. */
export const MAX_PACKET_AGE_MS = 6 * 60 * 60 * 1000;
/** Phones and servers disagree about the time; a little, not a lot. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * @returns {Promise<{outcome: 'SETTLED'|'REJECTED'|'INVALID'|'IN_PROGRESS'|'TRANSIENT',
 *                    code: string, detail: string, idempotencyKey?: string,
 *                    journalEntryId?: number, replay: boolean, bridgeShouldRetain: boolean}>}
 */
export async function ingest(pool, { wire, bridgeNodeId = '', keyRing, serviceIdentity, now = Date.now() }) {
  const envelopeFingerprint = fingerprint(wire);
  const result = await decideDelivery(pool, { wire, envelopeFingerprint, keyRing, serviceIdentity, now });

  // Auditing must never change the answer: a payment that settled, settled.
  await pool
    .query('INSERT INTO ingest_attempts (fingerprint, bridge_node_id, outcome, detail) VALUES ($1, $2, $3, $4)', [
      envelopeFingerprint,
      bridgeNodeId,
      result.outcome,
      result.detail.slice(0, 500),
    ])
    .catch(() => {});

  return result;
}

async function decideDelivery(pool, { wire, envelopeFingerprint, keyRing, serviceIdentity, now }) {
  // Fast path: these exact bytes were seen before, and that payment is already decided. Answer
  // from the claim without spending a Diffie-Hellman on it.
  const known = await knownDecision(pool, envelopeFingerprint);
  if (known) return replay(known);

  const opened = openEnvelope(wire, keyRing);
  if (!opened.ok) {
    // Nothing here can become valid on a retry, so the bridge should stop carrying it.
    return { outcome: 'INVALID', code: opened.reason, detail: opened.detail, replay: false, bridgeShouldRetain: false };
  }

  const { instruction, devicePublicKey } = opened.signed;
  const idempotencyKey = intentOf(instruction);

  await pool
    .query('INSERT INTO envelope_fingerprints (fingerprint, idempotency_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      envelopeFingerprint,
      idempotencyKey,
    ])
    .catch(() => {});

  const claim = await claims.acquire(pool, idempotencyKey);
  if (claim.status === 'ALREADY_DECIDED') return replay(claim.claim);
  if (claim.status === 'HELD_ELSEWHERE') {
    // Another delivery of this same payment is being decided right now. Keep the copy: if that
    // one fails, this one is how the payment still happens.
    return {
      outcome: 'IN_PROGRESS',
      code: 'CLAIM_HELD',
      detail: 'another delivery is deciding this payment',
      idempotencyKey,
      replay: false,
      bridgeShouldRetain: true,
    };
  }

  try {
    return await withTransaction(pool, (client) =>
      decide(client, { instruction, devicePublicKey, idempotencyKey, holder: claim.holder, serviceIdentity, now }),
    );
  } catch (error) {
    // Says nothing about the payment - a database blip, a lost connection. Give the claim back so
    // the next delivery can try at once, and tell the bridge to keep its copy.
    await claims.release(pool, idempotencyKey, claim.holder).catch(() => {});
    return {
      outcome: 'TRANSIENT',
      code: 'RETRY_LATER',
      detail: error.message,
      idempotencyKey,
      replay: false,
      bridgeShouldRetain: true,
    };
  }
}

/** Everything that decides one payment, inside one transaction. */
async function decide(client, { instruction, devicePublicKey, idempotencyKey, holder, serviceIdentity, now }) {
  const settled = async (journalEntryId) => {
    await receipts.issue(client, serviceIdentity, { idempotencyKey, outcome: 'SETTLED', journalEntryId, decidedAt: now });
    await claims.markSettled(client, idempotencyKey, holder, journalEntryId);
    return {
      outcome: 'SETTLED',
      code: 'SETTLED',
      detail: '',
      idempotencyKey,
      journalEntryId,
      replay: false,
      bridgeShouldRetain: false,
    };
  };

  const rejected = async (code, detail) => {
    await receipts.issue(client, serviceIdentity, {
      idempotencyKey,
      outcome: 'REJECTED',
      reason: `${code}: ${detail}`,
      decidedAt: now,
    });
    await claims.markRejected(client, idempotencyKey, holder, code, detail);
    // A refusal is a decision: the bridge can stop carrying this envelope.
    return { outcome: 'REJECTED', code, detail, idempotencyKey, replay: false, bridgeShouldRetain: false };
  };

  const authorization = await authorize(client, { devicePublicKey, senderVpa: instruction.senderVpa });
  if (!authorization.allowed) return rejected(authorization.code, authorization.detail);
  const envelope = authorization.envelope;

  const stale = freshnessProblem(instruction, now);
  if (stale) return rejected('STALE_OR_FUTURE_DATED', stale);

  const sequence = await recordSequence(client, envelope.deviceId, instruction.deviceSequence, idempotencyKey);
  if (sequence === 'REUSED_FOR_DIFFERENT_PAYMENT') {
    // One number, two payments: the key was copied or the app was modified. Stop the device.
    await revoke(client, envelope.deviceId, `sequence ${instruction.deviceSequence} reused for a different payment`);
    return rejected('SEQUENCE_REUSE', `device ${envelope.deviceId} reused sequence ${instruction.deviceSequence}`);
  }

  const overLimit = limitProblem(envelope, instruction.amountPaise);
  if (overLimit) return rejected('OFFLINE_LIMIT_EXCEEDED', overLimit);

  try {
    const journalEntryId = await transfer(client, {
      idempotencyKey,
      from: instruction.senderVpa,
      to: instruction.receiverVpa,
      amountPaise: instruction.amountPaise,
      memo: `device ${envelope.deviceId}`,
    });
    await consumeAllowance(client, envelope.deviceId, instruction.amountPaise);
    return await settled(journalEntryId);
  } catch (error) {
    if (error instanceof InsufficientFunds) return rejected('INSUFFICIENT_FUNDS', error.message);
    if (/no such account/.test(error.message)) return rejected('UNKNOWN_ACCOUNT', error.message);
    throw error; // transient: handled by the caller, which releases the claim
  }
}

/**
 * Two bounds apply, and the tighter one wins: the payer's own expiry, and the service's maximum
 * packet age. So an operator cannot silently extend what the payer intended, and a payer cannot
 * demand an unbounded replay window.
 */
function freshnessProblem(instruction, now) {
  if (now > instruction.expiresAt) return `the payer set this to expire at ${new Date(instruction.expiresAt).toISOString()}`;
  if (now - instruction.signedAt > MAX_PACKET_AGE_MS) return `signed ${Math.round((now - instruction.signedAt) / 60000)} minutes ago`;
  if (instruction.signedAt - now > CLOCK_SKEW_MS) return 'signed in the future';
  return null;
}

async function knownDecision(pool, envelopeFingerprint) {
  const { rows } = await pool.query(
    `SELECT c.* FROM envelope_fingerprints f
       JOIN idempotency_claims c ON c.idempotency_key = f.idempotency_key
      WHERE f.fingerprint = $1`,
    [envelopeFingerprint],
  );
  const claim = rows[0];
  return claim && claims.isDecided(claim) ? claim : undefined;
}

/** The decision that was already made, handed back to a later copy of the same payment. */
const replay = (claim) => ({
  outcome: claim.state,
  code: claim.state === 'SETTLED' ? 'SETTLED' : claim.reason_code,
  detail: claim.reason ?? '',
  idempotencyKey: claim.idempotency_key,
  journalEntryId: claim.journal_entry_id ?? undefined,
  replay: true,
  bridgeShouldRetain: false,
});
