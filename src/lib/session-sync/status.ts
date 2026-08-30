/**
 * What the sync control says, in one place.
 *
 * There are two of them — the row in the menu sheet and the twin in the desktop header — and they
 * have to agree. Not for tidiness: they are the same control on two viewports, and a phone that
 * says "3 waiting" beside a desktop that says "all synced" would make the user distrust both. The
 * layouts differ, so the components stay separate; the *wording and the enabled-ness* come from
 * here, where they can only have one answer.
 *
 * Pure and React-free so the probe can assert on the strings without mounting anything.
 */

export type SyncPhase =
    /** No token anywhere — production, or a preview built without one. Nothing to press. */
    | 'unavailable'
    /** The interface is down. Reliable, unlike its opposite — see useOnline. */
    | 'offline'
    | 'busy'
    /** The last attempt failed. Stays pressable: retrying is the whole response to a dropped upload. */
    | 'error'
    /** Something is outstanding and there is a route to send it over. */
    | 'ready'
    /** Everything worth sending is up there, as it currently stands. */
    | 'clean';

export interface SyncStatus {
    phase: SyncPhase;
    /** Sessions that would go if this were pressed. */
    pending: number;
    /** The last failure's message, if the phase is 'error'. */
    error?: string;
}

export type SyncTone = 'ready' | 'error' | 'busy' | 'muted'
    /** Nothing outstanding, and that is a result rather than an absence — the palette's
     *  OK/verified role. Only SAVE uses it; SYNC's settled state is 'muted'. */
    | 'done';

export interface SyncLook {
    label: string;
    /** The hover/long-press explanation. Always says something — a disabled control that cannot
     *  explain itself is the one that gets reported as broken. */
    title: string;
    disabled: boolean;
    tone: SyncTone;
}

/**
 * The step BEFORE sync, and the reason the two now sit together.
 *
 * Saving writes the tune into this device's own database; syncing sends the sessions that have
 * changed since they were last sent. That has always been the design — `needsSync` compares a
 * fingerprint and only outstanding sessions go up — but the only labelled control was a cloud icon
 * reading "Store", which describes neither half and reads as "upload, now, directly". Naming both
 * steps and putting them next to each other is the whole fix.
 *
 * Same reasoning as SyncStatus for why this lives here: there are two of these controls (the
 * desktop session bar and the menu sheet) and they must not be able to disagree.
 */
export type SavePhase =
    /** A run has been recorded into this session and is already on the device. */
    | 'runRecorded'
    /** No session at all, or a session with nothing in it yet. */
    | 'nothing'
    /**
     * A BASE is loaded but no tune has been derived from it.
     *
     * Distinct from 'nothing' because the two are opposite reassurances. `setSessionBase` writes the
     * bytes to IndexedDB the instant a READ finishes, so a BASE-only session is **already saved** —
     * but the label for this state used to be "Save — nothing to record", which reads as "your data
     * is not stored". Reported from the car as SAVE and SYNC being dead with a freshly read VIN on
     * screen, which is exactly what that wording invites you to conclude.
     */
    | 'baseOnly'
    /**
     * A finished drive that produced no VE map, and is worth keeping anyway.
     *
     * The normal case now, not an edge one: an EGT run reads block 3 alone so its samples carry no
     * lambda trim, and an INERTIA run is not a VE log at all. Neither can move a single VE cell —
     * and the LOG is what those runs exist to collect.
     *
     * Distinct from 'ready' because what gets written is different: a research run has no TUNED
     * bytes and must not be given a sha256, or the session list starts offering a downloadable tune
     * that was never derived. Distinct from 'baseOnly' because there IS something unsaved here, and
     * saying "nothing further to save" over a drive that only exists in memory is the worst possible
     * thing this label could say.
     */
    | 'logOnly'
    /**
     * Saved, and nothing has changed since.
     *
     * The state that was missing, and its absence was the whole complaint: with a tune derived,
     * the phase was 'ready' for ever. The label never moved, the cell stayed pressable, and
     * pressing it wrote the same bytes again — so there was no way to tell a save that had
     * happened from one that had not (operator, 2026-08-24).
     *
     * `page.tsx` decides this by comparing a signature of everything that goes INTO the save
     * against the one recorded when it last succeeded. Anything that would change the bytes —
     * a filter, a toggle, another flush of the log — puts it back to 'ready'.
     */
    | 'saved'
    /** Archived sessions are read-only by design; their tune is already what was flashed. */
    | 'archived'
    /** A datalog is running. The map is still being rebuilt every few hundred ms. */
    | 'logging'
    | 'busy'
    | 'ready';

export interface SaveStatus {
    phase: SavePhase;
}

export interface SaveLook {
    label: string;
    title: string;
    disabled: boolean;
    tone: SyncTone;
}

/**
 * One word each, because this cell is 56px wide on a phone and its label is the only thing on it
 * that a touch device can read — `title` is a hover tooltip and there is no hover here.
 *
 * So: the two states that matter are the verbs SAVE and SAVED, and every state that CANNOT be
 * pressed says why in its own two words rather than borrowing the verb. "Save to session" was
 * neither — it named a destination nobody was choosing between, and it said it while lit, while
 * disabled, and while there was nothing left to do.
 */
