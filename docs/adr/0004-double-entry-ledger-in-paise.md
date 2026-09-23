# 0004 — A double-entry ledger in integer paise

**Status:** Accepted

## Context

A balance updated in place has no audit trail: money can change with no record of why, and nothing
can check afterwards that none was created or destroyed. Floating point anywhere near money rounds,
and a ledger that rounds leaks.

## Decision

- **Amounts are integers in paise.** ₹500 is `50000`. No decimals, no rounding.
- **Every movement is a journal entry whose postings sum to zero.** A payment debits the payer and
  credits the payee in one entry.
- **Money enters from a house account,** so even funding has a matching posting and the sum of every
  posting in the database stays zero.
- **Balances are a cached projection** of postings, updated in the same transaction.
- **Accounts are locked in sorted order** (`SELECT … ORDER BY vpa FOR UPDATE`) before any balance
  is read, so two opposite payments cannot deadlock and concurrent payments cannot both pass the
  same balance check.
- **The database enforces what matters most:** a `CHECK` refuses a negative customer balance, a
  `CHECK` refuses a zero posting, and a unique key refuses a second entry for one payment. A bug in
  the application cannot get past them.
- **An invariant check re-derives every balance from its postings,** and every database test file
  and every attack scenario ends by running it.

## Consequences

- Money cannot move without an entry saying why, and drift between balances and postings is
  detected rather than invisible.
- `pg` returns `BIGINT` as a string, because it can exceed JavaScript's safe range. It is parsed to a
  number once, centrally, and throws if a value is ever unsafe — otherwise `"50000" + 25000` is
  `"5000025000"`.
- The house account's balance is negative by the total money issued. Correct accounting, but
  surprising the first time.
- The invariant check scans every posting: fine for a prototype, and would need checkpoints at volume.
