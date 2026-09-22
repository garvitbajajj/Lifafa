import { DeviceAgent, Mesh } from '@lifafa/mesh';
import { idempotencyKey, open } from '@lifafa/protocol';
import { acquire, find as findClaim } from '../claims.js';
import { findDevice } from '../registry.js';

const HOUR = 60 * 60 * 1000;

/**
 * Every attack and failure this design claims to survive, as something you can run.
 *
 * Each scenario says what it does and what should happen, then checks it against a real
 * settlement service. The same catalogue drives the test suite and the command line, so what a
 * reader watches in a terminal is exactly what CI enforces.
 */
export const scenarios = [
  {
    name: 'duplicate-storm',
    defence: 'eight bridges deliver one envelope at once; it settles once',
    async run(world) {
      const phone = await world.phone();
      const wire = phone.pay({ to: world.payee, amountPaise: 25_000 });

      const results = await Promise.all(Array.from({ length: 8 }, () => world.deliver(wire)));
      const balances = await world.balances();

      const decided = results.filter((result) => result.outcome === 'SETTLED' && !result.replay).length;
      const replayed = results.filter((result) => result.replay).length;
      const retry = results.filter((result) => result.outcome === 'IN_PROGRESS').length;

      return {
        passed: decided === 1 && balances[world.payee] === 25_000,
        detail: `1 decided it, ${replayed} got that decision back, ${retry} told to keep their copy; payee holds ${balances[world.payee]}`,
      };
    },
  },
  {
    name: 'reseal-retry',
    defence: 'the payer re-seals one payment into new bytes; it still settles once',
    async run(world) {
      const phone = await world.phone();
      const signed = phone.compose({ to: world.payee, amountPaise: 30_000 });

      const first = await world.deliver(phone.seal(signed));
      const second = await world.deliver(phone.seal(signed));
      const balances = await world.balances();

      return {
        passed: first.outcome === 'SETTLED' && second.replay === true && balances[world.payee] === 30_000,
        detail: `second delivery replayed the first decision; payee holds ${balances[world.payee]}`,
      };
    },
  },
  {
    name: 'forge-sender',
    defence: 'a device the service never registered cannot pay from anyone',
    async run(world) {
      const impostor = world.stranger();
      const result = await world.deliver(impostor.pay({ to: world.payee, amountPaise: 20_000 }));
      const balances = await world.balances();

      return {
        passed: result.code === 'DEVICE_NOT_REGISTERED' && balances[world.payee] === 0,
        detail: `refused as ${result.code}`,
      };
    },
  },
  {
    name: 'wrong-account',
    defence: 'a registered device cannot pay from an account it is not bound to',
    async run(world) {
      const phone = await world.phone();
      // The same device key, properly signing a payment that claims a different payer. The
      // signature is valid; the binding is not.
      const sameKeyOtherAccount = new DeviceAgent({
        identity: phone.identity,
        vpa: world.payee,
        serverPublicKey: world.keys.keyRing.current().publicKey,
        serverKeyId: world.keys.keyRing.currentKeyId,
      });

      const result = await world.deliver(sameKeyOtherAccount.pay({ to: world.payer, amountPaise: 10_000 }));
      return {
        passed: result.code === 'DEVICE_NOT_BOUND_TO_VPA',
        detail: `refused as ${result.code}: the key is bound to another account`,
      };
    },
  },
  {
    name: 'tamper-envelope',
    defence: 'a carrier that flips a bit produces an envelope that will not open',
    async run(world) {
      const phone = await world.phone();
      const wire = phone.pay({ to: world.payee, amountPaise: 15_000 });
      wire[wire.length - 3] ^= 0x02;

      const result = await world.deliver(wire);
      const balances = await world.balances();
      return {
        passed: result.outcome === 'INVALID' && balances[world.payee] === 0,
        detail: `refused as ${result.code}, and the bridge is told to drop it`,
      };
    },
  },
  {
    name: 'replay-expired',
    defence: 'an envelope kept and delivered after it expires is refused',
    async run(world) {
      const phone = await world.phone();
      const wire = phone.pay({ to: world.payee, amountPaise: 20_000, ttlMs: HOUR });

      const result = await world.deliver(wire, { now: world.now() + 3 * HOUR });
      const balances = await world.balances();
      return {
        passed: result.code === 'STALE_OR_FUTURE_DATED' && balances[world.payee] === 0,
        detail: 'refused as stale, three hours after a one-hour expiry',
      };
    },
  },
  {
    name: 'double-spend',
    defence: 'two payments signed offline from one balance: the allowance bounds the loss',
    async run(world) {
      const phone = await world.phone({ allowancePaise: 60_000, perPaymentCapPaise: 50_000 });
      const [first, second] = phone.doubleSpend({ to: world.payee, amountPaise: 50_000 });

      const a = await world.deliver(first);
      const b = await world.deliver(second);
      const balances = await world.balances();

      return {
        // The second payment reuses the sequence number for a different nonce, which is a cloned
        // key as far as the service can tell: refused, and the device is stopped.
        passed: a.outcome === 'SETTLED' && b.code === 'SEQUENCE_REUSE' && balances[world.payee] === 50_000,
        detail: `one settled, the second refused as ${b.code} and the device revoked`,
      };
    },
  },
  {
    name: 'over-cap',
    defence: 'a single offline payment above the per-payment cap is refused',
    async run(world) {
      const phone = await world.phone({ allowancePaise: 200_000, perPaymentCapPaise: 50_000 });
      const result = await world.deliver(phone.pay({ to: world.payee, amountPaise: 120_000 }));

      return {
        passed: result.code === 'OFFLINE_LIMIT_EXCEEDED',
        detail: 'refused: over the per-payment cap',
      };
    },
  },
  {
    name: 'allowance-exhausted',
    defence: 'a device cannot spend more offline than its allowance, whatever its balance',
    async run(world) {
      const phone = await world.phone({ allowancePaise: 100_000, perPaymentCapPaise: 50_000 });

      let settled = 0;
      for (let i = 0; i < 4; i++) {
        const result = await world.deliver(phone.pay({ to: world.payee, amountPaise: 50_000 }));
        if (result.outcome === 'SETTLED') settled++;
      }
      const balances = await world.balances();

      return {
        passed: settled === 2 && balances[world.payee] === 100_000,
        detail: `${settled} of 4 settled; the payer still holds ${balances[world.payer]}`,
      };
    },
  },
  {
    name: 'insufficient-funds',
    defence: 'a payment beyond the balance is refused, and the refusal is final',
    async run(world) {
      const phone = await world.phone({ allowancePaise: 900_000, perPaymentCapPaise: 900_000 });
      const wire = phone.pay({ to: world.payee, amountPaise: 700_000 });

      const first = await world.deliver(wire);
      const again = await world.deliver(wire);
      return {
        passed: first.code === 'INSUFFICIENT_FUNDS' && again.replay === true,
        detail: 'refused, and re-delivery replays the refusal rather than deciding again',
      };
    },
  },
  {
    name: 'key-rotation',
    defence: 'envelopes sealed before a key rotation still settle afterwards',
    async run(world) {
      const phone = await world.phone();
      const inFlight = phone.pay({ to: world.payee, amountPaise: 25_000 });

      const before = world.keys.keyRing.currentKeyId;
      await world.rotateKeys();
      const result = await world.deliver(inFlight);

      return {
        passed: result.outcome === 'SETTLED' && world.keys.keyRing.currentKeyId > before,
        detail: `sealed to key ${before}, settled after rotating to ${world.keys.keyRing.currentKeyId}`,
      };
    },
  },
  {
    name: 'crash-mid-settle',
    defence: 'a delivery that dies holding the claim does not strand the payment',
    async run(world) {
      const phone = await world.phone();
      const wire = phone.pay({ to: world.payee, amountPaise: 25_000 });

      // A delivery takes the claim with a lease that expires immediately: the same state a
      // process that died halfway would leave behind.
      const opened = open(wire, world.keys.keyRing);
      const key = idempotencyKey(opened.signed.instruction);
      await acquire(world.pool, key, 1);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const result = await world.deliver(wire);
      const claim = await findClaim(world.pool, key);
      const balances = await world.balances();

      return {
        passed: result.outcome === 'SETTLED' && claim.state === 'SETTLED' && balances[world.payee] === 25_000,
        detail: 'the next delivery took over the expired lease and settled it',
      };
    },
  },
  {
    name: 'mesh-journey',
    defence: 'a payment crosses a lossy, partitioned mesh and settles exactly once',
    async run(world) {
      const phone = await world.phone();
      const wire = phone.pay({ to: world.payee, amountPaise: 25_000 });

      const mesh = Mesh.chain(['phone', 'stranger-1', 'stranger-2', 'bridge-cafe', 'bridge-bus'], {
        bridges: ['bridge-cafe', 'bridge-bus'],
        dropProbability: 0.3,
        seed: 20260922,
      });
      mesh.node('phone').hold(wire);
      mesh.partition(['phone', 'stranger-1']);
      for (let round = 0; round < 5; round++) mesh.gossipRound();
      const strandedAtBridge = mesh.node('bridge-cafe').count;

      mesh.heal();
      for (let round = 0; round < 12; round++) mesh.gossipRound();

      // Both bridges upload what they carry, which is the same payment twice.
      const outcomes = [];
      await mesh.flushBridges(async (carried) => {
        const result = await world.deliver(carried);
        outcomes.push(result.outcome);
        return result;
      });
      const balances = await world.balances();

      return {
        passed: strandedAtBridge === 0 && outcomes.includes('SETTLED') && balances[world.payee] === 25_000,
        detail: `partitioned: nothing reached a bridge; healed: ${outcomes.join(', ')}; payee holds ${balances[world.payee]}`,
      };
    },
  },
  {
    name: 'revoked-device',
    defence: 'a revoked device cannot pay, even with a perfectly valid signature',
    async run(world) {
      const phone = await world.phone();
      const [first, second] = phone.doubleSpend({ to: world.payee, amountPaise: 20_000 });
      await world.deliver(first);
      await world.deliver(second); // sequence reuse revokes the device

      const after = await world.deliver(phone.pay({ to: world.payee, amountPaise: 10_000 }));
      const device = await findDevice(world.pool, phone.deviceId);

      return {
        passed: device.state === 'REVOKED' && after.code === 'DEVICE_REVOKED',
        detail: 'revoked on sequence reuse; later payments refused',
      };
    },
  },
];

export const byName = (name) => scenarios.find((scenario) => scenario.name === name);
