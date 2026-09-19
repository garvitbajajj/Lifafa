import { type Bytes, concat, equalConstantTime, hex, sha256, utf8 } from './bytes.ts';
import { CanonicalReader, CanonicalWriter, MalformedError } from './canonical.ts';

/**
 * The lifafa itself: a sealed envelope any phone may carry and only the settlement service may open.
 *
 *   offset  size  field
 *   0       4     magic        "LFFA"
 *   4       1     version      1
 *   5       1     suite        1 = HPKE base mode, X25519 / HKDF-SHA256 / AES-256-GCM, Ed25519 inside
 *   6       4     serverKeyId  which of the service's keys this is sealed to
 *   10      2     encLen       32
 *   12      32    enc          the sender's ephemeral X25519 public key
 *   44      ..    ciphertext   AES-256-GCM over the signed instruction, 16-byte tag at the end
 *
 * Bytes 0-43 are the header. It is not encrypted - the service must read the key id to know which
 * key to use - but it is passed to AES-GCM as associated data, so it is authenticated: a carrier
 * who rewrites the version, suite or key id produces an envelope that fails to open.
 *
 * The version and suite bytes exist so the format can change later without stranding envelopes
 * already in the mesh. The key id exists so the service can rotate keys for the same reason.
 */
export interface Envelope {
  readonly version: number;
  readonly suite: number;
  readonly serverKeyId: number;
  readonly enc: Bytes;
  readonly ciphertext: Bytes;
}

export const MAGIC = utf8('LFFA');
export const VERSION_1 = 1;
export const SUITE_HPKE_X25519_AES256GCM_ED25519 = 1;

/** A legitimate envelope is under 300 bytes. Nothing needs kilobytes; refuse before parsing. */
export const MAX_ENVELOPE_BYTES = 4096;
const ENC_BYTES = 32;
const TAG_BYTES = 16;

/** The authenticated header: everything before the ciphertext. */
export function header(envelope: Pick<Envelope, 'version' | 'suite' | 'serverKeyId' | 'enc'>): Bytes {
  return new CanonicalWriter()
    .raw(MAGIC)
    .u8(envelope.version)
    .u8(envelope.suite)
    .u32(envelope.serverKeyId)
    .bytes(envelope.enc)
    .toBytes();
}

export const encodeEnvelope = (envelope: Envelope): Bytes => concat(header(envelope), envelope.ciphertext);

export function decodeEnvelope(wire: Bytes): Envelope {
  if (wire.length > MAX_ENVELOPE_BYTES) throw new MalformedError(`envelope over ${MAX_ENVELOPE_BYTES} bytes`);
  const reader = new CanonicalReader(wire);
  if (!equalConstantTime(reader.raw(MAGIC.length), MAGIC)) throw new MalformedError('not a lifafa envelope');
  const version = reader.u8();
  const suite = reader.u8();
  const serverKeyId = reader.u32();
  const enc = reader.bytes();
  const ciphertext = reader.remaining();
  if (enc.length !== ENC_BYTES) throw new MalformedError(`enc must be ${ENC_BYTES} bytes`);
  if (ciphertext.length < TAG_BYTES) throw new MalformedError('ciphertext shorter than a GCM tag');
  return { version, suite, serverKeyId, enc, ciphertext };
}

/**
 * A hash of the whole envelope, used only as a fast path to skip re-opening an exact copy of an
 * envelope that was already decided.
 *
 * It is NOT the idempotency key. Two seals of one payment use different ephemeral keys, so they
 * have different fingerprints. Deduplicating on this is the mistake the reference project made:
 * re-sending the same payment settled it twice.
 */
export const fingerprint = (wire: Bytes): string => hex(sha256(wire));
