import { createHash, timingSafeEqual } from 'node:crypto';

/** Every byte string in the protocol. Node's Buffer is a Uint8Array, so both are accepted. */
export type Bytes = Uint8Array;

const encoder = new TextEncoder();
// fatal: invalid UTF-8 throws instead of silently becoming U+FFFD. A signed value that decodes
// "successfully" into something other than what was signed is the worst kind of bug.
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (text: string): Bytes => encoder.encode(text);
export const fromUtf8 = (bytes: Bytes): string => decoder.decode(bytes);

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Big-endian 2-byte integer, as HKDF labels and length prefixes use. */
export function u16(value: number): Bytes {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`u16 out of range: ${value}`);
  }
  return Uint8Array.of(value >>> 8, value & 0xff);
}

export const hex = (bytes: Bytes): string => Buffer.from(bytes).toString('hex');

/** Buffer.from(text, 'hex') silently stops at the first bad character, so validate first. */
export function unhex(text: string): Bytes {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    throw new Error('not a hex string');
  }
  return new Uint8Array(Buffer.from(text, 'hex'));
}

export const b64 = (bytes: Bytes): string => Buffer.from(bytes).toString('base64');

export function unb64(text: string): Bytes {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error('not a base64 string');
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
}

export const sha256 = (bytes: Bytes): Bytes => new Uint8Array(createHash('sha256').update(bytes).digest());

/**
 * Comparison whose running time does not depend on where the inputs first differ, so a caller
 * cannot learn a secret one byte at a time by timing the answer. Length is not secret here.
 */
export function equalConstantTime(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
