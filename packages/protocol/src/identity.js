import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { hex, sha256 } from './bytes.js';
import { ed25519PrivateKey, ed25519PublicKey, rawPrivate, rawPublic } from './crypto/keys.js';

/** The device id is derived from the public key, so a device cannot claim someone else's id. */
export const deviceIdOf = (publicKey) => hex(sha256(publicKey)).slice(0, 32);

/**
 * A device's Ed25519 signing key. On a real phone this lives in secure hardware and never
 * leaves it; here it lives in memory, which is one of the limits recorded in the threat model.
 */
export class DeviceIdentity {
  #privateKey;

  constructor(privateKey) {
    this.#privateKey = privateKey;
    this.publicKey = rawPublic(privateKey);
    this.deviceId = deviceIdOf(this.publicKey);
    Object.freeze(this);
  }

  static generate() {
    return new DeviceIdentity(generateKeyPairSync('ed25519').privateKey);
  }

  static fromSeed(seed) {
    return new DeviceIdentity(ed25519PrivateKey(seed));
  }

  /** The 32-byte seed, for persisting this identity. */
  seed() {
    return rawPrivate(this.#privateKey);
  }

  sign(message) {
    return new Uint8Array(sign(null, message, this.#privateKey));
  }
}

/** Ed25519 verification. False for any malformed key or signature, never an exception. */
export function verifySignature(publicKey, message, signature) {
  if (signature.length !== 64) return false;
  try {
    return verify(null, message, ed25519PublicKey(publicKey), signature);
  } catch {
    return false;
  }
}
