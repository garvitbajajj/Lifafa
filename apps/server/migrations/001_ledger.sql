-- The double-entry ledger.
--
-- Balances are a cached projection of postings, not the source of truth. The source of truth is
-- the postings: every movement of money is a journal entry whose postings sum to zero, so money
-- cannot appear or vanish without a row that says where it came from.

CREATE TABLE accounts (
    vpa           TEXT PRIMARY KEY,
    holder_name   TEXT        NOT NULL,
    kind          TEXT        NOT NULL DEFAULT 'CUSTOMER',
    balance_paise BIGINT      NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT accounts_kind_known CHECK (kind IN ('CUSTOMER', 'HOUSE')),

    -- The database refuses an overdraft even if the application logic is wrong. The house account
    -- is the one place money is issued from, so it is allowed to go negative: its balance is the
    -- total money in circulation, owed by the operator.
    CONSTRAINT accounts_no_overdraft CHECK (kind = 'HOUSE' OR balance_paise >= 0)
);

-- One entry per decision. The unique idempotency key is the last line of defence behind the
-- claim layer: if a bug ever let one payment be settled twice, the second INSERT fails here
-- rather than moving money twice.
CREATE TABLE journal_entries (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key TEXT        NOT NULL UNIQUE,
    kind            TEXT        NOT NULL,
    memo            TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT journal_entries_kind_known CHECK (kind IN ('PAYMENT', 'GENESIS', 'TOPUP'))
);

CREATE TABLE postings (
    id           BIGSERIAL PRIMARY KEY,
    entry_id     BIGINT      NOT NULL REFERENCES journal_entries (id),
    vpa          TEXT        NOT NULL REFERENCES accounts (vpa),
    amount_paise BIGINT      NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A posting of zero moves nothing and only makes the ledger harder to read.
    CONSTRAINT postings_nonzero CHECK (amount_paise <> 0)
);

CREATE INDEX postings_entry_idx ON postings (entry_id);
CREATE INDEX postings_vpa_idx ON postings (vpa);

-- Money enters the system from here, so even issued money has a matching posting and the sum of
-- every posting in the database stays zero.
INSERT INTO accounts (vpa, holder_name, kind)
VALUES ('house@lifafa', 'House float', 'HOUSE');
