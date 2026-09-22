import { createCipheriv, createDecipheriv } from 'node:crypto';
import { concat } from '../bytes.js';

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

/** The tag did not verify: wrong key, wrong nonce, or tampered ciphertext or associated data. */
export class AeadError extends Error {
  name = 'AeadError';
}

function algorithm(key) {
  if (key.length === 16) return 'aes-128-gcm';
  if (key.length === 32) return 'aes-256-gcm';
  throw new AeadError(`AES-GCM keys are 16 or 32 bytes, got ${key.length}`);
}

function checkNonce(nonce) {
  if (nonce.length !== NONCE_BYTES) throw new AeadError(`AES-GCM nonces are ${NONCE_BYTES} bytes`);
}

/**
 * AES-GCM. Returns ciphertext followed by the 16-byte tag.
 *
 * GCM fails catastrophically if one key ever encrypts two messages under the same nonce. Lifafa
 * never reuses a key: each envelope's key comes from a fresh ephemeral X25519 keypair, so it
 * encrypts exactly one message.
 */
export function seal(key, nonce, aad, plaintext) {
  checkNonce(nonce);
  const cipher = createCipheriv(algorithm(key), key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  return concat(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
}

export function open(key, nonce, aad, sealed) {
  checkNonce(nonce);
  if (sealed.length < TAG_BYTES) throw new AeadError('ciphertext shorter than the GCM tag');
  const decipher = createDecipheriv(algorithm(key), key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return concat(decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final());
  } catch {
    throw new AeadError('GCM tag did not verify');
  }
}
