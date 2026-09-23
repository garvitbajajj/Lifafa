# 0003 — A durable, leased claim on the payment intent

**Status:** Accepted

## Context

The same payment arrives many times: from several bridges at once, again after a bridge restarts,
again after the service restarts. It must settle exactly once, and a failure halfway must not lose
it.

The reference implementation hashed the ciphertext and claimed the hash in an in-memory map,
*before* decrypting or settling. That fails four ways:

1. **Re-sealing defeats it.** One payment sealed twice has different ciphertext, so two hashes, so
   it settles twice.
2. **A failure after the claim loses the payment.** The hash stays claimed with nothing behind it,
   and every later copy is called a duplicate.
3. **A restart forgets every claim**, so envelopes still in the mesh can settle again.
4. **Two instances each have their own map.**

## Decision

- **The key is the payment intent, `senderVpa/nonce`,** taken from inside the signature: carriers
  cannot change it, and every copy of one payment shares it. A hash of the envelope is kept only as
  a fast path to answer exact copies of decided payments.
- **Two phases, in the database.**
  1. *Acquire* — one `INSERT … ON CONFLICT DO UPDATE` statement writes an `IN_PROGRESS` claim with a
     30-second lease, committed at once so every other delivery sees it. The conflict branch only
     wins when an earlier lease has expired.
  2. *Decide* — in **one transaction on one connection**: the ledger postings, the allowance spent,
     the receipt, and the claim marked `SETTLED` or `REJECTED`. All of it commits or none of it does.
- **Each acquire mints a holder id, and deciding requires it.** Found while writing a test: after a
  lease is taken over the claim is `IN_PROGRESS` again, so a guard on state alone would let a
  stalled delivery wake up and overwrite the new holder's decision.
- **Transient failures release the claim** and tell the bridge to keep its copy (`503`).
- **Decided claims are final.** Later copies get the original decision, marked as a replay.
- **Garbage never takes a claim.** Envelopes that cannot be opened are refused before acquiring, so
  a carrier cannot burn someone else's payment intent.
- **The journal's unique idempotency key is the backstop.** If the claim layer ever let a second
  posting through, the database refuses it.

## Consequences

- Re-sealing, concurrent delivery, crashes and restarts are handled by one mechanism, each covered by
  a test and a named scenario.
- It works across instances sharing a database.
- A crashed delivery delays a payment by up to one lease.
- Every delivery costs database round trips, including duplicates; the fingerprint fast path removes
  most of that for copies of decided payments.
- Claims, fingerprints and receipts are never deleted. Anything that sweeps them later must remove a
  claim and its receipt together.
