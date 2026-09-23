# Threat model

What Lifafa defends against, how, and the test that proves each defence — and, just as
important, what it does **not** defend against. It is a research prototype: nothing here is a
claim that it is safe to move real money with it.

## Assets

| Asset | Why it matters |
|---|---|
| Account balances and the journal | They are the money |
| Settlement X25519 private keys | Whoever holds them can read every envelope ever sealed to them |
| Receipt-signing Ed25519 key | Whoever holds it can forge settlement receipts |
| Device Ed25519 private keys | Whoever holds one can spend from the bound account, up to its offline allowance |
| Operator token | Opens accounts, funds them, registers devices, rotates keys |
| Bridge API keys | Allow delivering envelopes, and spend that bridge's rate-limit budget |
| Payment metadata | Who paid whom, how much and when — private even when the money is safe |

## Who we assume is hostile

| Actor | Assumed capability |
|---|---|
| **Carrier** — any phone in the mesh | Stores, drops, delays, duplicates, reorders, replays and bit-flips envelopes. Sees their size and timing. |
| **Malicious bridge** | Everything a carrier can do, plus deliver at will, fast, from many bridges at once |
| **Dishonest payer** | Holds a valid device key. Tries to spend the same money twice while offline, or more than they have |
| **Impersonator** | Knows the service's public key and victims' VPAs, but not their device keys |
| **Unauthenticated client** | Can reach the service's HTTP port |
| **Crashes and restarts** | Not an adversary, but the commonest way payment systems lose money |

---

## Threats and defences

### Carriers and bridges

| Threat | Defence | Evidence |
|---|---|---|
| Read the payment | HPKE (RFC 9180) to the service's X25519 key, AES-256-GCM. The payer's signature is *inside* the ciphertext, so carriers cannot even see who is paying | `sealer.test.js` checks the sealed bytes contain neither VPA nor the nonce |
| Alter amount or payee | AES-GCM tag over the ciphertext; the header is associated data, so the version, suite and key id cannot be rewritten either | `sealer.test.js` flips every ciphertext bit; `tamper-envelope` |
| Deliver one envelope many times, concurrently | Durable claim on the payment intent. One delivery decides; others get `202` or a replay of that decision | `ingest.test.js` (eight bridges at once); `duplicate-storm` |
| Re-seal one payment so every byte differs | The idempotency key is `senderVpa/nonce`, inside the signature — not a hash of the ciphertext | `reseal-retry` |
| Replay a stored envelope | Refused past the payer's `expiresAt` or a 6-hour maximum age, whichever is tighter, with 5 minutes of clock skew. Within the window a replay returns the decision already made | `replay-expired`; `ingest.test.js` |
| Send garbage to burn someone's payment | Envelopes that cannot be opened are refused *before* a claim is taken | `ingest.test.js` "garbage never consumes a payment intent" |
| Flood the ingest endpoint | Per-bridge credentials and a per-bridge rate limit, so one bridge cannot starve the others | `api.test.js` |
| **Drop or delay envelopes** | **Not defended.** A carrier can always refuse to carry. The payer gets no receipt and can pay another way once online. Expiry bounds how long a delayed envelope stays valid | — |

### Impersonation and dishonest payers

| Threat | Defence | Evidence |
|---|---|---|
| Pay from someone else's account | Ed25519 device signature, and the device key must be registered, active and bound to the sender VPA. The device id is derived from the key, so it cannot be claimed | `forge-sender`, `wrong-account` |
| Spend one balance twice offline | **Bounded, not prevented.** Per-device offline allowance (₹2,000), refilled only by an operator, plus a per-payment cap (₹500). The balance is still checked at settlement | `double-spend`, `over-cap`, `allowance-exhausted` |
| Use a copied device key | One sequence number used for two different payments revokes the device | `double-spend`, `revoked-device` |

Offline double-spend cannot be prevented without trusted hardware on the payer's phone. The design
goal is that the worst case is a known, small number per device. See
[ADR 0005](docs/adr/0005-bounded-offline-risk.md).

### The service itself

