import { diffieHellman, generateKeyPairSync } from 'node:crypto';
import { type Bytes, concat, u16, utf8 } from '../bytes.ts';
import * as aead from './aead.ts';
import { labeledExpand, labeledExtract } from './hkdf.ts';
import { rawPrivate, rawPublic, x25519PrivateKey, x25519PublicKey } from './keys.ts';

/**
 * HPKE base mode, RFC 9180, with DHKEM(X25519, HKDF-SHA256) and HKDF-SHA256.
 *
 * HPKE is how you encrypt to someone's public key without talking to them first - exactly the
 * offline payer's situation. The sender makes a throwaway X25519 keypair, does Diffie-Hellman
 * against the recipient's public key, and derives a one-time AES key from the result. The
 * throwaway public key travels with the ciphertext ("enc") so the recipient can do the same
 * Diffie-Hellman from its side.
 *
 * Only base mode is implemented. PSK mode needs a pre-shared key the payer does not have;
 * authenticated mode would authenticate a static sender KEM key, whereas Lifafa authenticates
 * the payer with an Ed25519 signature inside the ciphertext, which also hides who is paying.
 *
 * Every line here is checked against RFC 9180 appendix A.1 in test/hpke.test.ts.
 */

export const MODE_BASE = 0x00;
export const KEM_X25519_HKDF_SHA256 = 0x0020;
export const KDF_HKDF_SHA256 = 0x0001;
export const AEAD_AES_128_GCM = 0x0001;
export const AEAD_AES_256_GCM = 0x0002;

export interface Suite {
  readonly kemId: number;
  readonly kdfId: number;
  readonly aeadId: number;
}

/** What Lifafa seals with. */
export const X25519_SHA256_AES256GCM: Suite = {
  kemId: KEM_X25519_HKDF_SHA256,
  kdfId: KDF_HKDF_SHA256,
  aeadId: AEAD_AES_256_GCM,
};

/** What RFC 9180 publishes X25519 test vectors for. Identical except for the AES key length. */
export const X25519_SHA256_AES128GCM: Suite = {
  kemId: KEM_X25519_HKDF_SHA256,
  kdfId: KDF_HKDF_SHA256,
  aeadId: AEAD_AES_128_GCM,
};

const SECRET_BYTES = 32; // Nsecret and Nh for HKDF-SHA256
const NONCE_BYTES = aead.NONCE_BYTES;

const suiteId = (suite: Suite): Bytes =>
  concat(utf8('HPKE'), u16(suite.kemId), u16(suite.kdfId), u16(suite.aeadId));

const kemSuiteId = (suite: Suite): Bytes => concat(utf8('KEM'), u16(suite.kemId));

function keyBytes(suite: Suite): number {
  switch (suite.aeadId) {
    case AEAD_AES_128_GCM:
      return 16;
    case AEAD_AES_256_GCM:
      return 32;
    default:
      throw new Error(`unsupported AEAD id ${suite.aeadId}`);
  }
}

// ---------------------------------------------------------------------------------------------
// DHKEM(X25519, HKDF-SHA256) - RFC 9180 section 4.1
// ---------------------------------------------------------------------------------------------

/** A keypair as raw bytes: the 32-byte private scalar and the 32-byte public key. */
export interface RawKeyPair {
  readonly privateKey: Bytes;
  readonly publicKey: Bytes;
}

export function generateKeyPair(): RawKeyPair {
  const { privateKey } = generateKeyPairSync('x25519');
  return { privateKey: rawPrivate(privateKey), publicKey: rawPublic(privateKey) };
}

/** DeriveKeyPair(ikm) for X25519 - deterministic, used by the test vectors. */
export function deriveKeyPair(suite: Suite, ikm: Bytes): RawKeyPair {
  const id = kemSuiteId(suite);
  const dkpPrk = labeledExtract(id, new Uint8Array(0), 'dkp_prk', ikm);
  const privateKey = labeledExpand(id, dkpPrk, 'sk', new Uint8Array(0), 32);
  return { privateKey, publicKey: rawPublic(x25519PrivateKey(privateKey)) };
}

function dh(privateScalar: Bytes, publicKey: Bytes): Bytes {
  const shared = new Uint8Array(
    diffieHellman({ privateKey: x25519PrivateKey(privateScalar), publicKey: x25519PublicKey(publicKey) }),
  );
  // RFC 9180 7.1.4: an all-zero result means a low-order public key. Refuse it.
  if (shared.every((byte) => byte === 0)) throw new Error('X25519 produced the all-zero value');
  return shared;
}

function extractAndExpand(suite: Suite, dhResult: Bytes, kemContext: Bytes): Bytes {
  const id = kemSuiteId(suite);
  const eaePrk = labeledExtract(id, new Uint8Array(0), 'eae_prk', dhResult);
  return labeledExpand(id, eaePrk, 'shared_secret', kemContext, SECRET_BYTES);
}

