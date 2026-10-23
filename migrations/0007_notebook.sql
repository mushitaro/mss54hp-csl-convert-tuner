-- The experiment notebook: one per session, append-only, one row per entry.
--
-- Rows rather than a fourth blob on `sessions`, because two writers add to it independently — the
-- owner's device at SYNC, and the desk between drives — and a blob would make each of them replace
-- the other's additions. An entry's id is minted by its writer; INSERT OR IGNORE makes sending the
-- same entry twice a no-op, so neither writer ever has to know what the other has sent.
--
-- `owner` on every row and on every query, as on `sessions` (0006): a row is somebody's. The handler
-- adds an entry only to a session row the same owner already has.
--
-- `author` and not `by`: BY is a keyword. `body_json` is the entry's body as the writer sent it,
-- checked against src/lib/notebook/rules.ts before it is stored.

CREATE TABLE IF NOT EXISTS notebook_entries (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    owner       TEXT NOT NULL,
    at          INTEGER NOT NULL,
    author      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    body_json   TEXT NOT NULL,
    -- Server clock: when the store got it. What `since` reads, so a device asks only for what is new.
    stored_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS notebook_entries_session ON notebook_entries (owner, session_id, stored_at);
