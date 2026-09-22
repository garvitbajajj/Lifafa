# Lifafa

**Offline UPI-style payments carried over a mesh of nearby phones, settled exactly once.**

*Lifafa* (लिफ़ाफ़ा) means envelope. A payer with no internet seals a payment into an envelope that
only the settlement service can open, hands it to whatever phone is nearby, and it hops from phone
to phone until one of them reaches the network and delivers it.

JavaScript on Node 22, with PostgreSQL, Express and React. No build step: the code that runs is
the code in the repository.
An earlier implementation in Java and Spring Boot is at
[garvitbajajj/Lifafa1.0](https://github.com/garvitbajajj/Lifafa1.0).

---

## The problem

A payment that needs connectivity fails exactly when connectivity does — a basement shop, a power
cut, a train, a village with one bar of signal. Carrying payments over nearby phones is an old
idea; the hard part is not the radio, it is everything after it:

1. **The carriers are strangers.** They must not be able to read the payment, change it, or learn
   who is paying.
2. **Many of them deliver the same payment.** No single phone can be relied on to reach the
   network, so several carry the same envelope and all of them upload it. One payment, five
   deliveries, and the money must move exactly once — including when the service crashes midway.
3. **Any of them can keep a copy.** A carrier who stores an envelope must not be able to extract
   anything from it, replay it, or use it later.

Each of these is answered by a mechanism, and each mechanism is enforced in code and demonstrated
by tests rather than asserted in prose.

## How a payment moves

```
 payer phone          strangers' phones             bridge            settlement service
 (no signal)          (store and forward)       (has internet)          (Express + Postgres)
 ───────────          ───────────────────       ──────────────        ────────────────────
 sign   (Ed25519)
 seal   (HPKE)  ──gossip──▶ ... ──gossip──▶  POST /api/bridge/ingest ──▶ open envelope
                                                                        verify device signature
                                                                        claim the payment intent
                                                                        check limits and balance
                                                                        post double-entry ledger
                                             ◀── settled / refused, signed receipt
```

**1 — Sign, then seal.** The device signs a canonical binary encoding of the payment with its
Ed25519 key, then encrypts the signed bytes to the service's X25519 key using
[RFC 9180](https://www.rfc-editor.org/rfc/rfc9180) HPKE. Signing *first* puts the signature inside
the ciphertext, so carriers cannot see who is paying, let alone the amount. A sealed envelope is
259 bytes.

**2 — Carry.** Phones gossip envelopes to neighbours they have not already handed them to. A
carrier sees opaque bytes and a hop count.

**3 — Deliver.** Any phone with connectivity uploads what it holds, and keeps its copy until the
service returns a decision, so a payment is never dropped on the assumption that someone else
delivered it.

**4 — Settle exactly once.** The service decides each *payment intent* — `senderVpa/nonce`, taken
from inside the signature — once, however many copies arrive and in whatever order.

## The mechanisms

### Confidentiality: HPKE, not RSA

The payer has no connectivity, so there is no handshake to negotiate a key. HPKE solves exactly
that: the device generates a throwaway X25519 keypair, does Diffie-Hellman against the service's
public key, and derives a one-time AES-256-GCM key. The throwaway public key travels in the
envelope so the service can repeat the computation from its side.

RSA-2048 key wrap, the obvious alternative, costs 256 bytes per envelope against X25519's 32 — on
a link where every hop re-sends the payload, that difference is most of the envelope.

The envelope header (magic, version, suite, key id, ephemeral key) is not encrypted — the service
must read the key id to know which key to use — but it is passed to AES-GCM as associated data, so
it is authenticated: a carrier who rewrites any of it produces an envelope that fails to open.

### Exactly-once settlement: claim the intent, not the packet

The idempotency key is `senderVpa/nonce`, and both live inside the signature, so no carrier can
change them and every copy of one payment carries the same key. Deduplicating on a hash of the
ciphertext instead would miss the common case: re-sealing one payment uses a fresh ephemeral key,
so every byte on the wire differs.

Settlement is a durable two-phase claim. The first delivery to arrive claims the intent in the
database under a short lease; the ledger postings and the decision commit in one transaction, so a
crash cannot leave a half-payment behind. Later copies receive the decision that was already made.
A transient failure releases the claim, and an expired lease can be taken over, so a process dying
mid-settlement delays a payment rather than losing it. The journal carries a unique constraint on
the idempotency key as a last line of defence, so even a bug in the claim layer cannot post twice.

### Integrity of the money: a double-entry ledger in paise

Amounts are integers in paise — no floating point anywhere near money. Every movement is a journal
entry whose postings sum to zero, balances are a projection of those postings, and an invariant
check re-derives them, so money cannot be created or destroyed unnoticed. Funds enter from a house
account, so even issued money has a matching posting.

### Bounded offline risk

A payer with no connectivity can sign two payments against the same balance; nothing but trusted
hardware can prevent it. So it is bounded instead: each device has an offline allowance that only
an operator can refill while the device is online, plus a cap per payment. Each instruction also
carries a device sequence number, and the same number used for a different payment means a cloned
key, which revokes the device.

### Freshness and rotation

An envelope is valid until the earlier of the payer's own expiry and the service's maximum packet
age, so a stored copy cannot be delivered indefinitely. Keys are a ring rather than a single key:
each envelope names the key it was sealed to, so the service can rotate without stranding payments
already in the mesh — and a restart cannot make in-flight payments unreadable.

## Verification

The cryptography is checked against the specifications' own published test vectors, not only
against itself:

- **RFC 5869** — the three HKDF-SHA256 test cases.
- **RFC 9180 appendix A.1** — every intermediate value for HPKE base mode: both derived keypairs,
  the encapsulation, the shared secret, the key schedule context, key, base nonce and exporter
  secret, six ciphertexts across a nonce carry, and three exported values.

A round-trip test proves only that code agrees with itself, which is as true of a correct
implementation as of one that derives the wrong key everywhere consistently. Matching the RFC's
numbers rules that out.

The envelope's guarantees are tested directly: a sealed envelope contains none of the VPAs, the
amount or the nonce; flipping any single ciphertext bit fails the tag; two seals of one payment
carry one idempotency key; a forged signature or an edited amount is rejected; an envelope sealed
before a key rotation still opens afterwards, and stops only once that key is retired.

## In this repo

| Path | Contents |
|---|---|
| `packages/protocol` | The envelope format and its cryptography — HPKE, Ed25519 signatures, canonical encoding, the key ring and signed receipts. No dependencies beyond `node:crypto`, so it could be ported to a phone. 50 tests. |

## Running it

Requires Node.js 22 or newer.

```bash
npm install
```

```bash
npm test
```

## Scope

A research prototype of the settlement mechanism, not a payment product. It is not connected to
NPCI, a bank, or any real UPI rail — the ledger is its own. There is no Android app and no
Bluetooth transport; the mesh is simulated. The cryptography follows RFC 9180 and matches its test
vectors, but it is a from-scratch composition of primitives that no third party has reviewed, and
it does not provide forward secrecy: anyone who records envelopes and later obtains the service's
private key can read them, which is inherent to a payer who cannot run an interactive key exchange.

## Licence

[MIT](LICENSE).
