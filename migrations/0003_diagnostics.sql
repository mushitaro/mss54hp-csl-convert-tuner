-- Link diagnostics: what one read, write or datalog actually did.
--
-- Separate from `sessions` rather than a column on it, and that is the load-bearing decision here.
-- A session is the user's work and is synced when they press a button; a diagnostic is a record of
-- one operation, uploads itself, and is most valuable for the operations that FAILED — which are
-- exactly the ones that never produce a session worth syncing. Hanging these off a session would
-- mean the flash that died at chunk 300 on an already-erased ECU had nowhere to be written down.
--
-- One row per operation. The payload is the whole DiagnosticRecord gzipped: the per-exchange timing
-- report (medians, sampled byte-arrival gaps) plus the phase-level event log. Everything above it
-- is denormalised out of that payload so the list view can rank a sweep without inflating a single
-- row — the same rule the sessions table follows, for the same reason.
--
-- Size: a 538-exchange write report with ten sampled traces is tens of KB of JSON and single-digit
-- KB gzipped, so D1's 1,000,000-byte per-value cap is far away. R2 is deliberately NOT used here:
-- it would buy nothing but a second store to keep in step, and a diagnostic that is too big to
-- store is a diagnostic that has stopped being a summary.

CREATE TABLE IF NOT EXISTS diagnostics (
    -- Minted by the client so a retry after a dropped connection replaces rather than duplicates.
    id            TEXT PRIMARY KEY,

    -- Both clocks, deliberately. The phone's is what the driver will recognise; the server's is the
    -- one that is monotonic across devices. They disagree, and picking one loses information.
    synced_at     INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,

    -- 'read' | 'write' | 'log'. A read's median turnaround is the DME thinking; a write's is the
    -- DME programming flash cells. Same column, different physics — so nothing may be compared
    -- across kinds, and the kind has to be in the row rather than inferred from the numbers.
    kind          TEXT NOT NULL,

    -- A failed run is the most valuable kind, so it is stored with the same weight as a clean one.
    -- `error` is the message verbatim, including any latched transport-error name, which is what
    -- separates a receive overrun from a physical-layer fault from a silent DME.
    completed     INTEGER NOT NULL,
    error         TEXT,

    -- Which car, which cable, and whether this was PRACTICE. A mock run's numbers are its own
    -- delay() calls; a listing that mixed them in with real ones would be worse than no listing.
    vin           TEXT,
    transport     TEXT,
    mock          INTEGER NOT NULL DEFAULT 0,
    session_id    TEXT,

    -- The numbers a sweep is actually read by. `requested_baud` is stored beside `baud` because a
    -- refused switch silently falls back: without both, four candidate rates all read as "9600" and
    -- there is no way to tell whether the ECU refused them or the app never asked.
    exchanges     INTEGER NOT NULL DEFAULT 0,
    elapsed_ms    INTEGER NOT NULL DEFAULT 0,
    baud          INTEGER,
    requested_baud INTEGER,
    median_turnaround REAL,
    median_total  REAL,
    -- Time between exchanges — us, and nothing else. ~0 on a bulk read; on the datalog it is where
    -- the VE recalculation lands, and on Android it is the number that says how close the read loop
    -- is to overrunning the FT232R's 256-byte FIFO.
    median_host_gap REAL,

    payload_gz    BLOB NOT NULL,
    app_build     TEXT
);

-- The list view is "most recent first", and nothing else. One index, matching one query.
CREATE INDEX IF NOT EXISTS diagnostics_created_at ON diagnostics (created_at DESC);
