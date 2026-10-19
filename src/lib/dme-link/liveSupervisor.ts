/**
 * The datalog's poll loop, and what it does when the link drops in the middle of a drive.
 *
 * ## Why a run no longer ends on a link failure
 *
 * Until 2026-10-19 the first poll that failed past its own retries ended the run: `finishLog`
 * disconnected, the dialog said to key-cycle, and the rest of the drive went unrecorded. On an
 * unstable cable that is the common ending (see finishLog in page.tsx), and in the setup this is
 * written for — the app on an Android head unit, the driver talking to an assistant on a phone —
 * nobody taps CONNECTION at speed. A run that stops recording at the first connector wobble loses
 * most of the drive.
 *
 * So the loop reconnects in place: the same link object, the same cable reopened without the
 * picker (`DmeLink.reconnect`), the same run. What it must NOT do is end the run in any way the
 * caller would read as "the log finished", because finishLog is where WRITE becomes reachable.
 * While this loop is reconnecting the run is still a run: the hook stays in 'tuning', STOP is what
 * the hub offers, and nothing the gap does can arm a write.
 *
 * ## What it promises about the samples
 *
 * The first sample after a gap carries `linkGapS`: the seconds since the last sample before it.
 * That is the stretch nothing was recorded for, stated once, on the sample that ends it. The log
 * says where it was blind, and the filter (LINK_GAP_HOLDOFF_S) drops the samples whose comparisons
 * would reach across it.
 *
 * ## When it gives up
 *
 * After `budgetMs` without the link back. It then returns the failure the way the old loop did,
 * and finishLog runs exactly as it always has: that ending is still the right one when the car has
 * really gone away (ignition off, a DME that stopped answering). A DIFFERENT DME answering the
 * reconnect ends the run at once — two cars in one log is not a gap.
 *
 * Pure: no React, no timers of its own, the clock and the sleep injectable. `verify:link-reconnect`
 * drives it against a scripted link.
 */
import type { DmeIdentity, LiveMeasurement } from './types';

/** What a sample carries besides the measurement. Only ever set on the first sample after a gap. */
export interface LiveSampleMeta {
    /** Seconds since the last sample before the link was lost — the stretch with no samples. */
    linkGapS?: number;
}

export type LinkGapEvent =
    /** The poll failed past its own retries, and the run is reconnecting. */
    | { kind: 'lost'; error: string }
    /** One reconnect attempt failed; another follows unless the budget is spent. */
    | { kind: 'retrying'; attempt: number; error: string; elapsedMs: number }
    /**
     * The link is back; the next sample continues the run. `elapsedMs` is the reconnect's own time;
     * `blindMs` runs from the last sample handed on, so it also counts the retries the failed poll
     * spent before it gave up — the stretch the log really has nothing for.
     */
    | { kind: 'resumed'; attempts: number; elapsedMs: number; blindMs: number }
    /** The run is ending: the budget is spent, or a different DME answered. */
    | { kind: 'gaveUp'; attempts: number; elapsedMs: number; error: string };

export interface ReconnectPolicy {
    /** The wait before each attempt, ms. The last entry repeats. */
    delaysMs: readonly number[];
    /** No attempt starts once this long has passed since the link was lost, ms. */
    budgetMs: number;
}

/**
 * Half a second before the first attempt, rising to three.
 *
 * Not zero first: by the time a poll fails here the link has already spent its own retries, with
 * escalating settles, on the same cable, so the next useful thing is to give the line real silence
 * before reopening it (tsunagi-m-link §3). And not a flat interval: a connector that let go comes
 * back in seconds or not at all, and a reconnect is a reopen plus a login, so attempting every 500 ms
 * for a minute would spend the whole budget hammering a cable that is still out.
 *
 * Sixty seconds, because past that the likely cause is that the engine was switched off without
 * STOP, and a run should end the way it always has rather than sit on RECONNECTING.
 */
export const LIVE_RECONNECT_POLICY: ReconnectPolicy = {
    delaysMs: [500, 1000, 2000, 3000],
    budgetMs: 60_000,
};

export interface LivePollDeps {
    poll(): Promise<LiveMeasurement>;
    /** Absent: the link cannot reconnect, and a link failure ends the run as it always did. */
    reconnect?(reason: string): Promise<DmeIdentity>;
    disconnect(): Promise<void>;
    /** False once STOP has been pressed or the link has been torn down. Checked after every await. */
    shouldContinue(): boolean;
    onSample(sample: LiveMeasurement, meta: LiveSampleMeta): void;
    onGap?(event: LinkGapEvent): void;
    /** The identity the run started against — how a reconnect proves it reached the same DME. */
    startIdentity: DmeIdentity | null;
    policy?: ReconnectPolicy;
    /** Milliseconds, monotonic. Defaults to performance.now(). */
    now?(): number;
    sleep?(ms: number): Promise<void>;
}

const UNKNOWN = 'UNKNOWN';

