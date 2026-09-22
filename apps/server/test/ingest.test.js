import { randomUUID } from 'node:crypto';
import {
  DeviceIdentity,
  ServerKeyRing,
  encodeEnvelope,
  paymentInstruction,
  seal,
  sealSigned,
  signInstruction,
  verifyReceipt,
  decodeReceipt,
  unb64,
} from '@lifafa/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { find as findClaim } from '../src/claims.js';
import { withTransaction } from '../src/db/pool.js';
import { CLOCK_SKEW_MS, MAX_PACKET_AGE_MS, ingest } from '../src/ingest.js';
import { balance, checkInvariants, fund, openAccount } from '../src/ledger.js';
import * as receipts from '../src/receipts.js';
import { findDevice, registerDevice, topUpAllowance } from '../src/registry.js';
import { startTestDatabase } from './support/database.js';

const KEY_ID = 1;
const HOUR = 60 * 60 * 1000;

let database;
let pool;
let keyRing;
let serviceIdentity;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  keyRing = ServerKeyRing.generate(KEY_ID);
  serviceIdentity = DeviceIdentity.generate();
}, 120_000);

afterAll(async () => {
  const report = await checkInvariants(pool);
  await database.stop();
  expect(report.holds, JSON.stringify(report)).toBe(true);
});

let alice;
let bob;
let phone;
let now;

beforeEach(async () => {
  const suffix = randomUUID().slice(0, 8);
  alice = `alice${suffix}@lifafa`;
  bob = `bob${suffix}@lifafa`;
  phone = DeviceIdentity.generate();
  now = Date.now();

  await withTransaction(pool, async (client) => {
    await openAccount(client, { vpa: alice, holderName: 'Alice' });
    await openAccount(client, { vpa: bob, holderName: 'Bob' });
    await fund(client, { idempotencyKey: `topup/${alice}`, vpa: alice, amountPaise: 100_000 });
    await registerDevice(client, { vpa: alice, publicKey: phone.publicKey });
  });
});

const instructionFor = (overrides = {}) =>
  paymentInstruction({
    senderVpa: alice,
    receiverVpa: bob,
    amountPaise: 25_000,
    nonce: randomUUID(),
    deviceSequence: 1,
    signedAt: now,
    expiresAt: now + 6 * HOUR,
    ...overrides,
  });

const envelopeFor = (instruction, device = phone) =>
  encodeEnvelope(seal(instruction, device, keyRing.current().publicKey, KEY_ID));

const deliver = (wire, options = {}) =>
  ingest(pool, { wire, keyRing, serviceIdentity, now, bridgeNodeId: 'bridge-test', ...options });

describe('a payment that should settle', () => {
  it('settles once, moves the money, and tells the bridge to stop carrying it', async () => {
    const result = await deliver(envelopeFor(instructionFor()));

    expect(result.outcome).toBe('SETTLED');
    expect(result.bridgeShouldRetain).toBe(false);
    expect(await balance(pool, alice)).toBe(75_000);
    expect(await balance(pool, bob)).toBe(25_000);
  });

  it('spends the device allowance, so the offline exposure shrinks as payments settle', async () => {
    await deliver(envelopeFor(instructionFor()));

    const device = await findDevice(pool, phone.deviceId);
    expect(device.allowance_paise).toBe(200_000 - 25_000);
  });

  it('issues a receipt the payer can verify against the service key', async () => {
    const result = await deliver(envelopeFor(instructionFor()));
    const stored = await receipts.find(pool, result.idempotencyKey);

    const receipt = decodeReceipt(unb64(stored.receipt_bytes));
    expect(receipt.outcome).toBe('SETTLED');
    expect(verifyReceipt(serviceIdentity.publicKey, { receipt, signature: unb64(stored.signature) })).toBe(true);
  });
});

