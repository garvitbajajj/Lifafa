# 0001 — Carry signed instructions, settle them later

**Status:** Accepted

## Context

A payer with no connectivity wants to pay. There are two broad ways to make that work:

1. **Offline value.** The phone holds spendable value in secure hardware and hands it over directly.
   The payee is paid at the counter — but only if the value cannot be copied, which needs trusted
   hardware on every phone and an issuer standing behind it.
2. **Deferred settlement.** The phone signs an *instruction*. Nothing moves until that instruction
   reaches the service holding the accounts, which decides it then.

Nothing in this project can assume trusted hardware.

## Decision

Lifafa carries **sealed, signed payment instructions** across a store-and-forward mesh, and
settles them when any phone with connectivity delivers them.

- Phones gossip envelopes to neighbours. A carrier sees opaque bytes and a hop count.
- Any phone with connectivity is a bridge. It uploads what it holds and keeps each envelope until
  the service says that payment is decided.
- Only the service decides. A payment is pending until then.
- The simulated mesh uses real shapes — chains, sparse random graphs, packet loss, partitions —
  because a mesh where every phone reaches every other proves nothing.

## Consequences

- **The payee is not paid at the counter.** They hold a promise that settles when the envelope
  arrives. That bounds where this is useful: small payments, or a payee who knows the payer.
- **The same envelope will arrive many times**, from different bridges, at once and after restarts.
  Settling exactly once becomes the central problem — see [ADR 0003](0003-claim-the-payment-intent.md).
- **A payer can sign more than they have** while offline. The loss has to be bounded by policy —
  see [ADR 0005](0005-bounded-offline-risk.md).
- **Carriers are untrusted by construction**, so the envelope must hide and protect what it
  carries — see [ADR 0002](0002-hpke-not-rsa.md).
- **Envelopes can be dropped.** Nothing forces a phone to carry. The system can only make sure what
  does arrive is handled correctly, and that old envelopes expire.
