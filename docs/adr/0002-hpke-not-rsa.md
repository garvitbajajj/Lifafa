# 0002 — HPKE, verified against the RFC, instead of RSA key wrapping

**Status:** Accepted

## Context

Envelopes cross phones the payer does not trust, so they must be confidential and tamper-evident.
The payer has no connectivity, so there is no handshake to agree a key: the payer must encrypt to
the service's public key alone.

The reference implementation wrapped a fresh AES key with RSA-2048-OAEP. That cost 256 bytes per
envelope, gave no sender authentication — anyone with the public key could pay from any account —
and regenerated the key on every start, so a restart made every payment in flight unreadable.

## Decision

**Sign, then seal.**

1. The phone signs a canonical binary encoding of the payment with its **Ed25519** key.
2. The signed bytes are sealed with **HPKE base mode** ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180)):
   DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM.
3. The envelope header — magic, version, suite, key id, ephemeral public key — is the AEAD's
   associated data, so it is authenticated though not encrypted.
4. The key id names which of the service's keys was used, so keys can rotate.

Signing *before* encrypting puts the signature inside the ciphertext, so carriers cannot even see
who is paying.

**Verified, not asserted.** The primitives are Node's (`node:crypto`); only the composition is
written here, and it is tested against the RFC's own published numbers: every intermediate value in
appendix A.1 — derived keypairs, shared secret, key schedule context, key, base nonce, exporter
secret, six ciphertexts across a nonce carry, three exported values. HKDF is checked separately
against RFC 5869. A round-trip test only proves code agrees with itself, which is equally true of an
implementation that derives the wrong key everywhere consistently.

## Consequences

- A sealed envelope is 259 bytes. An X25519 ephemeral key costs 32 bytes against RSA's 256, on a
  link where every hop re-sends the payload.
- Impersonation needs a device's private key, not the service's public key.
- Rotation does not strand envelopes, as long as old keys are kept while their envelopes can still
  be valid.
- **No forward secrecy.** The shared secret is recomputable from the service's long-term key and the
  ephemeral public key in the envelope. An offline payer cannot run an interactive exchange; the
  mitigation is to rotate and destroy retired keys. See [THREAT_MODEL.md](../../THREAT_MODEL.md).
- Matching the vectors is strong evidence, not a review. Real money should use a vetted HPKE
  library; the suite byte exists so one can replace this without stranding envelopes in flight.
