import { concat, fromUtf8, utf8 } from './bytes.js';

/** Anything received over the mesh that does not parse. Always a permanent rejection. */
export class MalformedError extends Error {
  name = 'MalformedError';
}

/**
 * A canonical binary encoding: fixed field order, big-endian integers, length-prefixed bytes.
 *
 * Why not JSON: a signature covers bytes, not values. JSON has many byte representations of one
 * value (key order, whitespace, number formats, escapes), so a verifier would have to re-create
 * the signer's exact bytes. Here each value has exactly one encoding, which is what gets signed.
 */
export class CanonicalWriter {
  #parts = [];

  u8(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(`u8 out of range: ${value}`);
    this.#parts.push(Uint8Array.of(value));
    return this;
  }

  u16(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`u16 out of range: ${value}`);
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value);
    this.#parts.push(out);
    return this;
  }

  u32(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`u32 out of range: ${value}`);
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value);
    this.#parts.push(out);
    return this;
  }

  /** 8 bytes on the wire, but only values JavaScript holds exactly (up to 2^53 - 1). */
  u64(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`u64 out of range: ${value}`);
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value));
    this.#parts.push(out);
    return this;
  }

  /** A u16 length, then the bytes. */
  bytes(value) {
    this.u16(value.length);
    this.#parts.push(value);
    return this;
  }

  string(value) {
    return this.bytes(utf8(value));
  }

  /** Bytes whose length the reader already knows, such as a magic number. */
  raw(value) {
    this.#parts.push(value);
    return this;
  }

  toBytes() {
    return concat(...this.#parts);
  }
}

export class CanonicalReader {
  #offset = 0;
  #input;
  #view;

  constructor(input) {
    this.#input = input;
    this.#view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  }

  #need(count) {
    if (this.#offset + count > this.#input.length) {
      throw new MalformedError(`truncated: needed ${count} more bytes at offset ${this.#offset}`);
    }
  }

  u8() {
    this.#need(1);
    return this.#view.getUint8(this.#offset++);
  }

  u16() {
    this.#need(2);
    const value = this.#view.getUint16(this.#offset);
    this.#offset += 2;
    return value;
  }

  u32() {
    this.#need(4);
    const value = this.#view.getUint32(this.#offset);
    this.#offset += 4;
    return value;
  }

  u64() {
    this.#need(8);
    const value = this.#view.getBigUint64(this.#offset);
    this.#offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new MalformedError('u64 exceeds the safe integer range');
    return Number(value);
  }

  raw(count) {
    this.#need(count);
    const out = this.#input.slice(this.#offset, this.#offset + count);
    this.#offset += count;
    return out;
  }

  bytes() {
    return this.raw(this.u16());
  }

  string() {
    try {
      return fromUtf8(this.bytes());
    } catch (error) {
      if (error instanceof MalformedError) throw error;
      throw new MalformedError('string is not valid UTF-8');
    }
  }

  remaining() {
    return this.raw(this.#input.length - this.#offset);
  }

  /**
   * Trailing bytes are rejected, not ignored. Otherwise one message would have many valid
   * encodings - the exact property a canonical encoding exists to rule out.
   */
  end() {
    if (this.#offset !== this.#input.length) {
      throw new MalformedError(`${this.#input.length - this.#offset} unexpected trailing bytes`);
    }
  }
}