describe('problem 2: many deliveries of one payment', () => {
  it('the same envelope delivered twice settles once and replays the decision', async () => {
    const wire = envelopeFor(instructionFor());

    const first = await deliver(wire);
    const second = await deliver(wire);

    expect(first.outcome).toBe('SETTLED');
    expect(second.outcome).toBe('SETTLED');
    expect(second.replay).toBe(true);
    expect(second.journalEntryId).toBe(first.journalEntryId);
    expect(await balance(pool, bob)).toBe(25_000);
  });

  it('a re-sealed payment is the same payment, even though every byte differs', async () => {
    const signed = signInstruction(phone, instructionFor());
    const first = encodeEnvelope(sealSigned(signed, keyRing.current().publicKey, KEY_ID));
    const second = encodeEnvelope(sealSigned(signed, keyRing.current().publicKey, KEY_ID));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);

    await deliver(first);
    const replayed = await deliver(second);

    expect(replayed.outcome).toBe('SETTLED');
    expect(replayed.replay).toBe(true);
    expect(await balance(pool, bob)).toBe(25_000);
  });

  it('eight bridges delivering at the same moment move the money once', async () => {
    const wire = envelopeFor(instructionFor());

    const results = await Promise.all(Array.from({ length: 8 }, () => deliver(wire)));

    const settled = results.filter((result) => result.outcome === 'SETTLED');
    const inProgress = results.filter((result) => result.outcome === 'IN_PROGRESS');
    expect(settled.length + inProgress.length).toBe(8);
    expect(settled.filter((result) => !result.replay)).toHaveLength(1);
    expect(inProgress.every((result) => result.bridgeShouldRetain)).toBe(true);
    expect(await balance(pool, bob)).toBe(25_000);
  }, 30_000);
});

describe('problem 3: a stored envelope, used later', () => {
  it('an envelope past the payer\'s expiry is refused', async () => {
    const wire = envelopeFor(instructionFor({ expiresAt: now + HOUR }));

    const result = await deliver(wire, { now: now + 2 * HOUR });

    expect(result.outcome).toBe('REJECTED');
    expect(result.code).toBe('STALE_OR_FUTURE_DATED');
    expect(await balance(pool, bob)).toBe(0);
  });

  it('an envelope older than the maximum packet age is refused even if the payer allowed longer', async () => {
    const wire = envelopeFor(instructionFor({ expiresAt: now + 30 * 24 * HOUR }));

    const result = await deliver(wire, { now: now + MAX_PACKET_AGE_MS + 1000 });

    expect(result.outcome).toBe('REJECTED');
    expect(result.code).toBe('STALE_OR_FUTURE_DATED');
  });

  it('a future-dated envelope is refused beyond the clock-skew allowance', async () => {
    const wire = envelopeFor(instructionFor({ signedAt: now + CLOCK_SKEW_MS + 60_000, expiresAt: now + 6 * HOUR }));

    expect((await deliver(wire)).code).toBe('STALE_OR_FUTURE_DATED');
  });

  it('a refusal is final: re-delivering replays it rather than deciding again', async () => {
    const wire = envelopeFor(instructionFor({ expiresAt: now + HOUR }));
    await deliver(wire, { now: now + 2 * HOUR });

    const again = await deliver(wire, { now: now + 2 * HOUR });
    expect(again.outcome).toBe('REJECTED');
    expect(again.replay).toBe(true);
    expect(again.bridgeShouldRetain).toBe(false);
  });
});

describe('authorisation', () => {
  it('refuses a device that was never registered', async () => {
    const stranger = DeviceIdentity.generate();
    const result = await deliver(envelopeFor(instructionFor(), stranger));

    expect(result.code).toBe('DEVICE_NOT_REGISTERED');
    expect(await balance(pool, bob)).toBe(0);
  });

  it('refuses a registered device paying from an account it is not bound to', async () => {
    const other = `carol${randomUUID().slice(0, 8)}@lifafa`;
    await withTransaction(pool, async (client) => {
      await openAccount(client, { vpa: other, holderName: 'Carol' });
      await fund(client, { idempotencyKey: `topup/${other}`, vpa: other, amountPaise: 50_000 });
    });

    const result = await deliver(envelopeFor(instructionFor({ senderVpa: other })));

    expect(result.code).toBe('DEVICE_NOT_BOUND_TO_VPA');
    expect(await balance(pool, other)).toBe(50_000);
  });

  it('refuses an envelope that cannot be opened, without taking a claim', async () => {
    const wire = envelopeFor(instructionFor());
    wire[wire.length - 1] ^= 0x01;

    const result = await deliver(wire);

    expect(result.outcome).toBe('INVALID');
    expect(result.code).toBe('DECRYPT_FAILED');
    expect(result.bridgeShouldRetain).toBe(false);
  });

  it('garbage never consumes a payment intent', async () => {
    const instruction = instructionFor();
    const garbage = Buffer.from('this is not an envelope');

    expect((await deliver(garbage)).outcome).toBe('INVALID');
    // The real payment with that nonce still settles afterwards.
    expect((await deliver(envelopeFor(instruction))).outcome).toBe('SETTLED');
  });
});

