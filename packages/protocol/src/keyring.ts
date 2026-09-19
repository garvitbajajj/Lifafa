import type { Bytes } from './bytes.ts';
import { rawPublic, x25519PrivateKey } from './crypto/keys.ts';
import { generateKeyPair } from './crypto/hpke.ts';

export interface ServerKey {
  readonly keyId: number;
  /** The raw X25519 private scalar. Whoever has this can read every envelope sealed to it. */
  readonly privateKey: Bytes;
  readonly publicKey: Bytes;
}

/**
 * The settlement service's X25519 keys, by id.
 *
 * A ring rather than one key, because a payment can sit in the mesh for hours. Rotating means
 * adding a new current key while keeping the old ones, so envelopes sealed before the rotation
 * still open. The reference project generated a new key on every start and had no key id in its
 * format, so a restart made every payment in flight permanently unreadable.
 *
 * Immutable: rotation returns a new ring, so a ring someone is reading never changes under them.
 */
export class ServerKeyRing {
  private readonly keys: ReadonlyMap<number, ServerKey>;

  private constructor(keys: Iterable<ServerKey>, readonly currentKeyId: number) {
    this.keys = new Map([...keys].map((key) => [key.keyId, key]));
    if (!this.keys.has(currentKeyId)) throw new Error(`current key ${currentKeyId} is not in the ring`);
  }

  static generate(keyId: number): ServerKeyRing {
    return new ServerKeyRing([{ keyId, ...generateKeyPair() }], keyId);
  }

  /** Rebuilds a ring from stored private keys; public keys are derived, not trusted from storage. */
  static fromPrivateKeys(entries: ReadonlyArray<{ keyId: number; privateKey: Bytes }>, currentKeyId: number): ServerKeyRing {
    return new ServerKeyRing(
      entries.map(({ keyId, privateKey }) => ({ keyId, privateKey, publicKey: rawPublic(x25519PrivateKey(privateKey)) })),
      currentKeyId,
    );
  }

  current(): ServerKey {
    return this.keys.get(this.currentKeyId)!;
  }

  lookup(keyId: number): ServerKey | undefined {
    return this.keys.get(keyId);
  }

  all(): ServerKey[] {
    return [...this.keys.values()];
  }

  withRotatedKey(newKeyId: number): ServerKeyRing {
    if (this.keys.has(newKeyId)) throw new Error(`key ${newKeyId} is already in the ring`);
    return new ServerKeyRing([...this.keys.values(), { keyId: newKeyId, ...generateKeyPair() }], newKeyId);
  }

  withRetired(keyId: number): ServerKeyRing {
    if (keyId === this.currentKeyId) throw new Error('cannot retire the current key; rotate first');
    return new ServerKeyRing([...this.keys.values()].filter((key) => key.keyId !== keyId), this.currentKeyId);
  }
}
