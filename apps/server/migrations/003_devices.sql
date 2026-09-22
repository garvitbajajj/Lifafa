-- Which device may pay from which account, and how much it may spend while offline.

CREATE TABLE devices (
    device_id      TEXT PRIMARY KEY,
    vpa            TEXT        NOT NULL REFERENCES accounts (vpa),
    -- The raw Ed25519 public key, base64. The device id is derived from it, so a device cannot
    -- register under someone else's id.
    public_key     TEXT        NOT NULL,
    state          TEXT        NOT NULL DEFAULT 'ACTIVE',
    registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at     TIMESTAMPTZ,
    revoked_reason TEXT,

    CONSTRAINT devices_state_known CHECK (state IN ('ACTIVE', 'REVOKED'))
);

CREATE INDEX devices_vpa_idx ON devices (vpa);

-- The bound on what one device can spend without the service seeing it.
--
-- Offline double-spend cannot be prevented without trusted hardware on the phone: a payer with no
-- signal can sign two payments against the same balance, and both are valid. So the loss is
-- bounded instead. The allowance is consumed as payments settle and can only be refilled by an
-- operator, which in practice means while the device is online and its account has been checked.
CREATE TABLE offline_envelopes (
    device_id             TEXT PRIMARY KEY REFERENCES devices (device_id),
    allowance_paise       BIGINT      NOT NULL,
    per_payment_cap_paise BIGINT      NOT NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT offline_allowance_not_negative CHECK (allowance_paise >= 0),
    CONSTRAINT offline_cap_within_allowance CHECK (per_payment_cap_paise > 0)
);

-- Every sequence number a device has used, and which payment used it.
--
-- Gaps are fine: in a mesh, some envelopes never arrive. What is not fine is the same number
-- used for a different payment, which means the key was copied or the app was modified.
CREATE TABLE device_sequences (
    device_id       TEXT        NOT NULL REFERENCES devices (device_id),
    sequence_no     BIGINT      NOT NULL,
    idempotency_key TEXT        NOT NULL,
    seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (device_id, sequence_no)
);

-- The signed answer for each decided payment, kept whether or not it ever reaches the payer.
CREATE TABLE receipts (
    idempotency_key  TEXT PRIMARY KEY,
    outcome          TEXT        NOT NULL,
    reason           TEXT        NOT NULL DEFAULT '',
    journal_entry_id BIGINT,
    decided_at       TIMESTAMPTZ NOT NULL,
    -- The canonical receipt bytes and the service's signature over them, base64.
    receipt_bytes    TEXT        NOT NULL,
    signature        TEXT        NOT NULL,
    delivered        BOOLEAN     NOT NULL DEFAULT false,

    CONSTRAINT receipts_outcome_known CHECK (outcome IN ('SETTLED', 'REJECTED'))
);

CREATE INDEX receipts_undelivered_idx ON receipts (delivered) WHERE delivered = false;
