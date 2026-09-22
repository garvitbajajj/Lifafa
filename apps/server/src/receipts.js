import { b64, encodeReceipt, signReceipt } from '@lifafa/protocol';

/**
 * The service's signed answer to a payment, stored whether or not it ever reaches the payer.
 *
 * Issuing is idempotent. A receipt is written in the same transaction as the decision it
 * describes, and if that transaction is ever retried the second insert must not fail - otherwise
 * a replay turns into an error the bridge keeps retrying forever.
 */
export async function issue(client, serviceIdentity, { idempotencyKey, outcome, reason = '', journalEntryId = 0, decidedAt }) {
  const signed = signReceipt(serviceIdentity, { idempotencyKey, outcome, reason, journalEntryId, decidedAt });
  await client.query(
    `INSERT INTO receipts (idempotency_key, outcome, reason, journal_entry_id, decided_at, receipt_bytes, signature)
     VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      idempotencyKey,
      outcome,
      reason,
      journalEntryId || null,
      decidedAt,
      b64(encodeReceipt(signed.receipt)),
      b64(signed.signature),
    ],
  );
  return signed;
}

export async function find(db, idempotencyKey) {
  const { rows } = await db.query('SELECT * FROM receipts WHERE idempotency_key = $1', [idempotencyKey]);
  return rows[0];
}

export async function countUndelivered(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM receipts WHERE delivered = false');
  return rows[0].count;
}
