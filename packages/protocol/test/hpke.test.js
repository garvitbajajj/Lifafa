import { describe, expect, it } from 'vitest';
import { hex, unhex } from '../src/bytes.js';
import * as aead from '../src/crypto/aead.js';
import * as hpke from '../src/crypto/hpke.js';

/**
 * RFC 9180 appendix A.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
 *
 * These are the specification's published values. A round-trip test only proves the code agrees
 * with itself - true of a correct implementation and of one that derives the wrong key everywhere
 * consistently. Matching every intermediate value the RFC publishes rules the second one out.
 *
 * Lifafa seals with AES-256-GCM; the RFC has no X25519 vectors for it. Everything below is shared
 * between the two suites except the AES key length.
 */
const suite = hpke.X25519_SHA256_AES128GCM;

const v = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  ikmE: '7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234',
  pkEm: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
  skEm: '52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736',
  ikmR: '6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037',
  pkRm: '3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d',
  skRm: '4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8',
  sharedSecret: 'fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc',
  keyScheduleContext:
    '00725611c9d98c07c03f60095cd32d400d8347d45ed67097bbad50fc56da742d07' +
    'cb6cffde367bb0565ba28bb02c90744a20f5ef37f30523526106f637abb05449',
  key: '4531685d41d65f03dc48f6b8302c05b0',
  baseNonce: '56d890e5accaaf011cff4b7d',
  exporterSecret: '45ff1c2e220db587171952c0592d5f5ebe103f1561a2614e38f2ffd47e99e3f8',
  plaintext: '4265617574792069732074727574682c20747275746820626561757479',
};

const encryptions = [
  { seq: 0, aad: '436f756e742d30', nonce: '56d890e5accaaf011cff4b7d',
    ct: 'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a' },
  { seq: 1, aad: '436f756e742d31', nonce: '56d890e5accaaf011cff4b7c',
    ct: 'af2d7e9ac9ae7e270f46ba1f975be53c09f8d875bdc8535458c2494e8a6eab251c03d0c22a56b8ca42c2063b84' },
  { seq: 2, aad: '436f756e742d32', nonce: '56d890e5accaaf011cff4b7f',
    ct: '498dfcabd92e8acedc281e85af1cb4e3e31c7dc394a1ca20e173cb72516491588d96a19ad4a683518973dcc180' },
  { seq: 4, aad: '436f756e742d34', nonce: '56d890e5accaaf011cff4b79',
    ct: '583bd32bc67a5994bb8ceaca813d369bca7b2a42408cddef5e22f880b631215a09fc0012bc69fccaa251c0246d' },
  { seq: 255, aad: '436f756e742d323535', nonce: '56d890e5accaaf011cff4b82',
    ct: '7175db9717964058640a3a11fb9007941a5d1757fda1a6935c805c21af32505bf106deefec4a49ac38d71c9e0a' },
  { seq: 256, aad: '436f756e742d323536', nonce: '56d890e5accaaf011cff4a7d',
    ct: '957f9800542b0b8891badb026d79cc54597cb2d225b54c00c5238c25d05c30e3fbeda97d2e0e1aba483a2df9f2' },
];

const exports = [
  { context: '', value: '3853fe2b4035195a573ffc53856e77058e15d9ea064de3e59f4961d0095250ee' },
  { context: '00', value: '2e8f0b54673c7029649d4eb9d5e33bf1872cf76d623ff164ac185da9e88c21a5' },
  { context: '54657374436f6e74657874', value: 'e9e43065102c3836401bed8c3c3c75ae46be1639869391d62c61f1ec7af54931' },
];

describe('HPKE base mode against RFC 9180 appendix A.1', () => {
  it('DeriveKeyPair reproduces both published keypairs', () => {
    const ephemeral = hpke.deriveKeyPair(suite, unhex(v.ikmE));
    expect(hex(ephemeral.privateKey)).toBe(v.skEm);
    expect(hex(ephemeral.publicKey)).toBe(v.pkEm);

    const recipient = hpke.deriveKeyPair(suite, unhex(v.ikmR));
    expect(hex(recipient.privateKey)).toBe(v.skRm);
    expect(hex(recipient.publicKey)).toBe(v.pkRm);
  });

  it('Encap and Decap both produce the published shared secret', () => {
    const encapsulation = hpke.encapsulateWith(suite, unhex(v.pkRm), unhex(v.skEm));
    expect(hex(encapsulation.enc)).toBe(v.pkEm);
    expect(hex(encapsulation.sharedSecret)).toBe(v.sharedSecret);

    expect(hex(hpke.decapsulate(suite, unhex(v.skRm), encapsulation.enc))).toBe(v.sharedSecret);
  });

  it('the key schedule reproduces context, key, base nonce and exporter secret', () => {
    expect(hex(hpke.keyScheduleContext(suite, unhex(v.info)))).toBe(v.keyScheduleContext);

    const context = hpke.keySchedule(suite, unhex(v.sharedSecret), unhex(v.info));
    expect(hex(context.key)).toBe(v.key);
    expect(hex(context.baseNonce)).toBe(v.baseNonce);
    expect(hex(context.exporterSecret)).toBe(v.exporterSecret);
  });

  it.each(encryptions)('encryption at sequence $seq, including the nonce carry', ({ seq, aad, nonce, ct }) => {
    const n = hpke.nonce(unhex(v.baseNonce), seq);
    expect(hex(n)).toBe(nonce);

    const sealed = aead.seal(unhex(v.key), n, unhex(aad), unhex(v.plaintext));
    expect(hex(sealed)).toBe(ct);
    expect(hex(aead.open(unhex(v.key), n, unhex(aad), sealed))).toBe(v.plaintext);
  });

  it.each(exports)('exported value for context "$context"', ({ context, value }) => {
    expect(hex(hpke.exportSecret(suite, unhex(v.exporterSecret), unhex(context), 32))).toBe(value);
  });
});