export interface Encapsulation {
  /** The ephemeral public key. Travels on the wire. */
  readonly enc: Bytes;
  /** Known only to the sender and the recipient. */
  readonly sharedSecret: Bytes;
}

/** Encap(pkR) with a fresh ephemeral keypair. */
export function encapsulate(suite: Suite, recipientPublicKey: Bytes): Encapsulation {
  return encapsulateWith(suite, recipientPublicKey, generateKeyPair().privateKey);
}

/**
 * Encap(pkR) with the ephemeral key supplied. For the test vectors only: sealing twice with one
 * ephemeral key would reuse an AES key, which is exactly what must never happen.
 */
export function encapsulateWith(suite: Suite, recipientPublicKey: Bytes, ephemeralPrivateKey: Bytes): Encapsulation {
  const enc = rawPublic(x25519PrivateKey(ephemeralPrivateKey));
  const dhResult = dh(ephemeralPrivateKey, recipientPublicKey);
  return { enc, sharedSecret: extractAndExpand(suite, dhResult, concat(enc, recipientPublicKey)) };
}

/** Decap(enc, skR). */
export function decapsulate(suite: Suite, recipientPrivateKey: Bytes, enc: Bytes): Bytes {
  const recipientPublicKey = rawPublic(x25519PrivateKey(recipientPrivateKey));
  const dhResult = dh(recipientPrivateKey, enc);
  return extractAndExpand(suite, dhResult, concat(enc, recipientPublicKey));
}

// ---------------------------------------------------------------------------------------------
// Key schedule - RFC 9180 section 5
// ---------------------------------------------------------------------------------------------

export interface Context {
  readonly key: Bytes;
  readonly baseNonce: Bytes;
  readonly exporterSecret: Bytes;
}

/** key_schedule_context for base mode. Exported so the RFC's published value can be asserted. */
export function keyScheduleContext(suite: Suite, info: Bytes): Bytes {
  const id = suiteId(suite);
  const empty = new Uint8Array(0);
  // Base mode still hashes the empty PSK id, so a recipient expecting a PSK derives a different key.
  const pskIdHash = labeledExtract(id, empty, 'psk_id_hash', empty);
  const infoHash = labeledExtract(id, empty, 'info_hash', info);
  return concat(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
}

/** KeySchedule(mode_base, shared_secret, info, psk = "", psk_id = ""). */
export function keySchedule(suite: Suite, sharedSecret: Bytes, info: Bytes): Context {
  const id = suiteId(suite);
  const context = keyScheduleContext(suite, info);
  const secret = labeledExtract(id, sharedSecret, 'secret', new Uint8Array(0));
  return {
    key: labeledExpand(id, secret, 'key', context, keyBytes(suite)),
    baseNonce: labeledExpand(id, secret, 'base_nonce', context, NONCE_BYTES),
    exporterSecret: labeledExpand(id, secret, 'exp', context, SECRET_BYTES),
  };
}

/** Section 5.2: base_nonce XOR the sequence number, big-endian. */
export function nonce(baseNonce: Bytes, sequence: number): Bytes {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError(`bad sequence number ${sequence}`);
  const out = Uint8Array.from(baseNonce);
  const seq = new Uint8Array(8);
  new DataView(seq.buffer).setBigUint64(0, BigInt(sequence));
  for (let i = 0; i < 8; i++) {
    const index = out.length - 8 + i;
    out[index] = (out[index] ?? 0) ^ (seq[i] ?? 0);
  }
  return out;
}

/** Section 5.3: Export(exporter_context, L). */
export function exportSecret(suite: Suite, exporterSecret: Bytes, exporterContext: Bytes, length: number): Bytes {
  return labeledExpand(suiteId(suite), exporterSecret, 'sec', exporterContext, length);
}

// ---------------------------------------------------------------------------------------------
// Single-shot seal and open - RFC 9180 section 6.1
// ---------------------------------------------------------------------------------------------

/** SealBase(pkR, info, aad, pt). */
export function seal(suite: Suite, recipientPublicKey: Bytes, info: Bytes, aad: Bytes, plaintext: Bytes) {
  const { enc, sharedSecret } = encapsulate(suite, recipientPublicKey);
  const context = keySchedule(suite, sharedSecret, info);
  return { enc, ciphertext: aead.seal(context.key, nonce(context.baseNonce, 0), aad, plaintext) };
}

/** OpenBase(enc, skR, info, aad, ct). Throws if the encapsulation is unusable or the tag fails. */
export function open(suite: Suite, recipientPrivateKey: Bytes, enc: Bytes, info: Bytes, aad: Bytes, ciphertext: Bytes) {
  const context = keySchedule(suite, decapsulate(suite, recipientPrivateKey, enc), info);
  return aead.open(context.key, nonce(context.baseNonce, 0), aad, ciphertext);
}
