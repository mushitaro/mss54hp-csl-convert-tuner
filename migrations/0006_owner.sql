-- Every row belongs to one account, and nobody else can see it.
--
-- Until now the store had one tenant: a developer, a shared token, and lists that returned
-- everything. The preview is now handed to MILE buyers and past owners through the owner gate
-- (functions/_middleware.ts), and a row holds a VIN, a DME image and that car's drive — so a row is
-- somebody's, and the handlers put `owner = ?` on every query. The owner is the account m3 resolved
-- for the request, never anything the client sent.
--
-- Nullable, not NOT NULL: SQLite cannot add a NOT NULL column without a default, and a default
-- owner would silently hand every future row that forgot one to that account. The rows already
-- here are the operator's own (the only person the shared token was ever given to), so they go to
-- the operator's account. The trigger then refuses a NULL owner on every insert from here on,
-- which is what NOT NULL would have said.
--
-- Before applying remotely: `wrangler d1 export mss54hp-tuner-runs --remote --output <outside git>`
-- and note the time-travel point; count rows before and after (they must match).

ALTER TABLE sessions ADD COLUMN owner TEXT;
ALTER TABLE diagnostics ADD COLUMN owner TEXT;

UPDATE sessions    SET owner = 'ac5c6c31-5137-4fd7-9b5d-ceb17f98027c' WHERE owner IS NULL;
UPDATE diagnostics SET owner = 'ac5c6c31-5137-4fd7-9b5d-ceb17f98027c' WHERE owner IS NULL;

CREATE TRIGGER IF NOT EXISTS sessions_owner_required
BEFORE INSERT ON sessions
WHEN NEW.owner IS NULL
BEGIN
    SELECT RAISE(ABORT, 'sessions.owner is required');
END;

CREATE TRIGGER IF NOT EXISTS diagnostics_owner_required
BEFORE INSERT ON diagnostics
WHEN NEW.owner IS NULL
BEGIN
    SELECT RAISE(ABORT, 'diagnostics.owner is required');
END;

-- The list queries are now "this owner's, most recent first". The old created_at indexes stay:
-- the desk-side readers (db:sessions, db:diagnostics) still read across owners.
CREATE INDEX IF NOT EXISTS sessions_owner_created_at    ON sessions    (owner, created_at DESC);
CREATE INDEX IF NOT EXISTS diagnostics_owner_created_at ON diagnostics (owner, created_at DESC);
