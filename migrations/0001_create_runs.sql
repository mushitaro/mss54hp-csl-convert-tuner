-- Runs uploaded from a phone in a car.
--
-- One row per data-log run. The log itself is stored as the same CSV the app already exports,
-- gzipped — not as a table of samples. Two reasons, and the second is the load-bearing one:
--
--   1. A run is written once and read whole. There is no query that wants one sample.
--   2. The CSV is what `parseLogFile` reads. Storing the app's own interchange format means a
--      downloaded run re-imports without a second decoder to keep in step with the first, and it
--      is still readable by anything else if this table outlives the app.
--
-- D1 caps a single value at 1,000,000 bytes. A 20-minute run at 10 Hz is ~12k rows, ~700 KB of
-- CSV, ~100 KB gzipped, so the cap is far away — but the API checks rather than trusts that,
-- because the failure it prevents is a silently truncated log that still parses.

CREATE TABLE IF NOT EXISTS runs (
    -- Minted by the client so a retry after a dropped connection is idempotent. A phone in a
    -- garage loses signal mid-upload often enough that this is not a hypothetical.
    id            TEXT PRIMARY KEY,

    -- Both clocks, deliberately. The phone's is what the driver will recognise; the server's is
    -- the one that is monotonic across devices. They disagree, and picking one loses information.
    created_at    INTEGER NOT NULL,          -- ms epoch, server
    client_time   INTEGER,                   -- ms epoch, phone

    label         TEXT NOT NULL,
    notes         TEXT,

    -- What the log was taken against. Without these a run is a pile of numbers: the same drive
    -- means different things depending on which bytes were in the ECU at the time.
    vin           TEXT,
    base_file_name TEXT,
    software_version TEXT,
    rf_korr_mode  TEXT,                      -- nominal | as-logged | tuned
    patch_on      INTEGER,                   -- 1 if the log was recorded with MAP compensation off

    point_count   INTEGER NOT NULL,
    average_hz    REAL,
    duration_s    REAL,
    -- Which channels the run actually carries. Cheap to store, and it is the first question asked
    -- of any run now that the EGT correction work depends on two optional columns.
    has_rf        INTEGER NOT NULL DEFAULT 0,
    has_egt       INTEGER NOT NULL DEFAULT 0,

    csv_gz        BLOB NOT NULL,
    csv_bytes     INTEGER NOT NULL,          -- uncompressed, so the UI can show a size without inflating
    app_version   TEXT
);

-- The list view is "most recent first", and nothing else. One index, matching one query.
CREATE INDEX IF NOT EXISTS runs_created_at ON runs (created_at DESC);
