import { type Bytes, concat, utf8 } from './bytes.ts';
import { CanonicalReader, CanonicalWriter, MalformedError } from './canonical.ts';
import { type DeviceIdentity, deviceIdOf, verifySignature } from './identity.ts';
import { type PaymentInstruction, decodeInstruction, encodeInstruction } from './instruction.ts';

/**
 * Prefixed to everything a device signs, so a signature over a payment can never be replayed as
 * a signature over some other kind of message that happens to share its bytes.
 */
const SIGNING_DOMAIN = utf8('lifafa/instruction/1\n');

export interface SignedInstruction {
  readonly instruction: PaymentInstruction;
  readonly devicePublicKey: Bytes;
  readonly signature: Bytes;
}

const signingInput = (encoded: Bytes): Bytes => concat(SIGNING_DOMAIN, encoded);

export function signInstruction(device: DeviceIdentity, instruction: PaymentInstruction): SignedInstruction {
  return {
    instruction,
    devicePublicKey: device.publicKey,
    signature: device.sign(signingInput(encodeInstruction(instruction))),
  };
}

export const deviceIdOfSigned = (signed: SignedInstruction): string => deviceIdOf(signed.devicePublicKey);

/**
 * Proves only that the holder of devicePublicKey signed this. Whether that key may pay from
 * senderVpa is a separate question the settlement service answers from its device registry.
 */
export function hasValidSignature(signed: SignedInstruction): boolean {
  return verifySignature(signed.devicePublicKey, signingInput(encodeInstruction(signed.instruction)), signed.signature);
}

export function encodeSigned(signed: SignedInstruction): Bytes {
  return new CanonicalWriter()
    .bytes(signed.devicePublicKey)
    .bytes(signed.signature)
    .bytes(encodeInstruction(signed.instruction))
    .toBytes();
}

export function decodeSigned(bytes: Bytes): SignedInstruction {
  const reader = new CanonicalReader(bytes);
  const devicePublicKey = reader.bytes();
  const signature = reader.bytes();
  const instruction = decodeInstruction(reader.bytes());
  reader.end();
  if (devicePublicKey.length !== 32) throw new MalformedError('device public key must be 32 bytes');
  if (signature.length !== 64) throw new MalformedError('signature must be 64 bytes');
  return { instruction, devicePublicKey, signature };
}
