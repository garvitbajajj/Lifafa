# Lifafa

**Offline UPI-style payments carried over a mesh of nearby phones, settled exactly once.**

*Lifafa* (लिफ़ाफ़ा) means envelope. A payer with no internet seals a payment into an envelope that
only the settlement service can open, hands it to whatever phone is nearby, and it hops from phone
to phone until one of them reaches the network and delivers it.

Written in TypeScript on Node 22, PostgreSQL, Express and React.
A complete earlier implementation in Java and Spring Boot is at
[garvitbajajj/Lifafa1.0](https://github.com/garvitbajajj/Lifafa1.0).

---

## The problem

A payment that needs connectivity fails exactly when connectivity does — a basement shop, a power
cut, a train, a village with one bar of signal. The idea of carrying payments over nearby phones
is old; the reason it is hard is not the radio, it is what happens after:

1. **The carriers are strangers.** They must not be able to read the payment, change it, or learn
   who is paying.
2. **Many of them deliver the same payment.** You cannot rely on any one phone to reach the
   network, so several carry the same envelope and all of them upload it. One payment, five
   deliveries, and the money must move exactly once — including when the service crashes midway.
3. **Any of them can keep a copy.** A carrier who stores an envelope must not be able to extract
   anything from it, replay it, or use it later.

Lifafa is built around these three, and each one is enforced in code and proven by tests rather
than described in prose.

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

1. **Sign, then seal.** The device signs a canonical binary encoding of the payment with its
   Ed25519 key, then encrypts the signed bytes to the service's X25519 key using
   [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180) HPKE. Signing *first* puts the signature
   inside the ciphertext, so carriers cannot even see who is paying. A sealed envelope is 259 bytes.
2. **Carry.** Phones gossip envelopes to neighbours. They see opaque bytes and a hop count.
3. **Deliver.** Any phone with connectivity uploads what it holds, and keeps its copy until the
   service returns a decision.
4. **Settle exactly once.** The service decides each *payment intent* — `senderVpa/nonce`, taken
   from inside the signature — once, no matter how many copies arrive or in what order.

## Design decisions

| Decision | Why |
|---|---|
| **HPKE (X25519 + AES-256-GCM), not RSA** | RSA-2048 key wrap costs 256 bytes per envelope; an X25519 ephemeral key costs 32. On a link where every hop re-sends the payload, that is most of the envelope. |
| **Verified against the RFC's own test vectors** | A round-trip test only proves the code agrees with itself — equally true of a correct implementation and of one that derives the wrong key consistently. The test suite reproduces every intermediate value RFC 9180 publishes. |
| **Deduplicate on the payment intent, not the packet** | Re-sealing one payment produces completely different bytes, so hashing the ciphertext lets a re-send settle twice. |
| **Canonical binary encoding, not JSON** | A signature covers bytes. JSON has many byte representations of one value; a canonical encoding has exactly one. |
| **Amounts as integer paise** | No floating point anywhere near money. |
| **Double-entry ledger** | Every movement is postings that sum to zero, so money cannot be created or destroyed unnoticed, and a drift is detectable rather than invisible. |
| **Keys are a ring, not a key** | A payment can sit in the mesh for hours. Envelopes name the key they were sealed to, so keys rotate without stranding anything in flight. |

## Build status

Built in stages, each proven before the next begins.

| Stage | Contents | Status |
|---|---|---|
| 1 | **Protocol** — envelope format, HPKE, Ed25519 signatures, canonical encoding, key ring, receipts | ✅ Complete — 50 tests |
| 2 | **Ledger** — PostgreSQL schema and migrations, double-entry postings, invariant checker | In progress |
| 3 | **Settlement** — durable claims, device registry, offline spending limits, ingest pipeline | Planned |
| 4 | **API** — Express routes, bridge credentials, rate limiting, operator authentication | Planned |
| 5 | **Mesh simulation** — gossip over sparse topologies with packet loss and partitions | Planned |
| 6 | **Attack scenarios** — named, runnable attacks that fail the build if a defence stops holding | Planned |
| 7 | **React dashboard** — watch a payment cross the mesh and settle | Planned |
| 8 | **Docker, CI, threat model** | Planned |

### What stage 1 proves today

- **Carriers cannot read a payment.** A test scans the sealed envelope for the VPAs, the amount and
  the nonce, and finds none of them.
- **Carriers cannot alter one.** Flipping any single bit of the ciphertext fails the AES-GCM tag;
  the header is authenticated too, so the version, suite and key id cannot be rewritten either.
- **Two copies of one payment are recognisably one payment.** Sealing the same signed instruction
  twice produces two different envelopes that still carry the same idempotency key.
- **A forged or edited payment is rejected.** Changing the amount, or signing with another device
  while claiming someone else's public key, fails the signature check.
- **Key rotation strands nothing.** An envelope sealed before a rotation still opens afterwards,
  and stops opening only once its key is deliberately retired.
- **The cryptography matches the specification.** The suite reproduces the RFC 5869 HKDF vectors
  and every published value in RFC 9180 appendix A.1 — derived keypairs, shared secret, key
  schedule context, six ciphertexts across a nonce carry, and three exported values.

## Layout

| Path | What |
|---|---|
| `packages/protocol` | The envelope and its cryptography. No dependencies beyond `node:crypto`, so it could be ported to a phone. |

## Running it

Requires Node.js 22 or newer.

```bash
npm install
```

```bash
npm run check
```

`check` type-checks the workspace and runs the full test suite.

## Scope

This is a research prototype of the settlement mechanism, not a payment product. It is not
connected to NPCI, a bank, or any real UPI rail — the ledger is its own. There is no Android app
and no Bluetooth transport; the mesh is simulated. The cryptography follows RFC 9180 and is checked
against its test vectors, but it is a from-scratch composition of primitives that no third party
has reviewed, and it does not provide forward secrecy. A full threat model, including the
limitations, lands in stage 8.

## Licence

[MIT](LICENSE).