export function describeSave({ phase }: SaveStatus): SaveLook {
    switch (phase) {
        case 'runRecorded':
            return {
                label: 'Saved',
                title: 'The run was written to this session the moment it stopped — the samples are on this '
                    + 'device already, so there is nothing for this button to do. It is disabled because the '
                    + 'work is done, not because the run was lost. SYNC is what sends it to the store; and if '
                    + 'a run ever fails to save, the line under the hub says so in red rather than leaving this '
                    + 'button to be guessed at.',
                disabled: true, tone: 'done',
            };
        case 'nothing':
            return {
                label: 'Nothing yet',
                title: 'Nothing has been loaded into this session yet. Read a BASE from the DME, or upload one, '
                    + 'and it is written to this device straight away.',
                disabled: true, tone: 'muted',
            };
        case 'baseOnly':
            return {
                label: 'Saved',
                title: 'The BASE was written to this device the moment it was read — there is nothing further to '
                    + 'save until a tune is derived from it. SYNC can send it to the store as it stands, which is '
                    + 'what to do if you want these bytes off the phone.',
                disabled: true, tone: 'done',
            };
        case 'logOnly':
            return {
                label: 'Save',
                title: 'This run produced no VE map — an EGT run carries no lambda trim, and an inertia run is '
                    + 'not a VE log — so there is no tune to record. The DRIVE is what it collected, and it only '
                    + 'exists in memory until this is pressed. Saved as a research run: no TUNED bytes, nothing '
                    + 'to flash.',
                disabled: false, tone: 'ready',
            };
        case 'archived':
            return {
                label: 'Archived',
                title: 'This session has been flashed and archived, so its stored tune is the one that went to '
                    + 'the ECU and must not change. Continue from it with "Use as base → TUNED".',
                disabled: true, tone: 'done',
            };
        case 'logging':
            return {
                label: 'After stop',
                title: 'A data log is running and the map is still being rebuilt from it. Saving now would record '
                    + 'a partial run as if it were a finished one. STOP first; the samples are already being '
                    + 'written to this device every 5 seconds, so nothing is at risk meanwhile.',
                disabled: true, tone: 'muted',
            };
        case 'busy':
            return { label: 'Saving…', title: 'Writing this tune into the device database.', disabled: true, tone: 'busy' };
        case 'saved':
            return {
                label: 'Saved',
                title: 'This tune is in this device\'s database and nothing has changed since it was '
                    + 'written — the same press would store the same bytes. Change a filter, a toggle or '
                    + 'the log and this offers the save again. SYNC is what sends it to the store.',
                disabled: true, tone: 'done',
            };
        case 'ready':
            return {
                label: 'Save',
                title: 'Writes this tune into THIS DEVICE\'s database — no cable and no network needed. '
                    + 'The label reads SAVED once it is written, and offers the save again as soon as '
                    + 'anything changes that would store different bytes. Sync afterwards to send it to '
                    + 'the store.',
                disabled: false, tone: 'ready',
            };
    }
}

const plural = (n: number) => (n === 1 ? '' : 's');

export function describeSync({ phase, pending, error }: SyncStatus): SyncLook {
    switch (phase) {
        case 'unavailable':
            return {
                label: 'Sync — not set up',
                title: 'This build carries no sync token, so there is nowhere to send sessions. '
                    + 'Production has no store at all; on a preview, enter a token in the session store.',
                disabled: true,
                tone: 'muted',
            };
        case 'offline':
            return {
                label: pending > 0 ? `Offline — ${pending} waiting` : 'Offline',
                title: pending > 0
                    ? `${pending} session${plural(pending)} will go up when this device is back on a network. `
                    + 'Nothing is lost meanwhile — the local database already has all of it.'
                    : 'No network. Nothing is waiting to go up.',
                disabled: true,
                tone: 'muted',
            };
        case 'busy':
            return {
                label: 'Syncing…',
                title: 'Sending sessions one at a time. Each one lands or reports why it did not.',
                disabled: true,
                tone: 'busy',
            };
        case 'error':
            return {
                label: `Sync failed — retry${pending > 0 ? ` (${pending})` : ''}`,
                title: error
                    ? `${error}\n\nPress to try again. A retry replaces rather than duplicates, so nothing doubles up.`
                    : 'Press to try again.',
                disabled: false,
                tone: 'error',
            };
        case 'ready':
            return {
                label: `Sync ${pending} session${plural(pending)}`,
                title: `Send ${pending} session${plural(pending)} to the store — the record, its log and its `
                    + 'BASE/TUNED bytes, exactly as this device holds them. The local copy stays.',
                disabled: false,
                tone: 'ready',
            };
        case 'clean':
            return {
                label: 'All sessions synced',
                title: 'Every session with a log or a tune is in the store as it currently stands.',
                disabled: true,
                tone: 'muted',
            };
    }
}