| Threat | Defence | Evidence |
|---|---|---|
| Crash after claiming, before deciding | The claim has a 30-second lease; the next delivery takes it over once it expires. Transient failures release it at once | `crash-mid-settle`; `claims.test.js` |
| A stalled delivery wakes up after a takeover | Each acquire mints a holder id and deciding requires it, so the stale holder cannot overwrite the new holder's decision | `claims.test.js` |
| Money moves but the decision is lost, or vice versa | Postings, allowance, receipt and decision commit in one transaction on one connection | `claims.test.js`, `ingest.test.js` |
| A bug posts one payment twice | Unique constraint on the journal's idempotency key refuses the second entry | `ledger.test.js` |
| Concurrent payments race into an overdraft | Accounts are locked in sorted order before any balance is read; a database `CHECK` refuses a negative customer balance | `ledger.test.js` races twelve payments against a balance that covers ten |
| Ledger drift | Double-entry postings in integer paise; the invariant check re-derives every balance from its postings | Every scenario and every database test file ends with it |
| Restart strands envelopes in flight | Keys persist in the database; rotation adds a key rather than replacing one | `key-rotation`; `api.test.js` |
| Operator routes exposed | Every operator route, reads included, requires `X-Admin-Token`, compared in constant time. Outside demo mode the service refuses to start without a token of at least 24 characters | `api.test.js` |
| Demo routes reachable in production | The demo mesh — which signs payments for demo phones — is mounted only in demo mode | `api.test.js` |
| Stored XSS via a VPA | VPAs are validated at the protocol boundary; React escapes everything it renders | `instruction.test.js` |

---

## Known limitations

Real gaps, not features in waiting. Each would need closing before this handled real money.

### Cryptography

- **No forward secrecy.** The payer's ephemeral key is thrown away, but the shared secret is equally
  computable from the service's long-term private key and the ephemeral public key in the envelope.
  Anyone who records envelopes and later obtains a settlement key can read them. A payer with no
  connectivity cannot run an interactive key exchange, so this is inherent to the setting; the
  mitigation is to rotate keys and destroy retired ones.
- **Retired keys are never destroyed.** Rotation works and `server_keys` has a `retired_at` column,
  but nothing sets it, so every key ever generated is kept — which makes the point above worse over
  time.
- **Standards-conformant, not reviewed.** The envelope is RFC 9180 HPKE base mode and reproduces
  every intermediate value in the RFC's appendix A.1 test vectors. No cryptographer has reviewed the
  code, and no other HPKE implementation has interoperated with it. A vetted library is the right
  choice for real money.
- **Keys live in the database.** Anyone who can read `server_keys` can read every envelope sealed to
  those keys. A real deployment keeps them in a key management service or HSM.
- **Metadata is visible.** Carriers see envelope size, timing and which neighbour handed it over.

### Identity and authorisation

- **No KYC and no proof of possession at registration.** An operator can bind any public key to any
  VPA; the device never proves it holds the matching private key.
- **Device keys are in software**, because the phones are simulated. A key extracted from a real
  phone spends up to its offline allowance before revocation can reach the service.
- **One shared operator token.** No per-operator identity, roles, or audit of who did what, and
  rotating it means a restart.
- **Static bridge keys.** Stored as SHA-256 hashes and shown once, but with no expiry or rotation.

### Operations

- **No TLS in the process.** Put the service behind a reverse proxy that terminates TLS, or tokens
  and bridge keys cross the network in clear.
- **The rate limit is per instance.** Two instances behind a load balancer give each bridge twice
  its budget.
- **Nothing is swept.** Claims, fingerprints, ingest attempts and receipts grow without bound.
  Anything that sweeps them must remove a claim and its receipt together.
- **Receipts are not delivered.** They are signed and stored, but nothing carries them back through
  the mesh; the payer learns the outcome only once online.
- **Demo mode is insecure by design.** It signs payments for demo phones and leaves operator routes
  open. Never run a real deployment with `--demo`.

### Out of scope

The Android app, Bluetooth transport, UPI PIN and secure element; integration with NPCI, banks or
any real UPI rail; regulatory limits, disputes, chargebacks and refunds; denial of service beyond
per-bridge rate limiting.
