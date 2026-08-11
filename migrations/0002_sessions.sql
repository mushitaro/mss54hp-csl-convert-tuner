-- Sessions, stored the way the local database already holds them.
--
-- Replaces the `runs` table, which invented a second data model: a session was re-encoded into a
-- CSV plus a dozen hand-picked metadata columns, and the mapping between that and a TuningSession
-- was a thing to keep in step forever. There is no reason for it. The app already has a complete
-- record of a session in three IndexedDB stores; this is those three stores, gzipped.
--
-- What that buys, beyond less code: a session can come BACK. The old table could only give you a
-- CSV, which is a log and nothing else — not the BASE it was recorded against, not the tune, not
-- the filter settings that produced it. A session that round-trips is a session you can record on
-- a phone and finish at a desk.
--
-- Three blobs rather than one, because D1 caps a single value at 1,000,000 bytes and the log is
-- much the largest of them. Splitting gives each its own budget instead of making a long drive
-- compete with the binaries for one.

DROP TABLE IF EXISTS runs;

CREATE TABLE IF NOT EXISTS sessions (
    -- The session's own id, so a re-sync updates rather than duplicates. A phone in a garage drops
    -- uploads often enough that this is the normal path, not the exceptional one.
    id            TEXT PRIMARY KEY,

    -- Server clock. The session record carries its own createdAt; this is when it reached here.
    synced_at     INTEGER NOT NULL,

    -- Enough to list without inflating anything. Everything here is a copy of a field inside
    -- session_json — denormalised on purpose, because the list view must never decompress.
    label         TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    status        TEXT,
    vin           TEXT,
    point_count   INTEGER NOT NULL DEFAULT 0,
    has_tune      INTEGER NOT NULL DEFAULT 0,
    has_rf        INTEGER NOT NULL DEFAULT 0,
    has_egt       INTEGER NOT NULL DEFAULT 0,

    -- The three stores, each gzipped JSON. `binaries_json_gz` holds the two 64 KB images base64'd;
    -- gzip takes most of that back, and keeping them here is what makes a restore a real restore.
    session_json_gz  BLOB NOT NULL,
    log_json_gz      BLOB,
    binaries_json_gz BLOB,

    -- Which build sent it. The service worker's cache name — a content hash, so it changes exactly
    -- when the build does. See buildIdentity() in the client.
    app_build     TEXT
);

CREATE INDEX IF NOT EXISTS sessions_created_at ON sessions (created_at DESC);
