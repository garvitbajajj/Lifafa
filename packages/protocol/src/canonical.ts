import { type Bytes, concat, fromUtf8, utf8 } from './bytes.ts';

/** Anything received over the mesh that does not parse. Always a permanent rejection. */
export class MalformedError extends Error {
  override readonly name = 'MalformedError';
}

/**
 * A canonical binary encoding: fixed field order, big-endian integers, length-prefixed bytes.
 *
 * Why not JSON: a signature covers bytes, not values. JSON has many byte representations of one
 * value (key order, whitespace, number formats, escapes), so a verifier would have to re-create
 * the signer's exact bytes. Here each value has exactly one encoding, which is what gets signed.
 */
export class CanonicalWriter {
  private readonly parts: Bytes[] = [];

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(`u8 out of range: ${value}`);
    this.parts.push(Uint8Array.of(value));
    return this;
  }

  u16(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`u16 out of range: ${value}`);
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value);
    this.parts.push(out);
    return this;
  }

  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`u32 out of range: ${value}`);
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value);
    this.parts.push(out);
    return this;
  }

  /** 8 bytes on the wire, but only values JavaScript can hold exactly (up to 2^53 - 1). */
  u64(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`u64 out of range: ${value}`);
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value));
    this.parts.push(out);
    return this;
  }

  /** A u16 length, then the bytes. */
  bytes(value: Bytes): this {
    this.u16(value.length);
    this.parts.push(value);
    return this;
  }

  string(value: string): this {
    return this.bytes(utf8(value));
  }

  /** Bytes whose length the reader already knows, such as a magic number. */
  raw(value: Bytes): this {
    this.parts.push(value);
    return this;
  }

  toBytes(): Bytes {
    return concat(...this.parts);
  }
}

export class CanonicalReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly input: Bytes) {
    this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  }

  private need(count: number): void {
    if (this.offset + count > this.input.length) {
      throw new MalformedError(`truncated: needed ${count} more bytes at offset ${this.offset}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): number {
    this.need(8);
    const value = this.view.getBigUint64(this.offset);
    this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new MalformedError('u64 exceeds the safe integer range');
    return Number(value);
  }

  raw(count: number): Bytes {
    this.need(count);
    const out = this.input.slice(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  bytes(): Bytes {
    return this.raw(this.u16());
  }

  string(): string {
    try {
      return fromUtf8(this.bytes());
    } catch (error) {
      if (error instanceof MalformedError) throw error;
      throw new MalformedError('string is not valid UTF-8');
    }
  }

  remaining(): Bytes {
    return this.raw(this.input.length - this.offset);
  }

  /**
   * Trailing bytes are rejected, not ignored. Otherwise one message would have many valid
   * encodings - the exact property a canonical encoding exists to rule out.
   */
  end(): void {
    if (this.offset !== this.input.length) {
      throw new MalformedError(`${this.input.length - this.offset} unexpected trailing bytes`);
    }
  }
}