/**
 * Whether `now` is a different DME from `started`, as a sentence, or null when nothing says so.
 *
 * Only fields both sides actually read are compared: identify() falls back to 'UNKNOWN' per field
 * when a read fails, and an UNKNOWN on one side is a read that did not happen, not a different car.
 * The values themselves stay out of the message — it is shown on screen and uploaded with the
 * diagnostics, and a VIN is not something either needs.
 */
export function differentDme(started: DmeIdentity | null, now: DmeIdentity): string | null {
    if (!started) return null;
    const known = (v: string | undefined) => !!v && v !== UNKNOWN;
    const fields = [['vin', 'VIN'], ['aif', 'AIF'], ['softwareVersion', 'program number']] as const;
    for (const [key, label] of fields) {
        if (known(started[key]) && known(now[key]) && started[key] !== now[key]) {
            return `A different DME answered the reconnect (its ${label} differs), so the run was ended `
                + 'rather than joined to another car\'s log.';
        }
    }
    return null;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs the poll until STOP, a link failure it cannot recover, or a different DME.
 *
 * Resolves with the failure that ended the run, or null when it was stopped. Never rejects on a
 * link error: every one is either recovered or returned.
 */
export async function runLivePoll(d: LivePollDeps): Promise<string | null> {
    const policy = d.policy ?? LIVE_RECONNECT_POLICY;
    const now = d.now ?? (() => performance.now());
    const sleep = d.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));

    /** Time of the last sample handed on, in the samples' own seconds. */
    let lastTime: number | null = null;
    /** The same moment on this loop's clock, for `blindMs`. */
    let lastSampleAt: number | null = null;
    /** A gap has been recovered from and the next sample is the one that ends it. */
    let gapOpen = false;

    /** Sleeps in slices, so STOP is answered within a tenth of a second rather than after the wait. */
    const waitWhileRunning = async (ms: number): Promise<boolean> => {
        const until = now() + ms;
        while (d.shouldContinue()) {
            const left = until - now();
            if (left <= 0) return true;
            await sleep(Math.min(100, left));
        }
        return false;
    };

    /** A reconnect that completed after STOP has opened a cable nobody will close. */
    const closeQuietly = async () => {
        try { await d.disconnect(); } catch { /* the teardown is already someone else's */ }
    };

    type Recovery = { kind: 'resumed' } | { kind: 'stopped' } | { kind: 'failed'; failure: string };

    const recover = async (error: string): Promise<Recovery> => {
        const reconnect = d.reconnect!;
        const t0 = now();
        d.onGap?.({ kind: 'lost', error });
        let attempts = 0;
        let last = error;
        for (;;) {
            const wait = policy.delaysMs[Math.min(attempts, policy.delaysMs.length - 1)];
            if (now() - t0 + wait > policy.budgetMs) {
                const elapsedMs = now() - t0;
                d.onGap?.({ kind: 'gaveUp', attempts, elapsedMs, error: last });
                return {
                    kind: 'failed',
                    failure: `The link was lost and did not come back: ${attempts} reconnect attempt(s) over `
                        + `${Math.round(elapsedMs / 1000)} s. Last error: ${last}`,
                };
            }
            if (!(await waitWhileRunning(wait))) return { kind: 'stopped' };
            attempts++;
            let identity: DmeIdentity;
            try {
                identity = await reconnect(last);
            } catch (e) {
                last = messageOf(e);
                if (!d.shouldContinue()) {
                    await closeQuietly();
                    return { kind: 'stopped' };
                }
                d.onGap?.({ kind: 'retrying', attempt: attempts, error: last, elapsedMs: now() - t0 });
                continue;
            }
            if (!d.shouldContinue()) {
                await closeQuietly();
                return { kind: 'stopped' };
            }
            const other = differentDme(d.startIdentity, identity);
            if (other) {
                d.onGap?.({ kind: 'gaveUp', attempts, elapsedMs: now() - t0, error: other });
                return { kind: 'failed', failure: other };
            }
            const at = now();
            d.onGap?.({ kind: 'resumed', attempts, elapsedMs: at - t0, blindMs: at - (lastSampleAt ?? t0) });
            return { kind: 'resumed' };
        }
    };

    while (d.shouldContinue()) {
        let sample: LiveMeasurement;
        try {
            sample = await d.poll();
        } catch (e) {
            // A stop already in flight owns the teardown: disconnect() closes the port under the
            // in-flight read, and that is not a link failure to report or to recover from.
            if (!d.shouldContinue()) return null;
            const error = messageOf(e);
            if (!d.reconnect) return error;
            const outcome = await recover(error);
            if (outcome.kind === 'stopped') return null;
            if (outcome.kind === 'failed') return outcome.failure;
            // A gap that a second failure extends stays ONE gap: `lastTime` still points at the last
            // sample before it, so the sample that finally ends it states the whole stretch.
            gapOpen = true;
            continue;
        }
        if (!d.shouldContinue()) return null;
        const meta: LiveSampleMeta = {};
        // No sample before the gap means nothing to have a gap FROM: the run simply started late.
        if (gapOpen && lastTime !== null) meta.linkGapS = sample.time - lastTime;
        gapOpen = false;
        lastTime = sample.time;
        lastSampleAt = now();
        d.onSample(sample, meta);
    }
    return null;
}
