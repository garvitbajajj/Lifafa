-- The claim on a payment intent.
--
-- One row per payment, ever. The first delivery to arrive inserts it and holds a short lease;
-- every other copy of that payment finds the row already there. When the payment is decided the
-- row records the decision, so later copies are answered with what was decided rather than
-- settled again.
--
-- In the database rather than in memory, because the two things that break in-memory
-- deduplication are exactly the two things that happen here: the process restarts, and there is
-- more than one of it.

CREATE TABLE idempotency_claims (
    idempotency_key  TEXT PRIMARY KEY,
    state            TEXT        NOT NULL,
    -- Who holds the claim right now. A new value on every acquire, including a takeover, so a
    -- delivery whose lease expired cannot come back to life and overwrite the decision made by
    -- whoever took over from it.
    holder           TEXT,
    -- While IN_PROGRESS: when this claim goes stale, so a crash cannot strand the payment
    -- forever. NULL once decided, because a decision does not expire.
    lease_expires_at TIMESTAMPTZ,
    journal_entry_id BIGINT      REFERENCES journal_entries (id),
    reason_code      TEXT,
    reason           TEXT,
    claimed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at       TIMESTAMPTZ,

    CONSTRAINT claims_state_known CHECK (state IN ('IN_PROGRESS', 'SETTLED', 'REJECTED')),
    CONSTRAINT claims_settled_has_entry CHECK (state <> 'SETTLED' OR journal_entry_id IS NOT NULL),
    CONSTRAINT claims_rejected_has_reason CHECK (state <> 'REJECTED' OR reason_code IS NOT NULL)
);

-- For finding claims whose lease has run out.
CREATE INDEX claims_lease_idx ON idempotency_claims (state, lease_expires_at);

-- A hash of the exact bytes of an envelope, mapped to the payment it carried.
--
-- Only a fast path: an identical copy of an envelope already decided can be answered without
-- decrypting it again. It is NOT how payments are deduplicated - re-sealing one payment produces
-- different bytes and a different fingerprint, which is why the claim above is keyed on the
-- payment intent instead.
CREATE TABLE envelope_fingerprints (
    fingerprint     TEXT PRIMARY KEY,
    idempotency_key TEXT        NOT NULL,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every delivery, decided or not. An operator asking "did that envelope ever arrive, and what
-- happened to it" needs an answer that does not depend on log retention.
CREATE TABLE ingest_attempts (
    id             BIGSERIAL PRIMARY KEY,
    fingerprint    TEXT        NOT NULL,
    bridge_node_id TEXT        NOT NULL DEFAULT '',
    outcome        TEXT        NOT NULL,
    detail         TEXT        NOT NULL DEFAULT '',
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ingest_attempts_received_idx ON ingest_attempts (received_at DESC);
