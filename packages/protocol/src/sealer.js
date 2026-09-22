import { utf8 } from './bytes.js';
import { MalformedError } from './canonical.js';
import * as aead from './crypto/aead.js';
import * as hpke from './crypto/hpke.js';
import { SUITE_HPKE_X25519_AES256GCM_ED25519, VERSION_1, decodeEnvelope, header } from './envelope.js';
import { decodeSigned, encodeSigned, hasValidSignature, signInstruction } from './signed.js';

const SUITE = hpke.X25519_SHA256_AES256GCM;

/** HPKE info: names the application, so these keys can never collide with another protocol's. */
const INFO = utf8('lifafa/envelope/1');

/**
 * Sign, then seal.
 *
 * 1. The device signs the instruction with its Ed25519 key.
 * 2. The signed bytes are encrypted to the service's X25519 key with HPKE (RFC 9180).
 * 3. The header is the AES-GCM associated data, so it cannot be altered either.
 *
 * Signing first puts the signature inside the encryption, so carriers cannot see who is paying.
 */
export function seal(instruction, device, serverPublicKey, serverKeyId) {
  return sealSigned(signInstruction(device, instruction), serverPublicKey, serverKeyId);
}

/**
 * Seals an already-signed instruction. Separate so a test can seal one signature twice - which
 * produces two different envelopes for one payment, the case ciphertext deduplication misses.
 */
export function sealSigned(signed, serverPublicKey, serverKeyId) {
  const { enc, sharedSecret } = hpke.encapsulate(SUITE, serverPublicKey);
  const shell = { version: VERSION_1, suite: SUITE_HPKE_X25519_AES256GCM_ED25519, serverKeyId, enc };
  const context = hpke.keySchedule(SUITE, sharedSecret, INFO);
  const ciphertext = aead.seal(context.key, hpke.nonce(context.baseNonce, 0), header(shell), encodeSigned(signed));
  return { ...shell, ciphertext };
}

/**
 * Why an envelope could not be opened: MALFORMED, UNSUPPORTED, UNKNOWN_SERVER_KEY, DECRYPT_FAILED,
 * MALFORMED_PLAINTEXT or BAD_SIGNATURE.
 *
 * All permanent: retrying the same bytes can never succeed, so a bridge told any of these should
 * drop the envelope rather than carry it forever.
 */
const fail = (reason, detail) => ({ ok: false, reason, detail });

/**
 * Opens an envelope and checks the signature inside it.
 *
 * It does NOT decide whether the payment is allowed. Is the device registered to this VPA? Is it
 * fresh? Is there money? Those are policy, and they live in the settlement service. Keeping them
 * out of here is what lets this package run on a phone.
 *
 * @returns {{ok: true, signed: import('./signed.js').SignedInstruction, envelope: object}
 *          | {ok: false, reason: string, detail: string}}
 */
export function open(wire, keyRing) {
  let envelope;
  try {
    envelope = decodeEnvelope(wire);
  } catch (error) {
    return fail('MALFORMED', error.message);
  }
  if (envelope.version !== VERSION_1) return fail('UNSUPPORTED', `version ${envelope.version}`);
  if (envelope.suite !== SUITE_HPKE_X25519_AES256GCM_ED25519) return fail('UNSUPPORTED', `suite ${envelope.suite}`);

  // Checked separately from decryption on purpose. "We no longer hold that key" means keys are
  // being retired too early and payments are being stranded; "the bytes are corrupt" does not.
  // An operator needs to be able to tell those apart.
  const serverKey = keyRing.lookup(envelope.serverKeyId);
  if (!serverKey) return fail('UNKNOWN_SERVER_KEY', `no server key with id ${envelope.serverKeyId}`);

  let sharedSecret;
  try {
    sharedSecret = hpke.decapsulate(SUITE, serverKey.privateKey, envelope.enc);
  } catch (error) {
    return fail('MALFORMED', `unusable key encapsulation: ${error.message}`);
  }

  let plaintext;
  try {
    const context = hpke.keySchedule(SUITE, sharedSecret, INFO);
    plaintext = aead.open(context.key, hpke.nonce(context.baseNonce, 0), header(envelope), envelope.ciphertext);
  } catch {
    return fail('DECRYPT_FAILED', 'GCM tag did not verify');
  }

  let signed;
  try {
    signed = decodeSigned(plaintext);
  } catch (error) {
    return fail('MALFORMED_PLAINTEXT', error instanceof MalformedError ? error.message : 'unreadable plaintext');
  }

  if (!hasValidSignature(signed)) return fail('BAD_SIGNATURE', 'the signature does not match the device key');
  return { ok: true, signed, envelope };
}
