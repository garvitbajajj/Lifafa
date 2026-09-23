# 0006 — PostgreSQL through plain SQL, in plain JavaScript

**Status:** Accepted

## Context

Every guarantee in [ADR 0003](0003-claim-the-payment-intent.md) and
[ADR 0004](0004-double-entry-ledger-in-paise.md) rests on a few database features used precisely:
transactions, row locks, `ON CONFLICT`, unique keys and `CHECK` constraints. The choice of database
and of how code reaches it decides whether those guarantees are easy to get right.

## Decision

- **PostgreSQL.** ACID transactions, `SELECT … FOR UPDATE`, conditional upserts and constraints are
  exactly what exactly-once settlement needs. A document store can do transactions, but a
  double-entry ledger is relational data and the locking would be fought rather than used.
- **Plain SQL through `pg`, no ORM.** The statements that matter — the claim's single upsert, locks
  taken in sorted order, the conditional allowance spend — are the ones an ORM makes awkward or hides.
  They are short, and reading them is reading the guarantee.
- **One connection per transaction.** `pool.query()` takes any free connection, so a `BEGIN`, an
  `INSERT` and a `COMMIT` sent through the pool can land on three connections — no transaction at
  all, and nothing warns you. Everything atomic goes through `withTransaction`, which holds one
  client for the whole transaction.
- **Its own schema.** Every table lives in `lifafa`, so the database can be shared. On Supabase that
  also keeps the tables out of the auto-generated API, which exposes only `public`.
- **Migrations are plain SQL files**, applied in order, each in its own transaction.
- **Plain JavaScript, no build step.** The code that runs is the code in the repository. JSDoc
  describes the shapes a reader needs, such as the payment instruction and the open result.
- **Tests run against real PostgreSQL.** With `DATABASE_URL` set they use it; otherwise they start a
  throwaway PostgreSQL process, so the suite runs offline with nothing installed and no container.

## Consequences

- The concurrency guarantees are tested against the real thing, not a mock.
- Anyone reading the ledger or claim code reads the SQL that enforces it.
- Without a compiler, type mistakes surface at runtime. The tests and the validation at every
  boundary are what catch them.