describe('bounded offline risk', () => {
  it('refuses a single payment over the per-payment cap', async () => {
    const result = await deliver(envelopeFor(instructionFor({ amountPaise: 60_000 })));

    expect(result.code).toBe('OFFLINE_LIMIT_EXCEEDED');
    expect(await balance(pool, bob)).toBe(0);
  });

  it('stops spending once the allowance runs out, whatever the balance says', async () => {
    await withTransaction(pool, async (client) => {
      await fund(client, { idempotencyKey: `topup2/${alice}`, vpa: alice, amountPaise: 900_000 });
    });

    let settled = 0;
    for (let sequence = 1; sequence <= 6; sequence++) {
      const result = await deliver(envelopeFor(instructionFor({ amountPaise: 50_000, deviceSequence: sequence })));
      if (result.outcome === 'SETTLED') settled++;
    }

    // ₹2,000 of allowance at ₹500 a payment: four settle, the rest are refused.
    expect(settled).toBe(4);
    expect(await balance(pool, bob)).toBe(200_000);
    expect(await balance(pool, alice)).toBe(800_000);
  }, 30_000);

  it('an operator top-up restores the allowance', async () => {
    // Enough balance that the allowance, not the balance, is what runs out.
    await withTransaction(pool, (client) =>
      fund(client, { idempotencyKey: `topup3/${alice}`, vpa: alice, amountPaise: 900_000 }),
    );

    for (let sequence = 1; sequence <= 4; sequence++) {
      await deliver(envelopeFor(instructionFor({ amountPaise: 50_000, deviceSequence: sequence })));
    }
    expect((await deliver(envelopeFor(instructionFor({ amountPaise: 50_000, deviceSequence: 5 })))).code).toBe(
      'OFFLINE_LIMIT_EXCEEDED',
    );

    await withTransaction(pool, (client) => topUpAllowance(client, phone.deviceId, 100_000));

    expect((await deliver(envelopeFor(instructionFor({ amountPaise: 50_000, deviceSequence: 6 })))).outcome).toBe(
      'SETTLED',
    );
  }, 30_000);

  it('refuses a payment the account cannot fund, and the refusal is final', async () => {
    const poorSuffix = randomUUID().slice(0, 8);
    const poor = `poor${poorSuffix}@lifafa`;
    const poorPhone = DeviceIdentity.generate();
    await withTransaction(pool, async (client) => {
      await openAccount(client, { vpa: poor, holderName: 'Poor' });
      await registerDevice(client, { vpa: poor, publicKey: poorPhone.publicKey });
    });

    const result = await deliver(envelopeFor(instructionFor({ senderVpa: poor, amountPaise: 10_000 }), poorPhone));

    expect(result.code).toBe('INSUFFICIENT_FUNDS');
    expect((await findClaim(pool, result.idempotencyKey)).state).toBe('REJECTED');
  });

  it('reusing a sequence number for a different payment revokes the device', async () => {
    await deliver(envelopeFor(instructionFor({ deviceSequence: 7 })));

    // Same device, same sequence number, a different payment.
    const result = await deliver(envelopeFor(instructionFor({ deviceSequence: 7, amountPaise: 30_000 })));

    expect(result.code).toBe('SEQUENCE_REUSE');
    expect((await findDevice(pool, phone.deviceId)).state).toBe('REVOKED');

    // And the revoked device cannot pay again.
    expect((await deliver(envelopeFor(instructionFor({ deviceSequence: 8 })))).code).toBe('DEVICE_REVOKED');
  }, 30_000);
});
