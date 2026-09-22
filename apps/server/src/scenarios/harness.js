import { randomUUID } from 'node:crypto';
import { DeviceAgent } from '@lifafa/mesh';
import { b64 } from '@lifafa/protocol';
import { withTransaction } from '../db/pool.js';
import { ingest } from '../ingest.js';
import { rotate } from '../keystore.js';
import { checkInvariants, fund, openAccount } from '../ledger.js';
import { registerDevice } from '../registry.js';

/**
 * What a scenario is given: a real settlement service, and the pieces needed to attack it.
 *
 * Every scenario runs against the same code paths the HTTP API uses. An attack that is only
 * described in a README is not a defence, and an attack that runs against a mock proves only
 * that the mock behaves as expected.
 */
export async function createWorld({ pool, keys, now = () => Date.now() }) {
  const suffix = randomUUID().slice(0, 8);
  const payer = `payer${suffix}@lifafa`;
  const payee = `payee${suffix}@lifafa`;

  await withTransaction(pool, async (client) => {
    await openAccount(client, { vpa: payer, holderName: 'Payer' });
    await openAccount(client, { vpa: payee, holderName: 'Payee' });
    await fund(client, { idempotencyKey: `scenario/${suffix}`, vpa: payer, amountPaise: 500_000 });
  });

  const world = {
    pool,
    keys,
    payer,
    payee,
    now,

    /** A phone bound to the payer's account, holding the service key it saw while online. */
    async phone({ vpa = payer, allowancePaise, perPaymentCapPaise } = {}) {
      const agent = new DeviceAgent({
        vpa,
        serverPublicKey: keys.keyRing.current().publicKey,
        serverKeyId: keys.keyRing.currentKeyId,
        now,
      });
      await withTransaction(pool, (client) =>
        registerDevice(client, {
          vpa,
          publicKey: agent.publicKey,
          ...(allowancePaise === undefined ? {} : { allowancePaise }),
          ...(perPaymentCapPaise === undefined ? {} : { perPaymentCapPaise }),
        }),
      );
      return agent;
    },

    /** A phone whose key the service has never seen. */
    stranger(vpa = payer) {
      return new DeviceAgent({
        vpa,
        serverPublicKey: keys.keyRing.current().publicKey,
        serverKeyId: keys.keyRing.currentKeyId,
        now,
      });
    },

    deliver(wire, options = {}) {
      return ingest(pool, {
        wire,
        keyRing: keys.keyRing,
        serviceIdentity: keys.serviceIdentity,
        now: now(),
        bridgeNodeId: 'scenario',
        ...options,
      });
    },

    async rotateKeys() {
      keys.keyRing = await rotate(pool);
      return keys.keyRing;
    },

    async balances() {
      const { rows } = await pool.query('SELECT vpa, balance_paise FROM accounts WHERE vpa = ANY($1)', [[payer, payee]]);
      return Object.fromEntries(rows.map((row) => [row.vpa, row.balance_paise]));
    },

    async devicePublicKeyBase64(agent) {
      return b64(agent.publicKey);
    },

    invariants: () => checkInvariants(pool),
  };

  return world;
}
