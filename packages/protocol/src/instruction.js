import { CanonicalReader, CanonicalWriter, MalformedError } from './canonical.js';

/**
 * What the payer signs: pay this much, to this person, and here is how to recognise it later.
 *
 * Amounts are integer paise (1 rupee = 100 paise). Never floating point: 0.1 + 0.2 is not 0.3,
 * and a ledger that rounds is a ledger that leaks.
 *
 * @typedef {object} PaymentInstruction
 * @property {string} senderVpa
 * @property {string} receiverVpa
 * @property {number} amountPaise
 * @property {string} nonce          random per payment; with senderVpa it names the payment
 * @property {number} deviceSequence per-device counter; reuse for a different payment is a clone
 * @property {number} signedAt       epoch milliseconds
 * @property {number} expiresAt      epoch milliseconds; the service may impose a tighter bound
 */

/**
 * A VPA is name@handle. The pattern is strict on purpose: VPAs end up in the database, in logs
 * and on the operator dashboard, and a VPA that could carry markup or control characters is a
 * stored-XSS bug waiting for a place to happen. Reject it here, at the boundary, once.
 */
const VPA = /^[A-Za-z0-9._-]{2,48}@[A-Za-z0-9.-]{2,15}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Validates every field. Throws MalformedError, so decoding and construction fail the same way. */
export function paymentInstruction(fields) {
  const problem = (message) => {
    throw new MalformedError(message);
  };
  if (!VPA.test(fields.senderVpa)) problem('senderVpa is not a well-formed VPA');
  if (!VPA.test(fields.receiverVpa)) problem('receiverVpa is not a well-formed VPA');
  if (fields.senderVpa === fields.receiverVpa) problem('a payment must have two different parties');
  if (!Number.isSafeInteger(fields.amountPaise) || fields.amountPaise <= 0) problem('amountPaise must be a positive integer');
  if (!UUID_V4.test(fields.nonce)) problem('nonce must be a lowercase random UUID');
  if (!Number.isSafeInteger(fields.deviceSequence) || fields.deviceSequence < 1) problem('deviceSequence must be a positive integer');
  if (!Number.isSafeInteger(fields.signedAt) || fields.signedAt < 0) problem('signedAt must be epoch milliseconds');
  if (!Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= fields.signedAt) problem('expiresAt must be after signedAt');
  return Object.freeze({
    senderVpa: fields.senderVpa,
    receiverVpa: fields.receiverVpa,
    amountPaise: fields.amountPaise,
    nonce: fields.nonce,
    deviceSequence: fields.deviceSequence,
    signedAt: fields.signedAt,
    expiresAt: fields.expiresAt,
  });
}

/** Names the payment, not the packet. Every re-send and re-seal of one payment shares it. */
export const idempotencyKey = (instruction) => `${instruction.senderVpa}/${instruction.nonce}`;

export const INSTRUCTION_VERSION = 1;

export function encodeInstruction(instruction) {
  return new CanonicalWriter()
    .u8(INSTRUCTION_VERSION)
    .string(instruction.senderVpa)
    .string(instruction.receiverVpa)
    .u64(instruction.amountPaise)
    .string(instruction.nonce)
    .u64(instruction.deviceSequence)
    .u64(instruction.signedAt)
    .u64(instruction.expiresAt)
    .toBytes();
}

export function decodeInstruction(bytes) {
  const reader = new CanonicalReader(bytes);
  const version = reader.u8();
  if (version !== INSTRUCTION_VERSION) throw new MalformedError(`unsupported instruction version ${version}`);
  const instruction = paymentInstruction({
    senderVpa: reader.string(),
    receiverVpa: reader.string(),
    amountPaise: reader.u64(),
    nonce: reader.string(),
    deviceSequence: reader.u64(),
    signedAt: reader.u64(),
    expiresAt: reader.u64(),
  });
  reader.end();
  return instruction;
}
