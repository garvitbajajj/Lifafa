# Security policy

Lifafa is a research prototype. It is not meant to process real payments and has not had an
independent security review. [THREAT_MODEL.md](THREAT_MODEL.md) lists the gaps already known —
please read it first, so a report can focus on what it misses.

## Reporting a vulnerability

Please report privately, through GitHub's
[private vulnerability reporting](https://github.com/garvitbajajj/Lifafa/security/advisories/new),
rather than in a public issue.

The most useful report names the guarantee it breaks — "one payment can settle twice" — and the
smallest sequence of steps that shows it. A new entry in
`apps/server/src/scenarios/catalogue.js` is ideal, since that is how every existing defence is
demonstrated.

Confirmed issues are fixed together with a test or scenario that fails before the fix and passes
after it.

## Especially interesting

- One payment intent settling more than once, or money moving without a matching posting.
- Spending from an account without that account's registered device key.
- Reading or altering a sealed envelope without the settlement private key.
- An operator route answering without the operator token outside demo mode.
- A crash or restart after which a valid, fresh payment can never settle.

## Out of scope

Anything already under *Known limitations* in the threat model, unless it is worse than described
there; demo mode, which is insecure by design; denial of service by volume.
