-- Bridges, and the service's own keys.

-- A phone with connectivity that delivers envelopes. Credentials are per bridge, so one
-- misbehaving bridge can be throttled or cut off without affecting the others.
CREATE TABLE bridge_nodes (
    node_id        TEXT PRIMARY KEY,
    -- SHA-256 of the API key. The key itself is shown once, at registration, and never stored:
    -- a database copy should not be enough to deliver envelopes as this bridge.
    api_key_sha256 TEXT        NOT NULL,
    registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ
);

-- The X25519 keys envelopes are sealed to.
--
-- Kept in the database rather than on disk so the service can be redeployed, or run in more than
-- one place, without the keys being lost or copied around by hand. Whoever can read this table
-- can read every envelope sealed to these keys, which is why a real deployment puts them in a
-- key management service instead.
CREATE TABLE server_keys (
    key_id      INTEGER PRIMARY KEY,
    private_key TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at  TIMESTAMPTZ
);

-- The Ed25519 key the service signs receipts with. One row, named, so other service keys can
-- join it later without a schema change.
CREATE TABLE service_keys (
    name       TEXT PRIMARY KEY,
    seed       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
