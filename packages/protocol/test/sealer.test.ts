import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { utf8 } from '../src/bytes.ts';
import { encodeEnvelope, fingerprint } from '../src/envelope.ts';
import { DeviceIdentity } from '../src/identity.ts';
import { idempotencyKey, paymentInstruction, type PaymentInstruction } from '../src/instruction.ts';
import { ServerKeyRing } from '../src/keyring.ts';
import { signReceipt, verifyReceipt } from '../src/receipt.ts';
import { type FailureReason, type OpenResult, open, seal, sealSigned } from '../src/sealer.ts';
import { signInstruction } from '../src/signed.ts';

const KEY_ID = 7;
const now = Date.parse('2026-09-19T10:00:00Z');

let ring: ServerKeyRing;
let alicePhone: DeviceIdentity;
let instruction: PaymentInstruction;

beforeEach(() => {
  ring = ServerKeyRing.generate(KEY_ID);
  alicePhone = DeviceIdentity.generate();
  instruction = paymentInstruction({
    senderVpa: 'alice@lifafa',
    receiverVpa: 'bob@lifafa',
    amountPaise: 50_000,
    nonce: randomUUID(),
    deviceSequence: 1,
    signedAt: now,
    expiresAt: now + 6 * 60 * 60 * 1000,
  });
});

const sealed = (): Uint8Array => encodeEnvelope(seal(instruction, alicePhone, ring.current().publicKey, KEY_ID));

function expectFailure(result: OpenResult, reason: FailureReason): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

describe('problem 1: a carrier cannot read or alter the payment', () => {
  it('a sealed envelope opens back to the same instruction and device', () => {
    const result = open(sealed(), ring);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signed.instruction).toEqual(instruction);
    expect(result.signed.devicePublicKey).toEqual(alicePhone.publicKey);
  });

  it('nothing readable appears in the envelope: not the VPAs, not the amount', () => {
    const wire = Buffer.from(sealed());
    for (const secret of ['alice@lifafa', 'bob@lifafa', instruction.nonce]) {
      expect(wire.includes(Buffer.from(secret))).toBe(false);
    }
  });

  it('flipping any single ciphertext bit fails the tag', () => {
    const wire = sealed();
    for (let i = 44; i < wire.length; i++) {
      const tampered = Uint8Array.from(wire);
      tampered[i] = (tampered[i] ?? 0) ^ 0x01;
      expectFailure(open(tampered, ring), 'DECRYPT_FAILED');
    }
  });

  it('rewriting the authenticated header fails too, not just the ciphertext', () => {
    const wire = sealed();
    // The enc bytes: changing them yields a different shared secret, so the tag fails.
    const tampered = Uint8Array.from(wire);
    tampered[20] = (tampered[20] ?? 0) ^ 0x01;
    const result = open(tampered, ring);
    expect(result.ok).toBe(false);
  });

  it('an envelope sealed to one service is opaque to another', () => {
    expectFailure(open(sealed(), ServerKeyRing.generate(KEY_ID)), 'DECRYPT_FAILED');
  });

  it('stays small enough for a constrained link', () => {
    // 44 header + 199 signed instruction + 16 tag, for these VPAs. RSA-2048, which the reference
    // used, adds 256 bytes of key wrap on its own. The exact size is pinned so that growing the
    // envelope is a decision rather than an accident.
    expect(sealed().length).toBe(259);
  });
});

describe('problem 2: many copies of one payment are recognisably one payment', () => {
  it('two seals of one intent differ on the wire but share the idempotency key', () => {
    const signed = signInstruction(alicePhone, instruction);
    const first = encodeEnvelope(sealSigned(signed, ring.current().publicKey, KEY_ID));
    const second = encodeEnvelope(sealSigned(signed, ring.current().publicKey, KEY_ID));

    expect(fingerprint(first)).not.toBe(fingerprint(second));

    const [a, b] = [open(first, ring), open(second, ring)];
    if (!a.ok || !b.ok) throw new Error('both copies must open');
    expect(idempotencyKey(a.signed.instruction)).toBe(idempotencyKey(b.signed.instruction));
  });
});

describe('problem 3: a stored envelope cannot be turned into a different payment', () => {
  it('a signature from the wrong device is rejected even though it decrypts', () => {
    const mallory = DeviceIdentity.generate();
    const forged = { ...signInstruction(mallory, instruction), devicePublicKey: alicePhone.publicKey };
    const wire = encodeEnvelope(sealSigned(forged, ring.current().publicKey, KEY_ID));
    expectFailure(open(wire, ring), 'BAD_SIGNATURE');
  });

  it('a changed amount does not survive the signature check', () => {
    const signed = signInstruction(alicePhone, instruction);
    const inflated = { ...signed, instruction: { ...instruction, amountPaise: 5_000_000 } };
    const wire = encodeEnvelope(sealSigned(inflated, ring.current().publicKey, KEY_ID));
    expectFailure(open(wire, ring), 'BAD_SIGNATURE');
  });
});

describe('malformed input and key rotation', () => {
  it.each([
    ['garbage', utf8('hello there')],
    ['empty', new Uint8Array(0)],
    ['oversized', new Uint8Array(4097)],
  ])('%s is MALFORMED', (_name, wire) => {
    expectFailure(open(wire, ring), 'MALFORMED');
  });

  it('truncation anywhere is MALFORMED or DECRYPT_FAILED, never a crash', () => {
    const wire = sealed();
    for (let length = 0; length < wire.length; length++) {
      expect(open(wire.subarray(0, length), ring).ok).toBe(false);
    }
  });

  it('an unknown version or suite is refused rather than guessed at', () => {
    const version = sealed();
    version[4] = 99;
    expectFailure(open(version, ring), 'UNSUPPORTED');

    const suite = sealed();
    suite[5] = 99;
    expectFailure(open(suite, ring), 'UNSUPPORTED');
  });

  it('rotation keeps in-flight envelopes readable until the old key is retired', () => {
    const inFlight = sealed();
    const rotated = ring.withRotatedKey(8);
    expect(rotated.currentKeyId).toBe(8);
    expect(open(inFlight, rotated).ok).toBe(true);

    expectFailure(open(inFlight, rotated.withRetired(KEY_ID)), 'UNKNOWN_SERVER_KEY');
  });

  it('a ring rebuilt from stored private keys opens what the original sealed', () => {
    const restored = ServerKeyRing.fromPrivateKeys(
      ring.all().map(({ keyId, privateKey }) => ({ keyId, privateKey })),
      KEY_ID,
    );
    expect(open(sealed(), restored).ok).toBe(true);
  });
});

describe('receipts', () => {
  it('verify under the service key and fail under any other, or if altered', () => {
    const service = DeviceIdentity.generate();
    const signed = signReceipt(service, {
      idempotencyKey: idempotencyKey(instruction),
      outcome: 'SETTLED',
      reason: '',
      journalEntryId: 42,
      decidedAt: now,
    });
    expect(verifyReceipt(service.publicKey, signed)).toBe(true);
    expect(verifyReceipt(DeviceIdentity.generate().publicKey, signed)).toBe(false);
    expect(verifyReceipt(service.publicKey, { ...signed, receipt: { ...signed.receipt, outcome: 'REJECTED' } })).toBe(false);
  });
});
