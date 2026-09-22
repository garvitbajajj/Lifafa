import { concat, utf8 } from './bytes.js';
import { CanonicalReader, CanonicalWriter, MalformedError } from './canonical.js';
import { deviceIdOf, verifySignature } from './identity.js';
import { decodeInstruction, encodeInstruction } from './instruction.js';

/**
 * Prefixed to everything a device signs, so a signature over a payment can never be replayed as
 * a signature over some other kind of message that happens to share its bytes.
 */
const SIGNING_DOMAIN = utf8('lifafa/instruction/1\n');

/**
 * @typedef {object} SignedInstruction
 * @property {import('./instruction.js').PaymentInstruction} instruction
 * @property {Uint8Array} devicePublicKey 32 bytes
 * @property {Uint8Array} signature       64 bytes
 */

const signingInput = (encoded) => concat(SIGNING_DOMAIN, encoded);

export function signInstruction(device, instruction) {
  return {
    instruction,
    devicePublicKey: device.publicKey,
    signature: device.sign(signingInput(encodeInstruction(instruction))),
  };
}

export const deviceIdOfSigned = (signed) => deviceIdOf(signed.devicePublicKey);

/**
 * Proves only that the holder of devicePublicKey signed this. Whether that key may pay from
 * senderVpa is a separate question the settlement service answers from its device registry.
 */
export function hasValidSignature(signed) {
  return verifySignature(signed.devicePublicKey, signingInput(encodeInstruction(signed.instruction)), signed.signature);
}

export function encodeSigned(signed) {
  return new CanonicalWriter()
    .bytes(signed.devicePublicKey)
    .bytes(signed.signature)
    .bytes(encodeInstruction(signed.instruction))
    .toBytes();
}

export function decodeSigned(bytes) {
  const reader = new CanonicalReader(bytes);
  const devicePublicKey = reader.bytes();
  const signature = reader.bytes();
  const instruction = decodeInstruction(reader.bytes());
  reader.end();
  if (devicePublicKey.length !== 32) throw new MalformedError('device public key must be 32 bytes');
  if (signature.length !== 64) throw new MalformedError('signature must be 64 bytes');
  return { instruction, devicePublicKey, signature };
}
