import { DeviceIdentity, ServerKeyRing, b64, hpke, unb64 } from '@lifafa/protocol';

/**
 * The service's keys, loaded from the database or created on first start.
 *
 * The reference implementation generated a fresh key on every boot, which quietly made every
 * envelope already in the mesh unreadable. Keys are persisted here, and rotation adds a key
 * rather than replacing one, so envelopes sealed to an older key still open.
 */

const RECEIPT_KEY = 'receipt-signing';

export async function loadOrCreateKeys(pool) {
  const keyRing = await loadKeyRing(pool);
  const serviceIdentity = await loadReceiptIdentity(pool);
  return { keyRing, serviceIdentity };
}

async function loadKeyRing(pool) {
  const { rows } = await pool.query('SELECT key_id, private_key FROM server_keys WHERE retired_at IS NULL ORDER BY key_id');
  if (rows.length === 0) {
    const { privateKey } = hpke.generateKeyPair();
    await pool.query('INSERT INTO server_keys (key_id, private_key) VALUES (1, $1)', [b64(privateKey)]);
    return ServerKeyRing.fromPrivateKeys([{ keyId: 1, privateKey }], 1);
  }
  const keys = rows.map((row) => ({ keyId: row.key_id, privateKey: unb64(row.private_key) }));
  // The newest key is the one new envelopes should be sealed to.
  return ServerKeyRing.fromPrivateKeys(keys, Math.max(...keys.map((key) => key.keyId)));
}

async function loadReceiptIdentity(pool) {
  const { rows } = await pool.query('SELECT seed FROM service_keys WHERE name = $1', [RECEIPT_KEY]);
  if (rows.length > 0) return DeviceIdentity.fromSeed(unb64(rows[0].seed));

  const identity = DeviceIdentity.generate();
  await pool.query('INSERT INTO service_keys (name, seed) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [
    RECEIPT_KEY,
    b64(identity.seed()),
  ]);
  // Another instance may have won the race; whoever is stored wins, so both agree.
  return loadReceiptIdentity(pool);
}

/** Adds a new current key. Old keys stay, so nothing already in the mesh is stranded. */
export async function rotate(pool) {
  const { rows } = await pool.query('SELECT COALESCE(MAX(key_id), 0) + 1 AS next FROM server_keys');
  const keyId = rows[0].next;
  const { privateKey } = hpke.generateKeyPair();
  await pool.query('INSERT INTO server_keys (key_id, private_key) VALUES ($1, $2)', [keyId, b64(privateKey)]);
  return loadKeyRing(pool);
}
