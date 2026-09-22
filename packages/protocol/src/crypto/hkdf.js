import { createHmac } from 'node:crypto';
import { concat, u16, utf8 } from '../bytes.js';

const HASH_BYTES = 32;
const HPKE_VERSION = utf8('HPKE-v1');

function hmac(key, message) {
  return new Uint8Array(createHmac('sha256', key).update(message).digest());
}

/**
 * HKDF-SHA256, RFC 5869, written out as its two steps.
 *
 * Node has crypto.hkdfSync, but it runs extract and expand together. HPKE needs them separately
 * (it extracts once, then expands the same key several ways), so they are built from HMAC here -
 * a direct transcription of RFC 5869 section 2, checked against its test vectors.
 */
export function extract(salt, ikm) {
  // RFC 5869 2.2: an absent salt is HashLen zero bytes.
  return hmac(salt.length > 0 ? salt : new Uint8Array(HASH_BYTES), ikm);
}

export function expand(prk, info, length) {
  if (length > 255 * HASH_BYTES) throw new RangeError(`HKDF output too long: ${length}`);
  const out = new Uint8Array(length);
  let block = new Uint8Array(0);
  for (let counter = 1, written = 0; written < length; counter++) {
    block = hmac(prk, concat(block, info, Uint8Array.of(counter)));
    const take = Math.min(block.length, length - written);
    out.set(block.subarray(0, take), written);
    written += take;
  }
  return out;
}

/**
 * RFC 9180 section 4: LabeledExtract. The suite id and a label are mixed in, so two uses of the
 * same secret can never produce the same key ("domain separation").
 */
export function labeledExtract(suiteId, salt, label, ikm) {
  return extract(salt, concat(HPKE_VERSION, suiteId, utf8(label), ikm));
}

/** RFC 9180 section 4: LabeledExpand. */
export function labeledExpand(suiteId, prk, label, info, length) {
  return expand(prk, concat(u16(length), HPKE_VERSION, suiteId, utf8(label), info), length);
}
