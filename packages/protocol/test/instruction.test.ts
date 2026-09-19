import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MalformedError } from '../src/canonical.ts';
import {
  type PaymentInstruction,
  decodeInstruction,
  encodeInstruction,
  idempotencyKey,
  paymentInstruction,
} from '../src/instruction.ts';

const now = Date.parse('2026-09-19T10:00:00Z');

const valid = (overrides: Partial<PaymentInstruction> = {}): PaymentInstruction => ({
  senderVpa: 'alice@lifafa',
  receiverVpa: 'bob@lifafa',
  amountPaise: 50_000,
  nonce: randomUUID(),
  deviceSequence: 1,
  signedAt: now,
  expiresAt: now + 6 * 60 * 60 * 1000,
  ...overrides,
});

describe('PaymentInstruction', () => {
  it('encodes and decodes back to an equal instruction', () => {
    const instruction = paymentInstruction(valid());
    expect(decodeInstruction(encodeInstruction(instruction))).toEqual(instruction);
  });

  it('has exactly one encoding: the same instruction always produces the same bytes', () => {
    const instruction = paymentInstruction(valid());
    expect(encodeInstruction({ ...instruction })).toEqual(encodeInstruction(instruction));
  });

  it('names the payment by sender and nonce, independent of everything else', () => {
    const instruction = paymentInstruction(valid());
    expect(idempotencyKey(instruction)).toBe(`alice@lifafa/${instruction.nonce}`);
  });

  it.each([
    ['alice<script>@lifafa', 'markup in the name'],
    ['alice@lifafa\n', 'a trailing newline'],
    ['a@b', 'too short'],
    ['alice', 'no handle'],
    ['alice@lif afa', 'a space'],
    ['алиса@lifafa', 'non-ASCII'],
  ])('rejects the hostile VPA %j (%s)', (vpa) => {
    expect(() => paymentInstruction(valid({ senderVpa: vpa }))).toThrow(MalformedError);
    expect(() => paymentInstruction(valid({ receiverVpa: vpa }))).toThrow(MalformedError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects the amount %s', (amountPaise) => {
    expect(() => paymentInstruction(valid({ amountPaise }))).toThrow(MalformedError);
  });

  it('rejects a payment to yourself', () => {
    expect(() => paymentInstruction(valid({ receiverVpa: 'alice@lifafa' }))).toThrow(/two different parties/);
  });

  it('rejects an expiry that is not after signing', () => {
    expect(() => paymentInstruction(valid({ expiresAt: now }))).toThrow(/expiresAt/);
  });

  it('rejects a nonce that is not a random UUID', () => {
    expect(() => paymentInstruction(valid({ nonce: 'not-random' }))).toThrow(/nonce/);
  });

  it('rejects trailing bytes, so no instruction has two valid encodings', () => {
    const bytes = encodeInstruction(paymentInstruction(valid()));
    const padded = new Uint8Array([...bytes, 0]);
    expect(() => decodeInstruction(padded)).toThrow(/trailing/);
  });

  it('rejects truncation anywhere', () => {
    const bytes = encodeInstruction(paymentInstruction(valid()));
    for (let length = 0; length < bytes.length; length++) {
      expect(() => decodeInstruction(bytes.subarray(0, length))).toThrow(MalformedError);
    }
  });
});
