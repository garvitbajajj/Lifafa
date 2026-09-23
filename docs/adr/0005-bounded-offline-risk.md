# 0005 — Bound offline double-spend instead of pretending to prevent it

**Status:** Accepted

## Context

A payer with ₹1,000 and no signal can sign ₹1,000 to one payee and ₹1,000 to another. Both are
valid. Whichever arrives first settles; the second is refused, and that payee handed over goods for
nothing. Nothing but trusted hardware on the phone can stop a payer from signing more than they have.

## Decision

Accept that it can happen, and **bound the loss per device** to a number an operator chooses.

- **An offline allowance** (₹2,000 by default), consumed as payments settle and refilled only by an
  operator — in practice, while the phone is online and the account has been checked. The spend is
  a conditional `UPDATE … WHERE allowance_paise >= amount`, so two racing payments cannot both pass.
- **A per-payment cap** (₹500 by default), which may not exceed the allowance.
- **The balance is still checked at settlement.** The allowance bounds exposure; it is not money.
- **Sequence numbers catch copied keys.** Each instruction carries a per-device sequence number. The
  same number used for a *different* payment means a cloned key or a modified app, and the device is
  revoked on the spot. Gaps are allowed, because some envelopes never arrive.
- **Refusals are decisions.** Over the cap, out of allowance, no funds, revoked device: the claim is
  marked `REJECTED`, a receipt is issued, and the bridge drops the envelope.

## Consequences

- The worst case is known: a dishonest device leaves at most its allowance unpaid, and no single
  payee loses more than the cap.
- Honest payers are limited offline even with a large balance. That is the price of the bound.
- The allowance is spent at settlement, not at signing, because the service never sees signing.
  Signed but undelivered envelopes are exposure the service learns about only when they arrive; the
  cap and the expiry window limit it.
- A clone that never reuses the original's sequence numbers is not caught by this check.
