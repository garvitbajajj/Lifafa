import { generateKeyPair } from './crypto/hpke.js';
import { rawPublic, x25519PrivateKey } from './crypto/keys.js';

/**
 * The settlement service's X25519 keys, by id.
 *
 * A ring rather than one key, because a payment can sit in the mesh for hours. Rotating means
 * adding a new current key while keeping the old ones, so envelopes sealed before the rotation
 * still open. The reference project generated a new key on every start and had no key id in its
 * format, so a restart made every payment in flight permanently unreadable.
 *
 * Immutable: rotation returns a new ring, so a ring someone is reading never changes under them.
 *
 * @typedef {object} ServerKey
 * @property {number} keyId
 * @property {Uint8Array} privateKey raw X25519 scalar; whoever holds it reads every envelope sealed to it
 * @property {Uint8Array} publicKey
 */
export class ServerKeyRing {
  #keys;

  constructor(keys, currentKeyId) {
    this.#keys = new Map([...keys].map((key) => [key.keyId, key]));
    if (!this.#keys.has(currentKeyId)) throw new Error(`current key ${currentKeyId} is not in the ring`);
    this.currentKeyId = currentKeyId;
    Object.freeze(this);
  }

  static generate(keyId) {
    return new ServerKeyRing([{ keyId, ...generateKeyPair() }], keyId);
  }

  /** Rebuilds a ring from stored private keys; public keys are derived, not trusted from storage. */
  static fromPrivateKeys(entries, currentKeyId) {
    return new ServerKeyRing(
      entries.map(({ keyId, privateKey }) => ({
        keyId,
        privateKey,
        publicKey: rawPublic(x25519PrivateKey(privateKey)),
      })),
      currentKeyId,
    );
  }

  current() {
    return this.#keys.get(this.currentKeyId);
  }

  lookup(keyId) {
    return this.#keys.get(keyId);
  }

  all() {
    return [...this.#keys.values()];
  }

  withRotatedKey(newKeyId) {
    if (this.#keys.has(newKeyId)) throw new Error(`key ${newKeyId} is already in the ring`);
    return new ServerKeyRing([...this.#keys.values(), { keyId: newKeyId, ...generateKeyPair() }], newKeyId);
  }

  withRetired(keyId) {
    if (keyId === this.currentKeyId) throw new Error('cannot retire the current key; rotate first');
    return new ServerKeyRing([...this.#keys.values()].filter((key) => key.keyId !== keyId), this.currentKeyId);
  }
}
