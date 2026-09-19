# Lifafa

**Offline UPI payments carried over a mesh of nearby phones, settled exactly once.**

*Lifafa* (लिफ़ाफ़ा) is an envelope. A payer with no signal seals a payment into an envelope only
the settlement service can open, hands it to whatever phone is nearby, and it hops from phone to
phone until one of them reaches the internet and delivers it.

This is the **PERN** version — PostgreSQL, Express, React, Node, in TypeScript. The original Java
and Spring Boot implementation is at
[garvitbajajj/Lifafa1.0](https://github.com/garvitbajajj/Lifafa1.0).

## The three problems this solves

1. **A stranger carrying my payment must not be able to read or change it.** Every payment is
   signed by the payer's device and sealed with RFC 9180 HPKE (X25519 + AES-256-GCM) to the
   settlement service. Carriers see opaque bytes.
2. **Several carriers delivering the same payment must not pay it several times.** The service
   settles each *payment intent* — sender plus nonce, from inside the signature — exactly once.
3. **Someone who stores my envelope must not be able to exploit it later.** They cannot read it,
   a replay returns the decision already made, and every envelope expires.

## Status

Being built in stages, each proven before the next starts.

| Stage | What | State |
|---|---|---|
| 1 | Protocol: envelope format and cryptography | Done — 50 tests, including the RFC 5869 and RFC 9180 test vectors |
| 2 | Settlement: PostgreSQL schema, durable claims, double-entry ledger | Next |
| 3 | API, mesh simulation, attack scenarios, React dashboard | Planned |

## Layout

| Path | What |
|---|---|
| `packages/protocol` | The envelope and its cryptography. No dependencies beyond `node:crypto`, so it could run on a phone. |

## Running the tests

Requires Node.js 22 or newer.

```bash
npm install
npm run check
```

`check` runs the TypeScript compiler and the test suite.

## Licence

[MIT](LICENSE).
