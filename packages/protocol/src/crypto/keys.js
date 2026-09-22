import { createPrivateKey, createPublicKey } from 'node:crypto';
import { concat, unhex } from '../bytes.js';

/**
 * Raw 32-byte X25519 and Ed25519 keys, converted to and from Node's KeyObject.
 *
 * The protocol stores and transmits keys as their raw 32 bytes - RFC 7748 for X25519, RFC 8032
 * for Ed25519. Node's crypto API wants a KeyObject, and the simplest exact way to build one from
 * raw bytes is to wrap them in the fixed DER header every key of that type shares. The headers
 * below are constants: an algorithm identifier (OID 1.3.101.110 for X25519, 1.3.101.112 for
 * Ed25519) followed by the length of the 32 bytes that come next.
 */
const X25519_PUBLIC_DER = unhex('302a300506032b656e032100');
const X25519_PRIVATE_DER = unhex('302e020100300506032b656e04220420');
const ED25519_PUBLIC_DER = unhex('302a300506032b6570032100');
const ED25519_PRIVATE_DER = unhex('302e020100300506032b657004220420');

export const KEY_BYTES = 32;

function require32(raw, what) {
  if (raw.length !== KEY_BYTES) throw new Error(`${what} must be ${KEY_BYTES} bytes, got ${raw.length}`);
}

export function x25519PublicKey(raw) {
  require32(raw, 'an X25519 public key');
  return createPublicKey({ key: Buffer.from(concat(X25519_PUBLIC_DER, raw)), format: 'der', type: 'spki' });
}

export function x25519PrivateKey(scalar) {
  require32(scalar, 'an X25519 private key');
  return createPrivateKey({ key: Buffer.from(concat(X25519_PRIVATE_DER, scalar)), format: 'der', type: 'pkcs8' });
}

export function ed25519PublicKey(raw) {
  require32(raw, 'an Ed25519 public key');
  return createPublicKey({ key: Buffer.from(concat(ED25519_PUBLIC_DER, raw)), format: 'der', type: 'spki' });
}

export function ed25519PrivateKey(seed) {
  require32(seed, 'an Ed25519 private key');
  return createPrivateKey({ key: Buffer.from(concat(ED25519_PRIVATE_DER, seed)), format: 'der', type: 'pkcs8' });
}

/** The raw 32 bytes of any X25519 or Ed25519 public key, or of the public half of a private key. */
export function rawPublic(key) {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('not an OKP key');
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
}

/** The raw 32-byte private scalar (X25519) or seed (Ed25519), for persisting a key. */
export function rawPrivate(key) {
  const jwk = key.export({ format: 'jwk' });
  if (typeof jwk.d !== 'string') throw new Error('not an OKP private key');
  return new Uint8Array(Buffer.from(jwk.d, 'base64url'));
}
