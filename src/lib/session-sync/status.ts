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

export type SyncTone = 'ready' | 'error' | 'busy' | 'muted';

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
    /** No session, or a session with no derived map — there is no tune to record. */
    | 'nothing'
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

export function describeSave({ phase }: SaveStatus): SaveLook {
    switch (phase) {
        case 'nothing':
            return {
                label: 'Save — nothing to record',
                title: 'Saving records a derived tune against the open session. With only a BASE loaded there '
                    + 'is nothing to record — the BASE was already stored when it was chosen.',
                disabled: true, tone: 'muted',
            };
        case 'archived':
            return {
                label: 'Saved — archived',
                title: 'This session has been flashed and archived, so its stored tune is the one that went to '
                    + 'the ECU and must not change. Continue from it with "Use as base → TUNED".',
                disabled: true, tone: 'muted',
            };
        case 'logging':
            return {
                label: 'Save — after the run',
                title: 'A data log is running and the map is still being rebuilt from it. Saving now would record '
                    + 'a partial run as if it were a finished one. STOP first; the samples are already being '
                    + 'written to this device every 5 seconds, so nothing is at risk meanwhile.',
                disabled: true, tone: 'muted',
            };
        case 'busy':
            return { label: 'Saving…', title: 'Writing this tune into the device database.', disabled: true, tone: 'busy' };
        case 'ready':
            return {
                label: 'Save to session',
                title: 'Writes this tune into THIS DEVICE\'s database — no cable and no network needed. '
                    + 'Sync afterwards to send what has changed to the store.',
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
