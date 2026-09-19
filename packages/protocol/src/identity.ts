import { type KeyObject, generateKeyPairSync, sign, verify } from 'node:crypto';
import { type Bytes, hex, sha256 } from './bytes.ts';
import { ed25519PrivateKey, ed25519PublicKey, rawPrivate, rawPublic } from './crypto/keys.ts';

/** The device id is derived from the public key, so a device cannot claim someone else's id. */
export const deviceIdOf = (publicKey: Bytes): string => hex(sha256(publicKey)).slice(0, 32);

/**
 * A device's Ed25519 signing key. On a real phone this lives in secure hardware and never
 * leaves it; here it lives in memory, which is one of the limits recorded in THREAT_MODEL.md.
 */
export class DeviceIdentity {
  readonly publicKey: Bytes;
  readonly deviceId: string;

  private constructor(private readonly privateKey: KeyObject) {
    this.publicKey = rawPublic(privateKey);
    this.deviceId = deviceIdOf(this.publicKey);
  }

  static generate(): DeviceIdentity {
    return new DeviceIdentity(generateKeyPairSync('ed25519').privateKey);
  }

  static fromSeed(seed: Bytes): DeviceIdentity {
    return new DeviceIdentity(ed25519PrivateKey(seed));
  }

  seed(): Bytes {
    return rawPrivate(this.privateKey);
  }

  sign(message: Bytes): Bytes {
    return new Uint8Array(sign(null, message, this.privateKey));
  }
}

/** Ed25519 verification. False for any malformed key or signature, never an exception. */
export function verifySignature(publicKey: Bytes, message: Bytes, signature: Bytes): boolean {
  if (signature.length !== 64) return false;
  try {
    return verify(null, message, ed25519PublicKey(publicKey), signature);
  } catch {
    return false;
  }
}
