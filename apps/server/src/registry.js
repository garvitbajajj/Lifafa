import { b64, deviceIdOf, unb64 } from '@lifafa/protocol';

/**
 * Which device may pay from which account, and how much it may spend offline.
 *
 * The protocol proves a payment was signed by the holder of some key. This decides whether that
 * key is allowed to spend from the account it names - a separate question, and the one the
 * reference implementation never asked at all.
 */

export const DEFAULT_ALLOWANCE_PAISE = 200_000; // ₹2,000
export const DEFAULT_PER_PAYMENT_CAP_PAISE = 50_000; // ₹500

/** Binds a device public key to an account, with its offline limits. */
export async function registerDevice(
  client,
  { vpa, publicKey, allowancePaise = DEFAULT_ALLOWANCE_PAISE, perPaymentCapPaise = DEFAULT_PER_PAYMENT_CAP_PAISE },
) {
  if (perPaymentCapPaise > allowancePaise) {
    throw new Error('the per-payment cap cannot exceed the allowance it is spent from');
  }
  const deviceId = deviceIdOf(publicKey);
  await client.query(
    `INSERT INTO devices (device_id, vpa, public_key) VALUES ($1, $2, $3)
     ON CONFLICT (device_id) DO UPDATE SET vpa = EXCLUDED.vpa, state = 'ACTIVE', revoked_at = NULL, revoked_reason = NULL`,
    [deviceId, vpa, b64(publicKey)],
  );
  await client.query(
    `INSERT INTO offline_envelopes (device_id, allowance_paise, per_payment_cap_paise) VALUES ($1, $2, $3)
     ON CONFLICT (device_id) DO UPDATE SET allowance_paise = EXCLUDED.allowance_paise,
                                           per_payment_cap_paise = EXCLUDED.per_payment_cap_paise,
                                           updated_at = now()`,
    [deviceId, allowancePaise, perPaymentCapPaise],
  );
  return deviceId;
}

/**
 * May this key pay from this account?
 *
 * @returns {Promise<{allowed: true, envelope: object} | {allowed: false, code: string, detail: string}>}
 */
export async function authorize(db, { devicePublicKey, senderVpa }) {
  const deviceId = deviceIdOf(devicePublicKey);
  const { rows } = await db.query(
    `SELECT d.device_id, d.vpa, d.public_key, d.state, d.revoked_reason,
            e.allowance_paise, e.per_payment_cap_paise
       FROM devices d
       LEFT JOIN offline_envelopes e ON e.device_id = d.device_id
      WHERE d.device_id = $1`,
    [deviceId],
  );
  const device = rows[0];
  const no = (code, detail) => ({ allowed: false, code, detail });

  if (!device) return no('DEVICE_NOT_REGISTERED', `device ${deviceId} is not registered`);
  if (device.state === 'REVOKED') return no('DEVICE_REVOKED', device.revoked_reason ?? 'device revoked');
  // The id is derived from the key, so a mismatch here means the stored key changed under us.
  if (b64(devicePublicKey) !== device.public_key) return no('DEVICE_KEY_MISMATCH', 'stored key differs');
  if (device.vpa !== senderVpa) return no('DEVICE_NOT_BOUND_TO_VPA', `device ${deviceId} pays from ${device.vpa}`);
  if (device.allowance_paise === null) return no('NO_OFFLINE_ENVELOPE', 'device has no offline limits');

  return {
    allowed: true,
    envelope: {
      deviceId,
      allowancePaise: device.allowance_paise,
      perPaymentCapPaise: device.per_payment_cap_paise,
    },
  };
}

/** Why an amount is not spendable offline right now, or null when it is. */
export function limitProblem(envelope, amountPaise) {
  if (amountPaise > envelope.perPaymentCapPaise) {
    return `${amountPaise} paise is over the ${envelope.perPaymentCapPaise} per-payment cap`;
  }
  if (amountPaise > envelope.allowancePaise) {
    return `${amountPaise} paise is over the ${envelope.allowancePaise} remaining offline allowance`;
  }
  return null;
}

/**
 * Spends from the device's allowance, inside the settlement transaction.
 *
 * The WHERE clause is the real check: two payments racing cannot both pass it, because the row is
 * updated conditionally rather than read, decided and written back.
 */
export async function consumeAllowance(client, deviceId, amountPaise) {
  const { rowCount } = await client.query(
    `UPDATE offline_envelopes SET allowance_paise = allowance_paise - $2, updated_at = now()
      WHERE device_id = $1 AND allowance_paise >= $2`,
    [deviceId, amountPaise],
  );
  if (rowCount === 0) throw new Error(`device ${deviceId} no longer has ${amountPaise} paise of allowance`);
}

/** Refills the allowance. Only meaningful while the device is online - which is the point. */
export async function topUpAllowance(client, deviceId, amountPaise) {
  const { rows } = await client.query(
    `UPDATE offline_envelopes SET allowance_paise = allowance_paise + $2, updated_at = now()
      WHERE device_id = $1 RETURNING allowance_paise`,
    [deviceId, amountPaise],
  );
  if (rows.length === 0) throw new Error(`no such device: ${deviceId}`);
  return rows[0].allowance_paise;
}

/**
 * Records the sequence number this payment used.
 *
 * @returns {Promise<'FRESH' | 'ALREADY_SEEN_SAME_PAYMENT' | 'REUSED_FOR_DIFFERENT_PAYMENT'>}
 */
export async function recordSequence(client, deviceId, sequenceNo, idempotencyKey) {
  const { rows } = await client.query(
    `INSERT INTO device_sequences (device_id, sequence_no, idempotency_key) VALUES ($1, $2, $3)
     ON CONFLICT (device_id, sequence_no) DO NOTHING
     RETURNING sequence_no`,
    [deviceId, sequenceNo, idempotencyKey],
  );
  if (rows.length > 0) return 'FRESH';

  const { rows: existing } = await client.query(
    'SELECT idempotency_key FROM device_sequences WHERE device_id = $1 AND sequence_no = $2',
    [deviceId, sequenceNo],
  );
  return existing[0].idempotency_key === idempotencyKey ? 'ALREADY_SEEN_SAME_PAYMENT' : 'REUSED_FOR_DIFFERENT_PAYMENT';
}

export async function revoke(client, deviceId, reason) {
  await client.query(
    "UPDATE devices SET state = 'REVOKED', revoked_at = now(), revoked_reason = $2 WHERE device_id = $1",
    [deviceId, reason],
  );
}

export async function findDevice(db, deviceId) {
  const { rows } = await db.query(
    `SELECT d.*, e.allowance_paise, e.per_payment_cap_paise
       FROM devices d LEFT JOIN offline_envelopes e ON e.device_id = d.device_id
      WHERE d.device_id = $1`,
    [deviceId],
  );
  return rows[0];
}

/** The stored public key, as raw bytes. */
export const publicKeyOf = (device) => unb64(device.public_key);
