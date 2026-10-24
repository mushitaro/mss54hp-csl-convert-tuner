/**
 * The CAR IMAGE — the bytes a session believes its ECU is holding — and the three questions that
 * hang off it: which toggles a reopened session starts with, and what a NEXT session inherits.
 *
 * ## Why the hub needed one
 *
 * Every "is there anything to write" question used to compare the toggles with whatever image the
 * workspace had loaded, and that image was never the car. A draft loads its BASE; a patch-only write
 * reloaded the sent bytes into memory and nowhere else, so every reopen showed the patch missing,
 * offered WRITE PATCH-ON again and tripped the lineage check; and a toggle switched off never counted
 * as a change at all, so WRITE PATCH-OFF was disabled even on FINALIZE. The rule now is one sentence:
 * each session knows the BIN in its car, and the next WRITE is offered exactly when the BIN it would
 * send differs from that one, byte for byte (`buildImage` + `sameBytes`).
 *
 * ## How it is known, in order
 *
 *     1. stored     `SessionBinariesRecord.carBinaryBuffer`, written with every REAL flash since this
 *                   existed (and by a READ, where the car is the BASE just read)
 *     2. flash      the session's last real flash, for records written before (1): its sha256 is the
 *                   hash of the bytes sent, so the candidates the app could have sent are hashed and
 *                   the one that matches is the car —
 *                       the stored TUNED                        a tune write from a draft
 *                       patchOnImage(TUNED, flash.settings)     a FINALIZE, built from the stored TUNED
 *                       patchOnImage(BASE, flash.settings)      a patch-only write from the BASE
 *                   and when none matches, patchOnImage(TUNED ?? BASE, flash.settings) as the best
 *                   guess. A guess is safe to act on only because the lineage check at write time
 *                   still asks the ECU for its checksums and blocks on a mismatch.
 *     3. base       no real flash at all: nothing this app did has moved the car since the BASE went
 *                   in, so the car is the BASE.
 *
 * PRACTICE writes never reach (1) or (2): they moved no bytes in any car. The page still moves its
 * in-memory car image after one, so a rehearsal walks the same gate a real write does.
 *
 * Pure apart from hashing, which is the platform's and takes no state. `verify:car-image` asks it
 * the questions a wrong answer would fail.
 */

import type { BaseOrigin, FlashRecord, TuneSettings, TuningSession } from './schema';
import type { InterpolationPoint, LogFilterConfig } from '@/lib/types';
import { resolveRfKorr } from '@/lib/types';
import { patchOnImage, readLogicPatches } from '@/lib/binary-engine/patcher';
import { lastRealFlash } from './flashState';
import { sha256Hex } from './sessionRepository';

/** Which rung of the resolution produced the image. Not shown anywhere — it is what the verify
 *  script and a debugger ask, and the difference between a known car and a guessed one. */
export type CarImageSource = 'stored' | 'flash' | 'flash-guess' | 'base';

export interface CarImage {
    image: ArrayBuffer;
    source: CarImageSource;
}

/** The logic patches of a flash record, as `patchOnImage` takes them. Absent fields are off: a
 *  record that predates a patch was written by a build that could not set it. The retired RF GATE
 *  drop is not here — `patchOnImage` never writes it, and neither did any build that a record
 *  carrying it could be matched against. */
const patchesOf = (f: FlashRecord) => ({
    applyPatch: !!f.settings.applyPatch,
    applyWotDisable: !!f.settings.applyWotDisable,
    applyTankVentDisable: !!f.settings.applyTankVentDisable,
    applyRfKorrHold: !!f.settings.applyRfKorrHold,
});

/**
 * The car image of one session, from what its records hold. See the file header for the order.
 *
 * `stored` wins outright. It is written in the same transaction as the flash record it belongs to
 * (`appendFlashRecord`), and by the READ that set the BASE — so when it is there it is the car as
 * of the last thing this app did to it, and re-deriving it from hashes could only be less certain.
 */
export async function resolveCarImage(input: {
    flashHistory: FlashRecord[];
    base: ArrayBuffer;
    tuned?: ArrayBuffer | null;
    stored?: ArrayBuffer | null;
}): Promise<CarImage> {
    if (input.stored) return { image: input.stored, source: 'stored' };
    const last = lastRealFlash(input);
    if (!last) return { image: input.base, source: 'base' };

    const patches = patchesOf(last);
    const candidates: ArrayBuffer[] = [];
    if (input.tuned) candidates.push(input.tuned, patchOnImage(input.tuned, patches));
    candidates.push(patchOnImage(input.base, patches));
    for (const c of candidates) {
        if (await sha256Hex(c) === last.sha256) return { image: c, source: 'flash' };
    }
    return { image: patchOnImage(input.tuned ?? input.base, patches), source: 'flash-guess' };
}

/** `writeRfKorr` as a stored session means it. Two eras: the field, and before it the decision
 *  encoded in `filterConfig.rfKorrMode === 'tuned'` (`resolveRfKorr().legacyWrite`). Taking the
 *  absent field as plain false would drop the table write from every archived session of the older
 *  kind. */
export function storedWriteRfKorr(settings?: TuneSettings): boolean {
    return settings?.writeRfKorr ?? (settings ? resolveRfKorr(settings.filterConfig).legacyWrite : false);
}

/**
 * Are a session's saved settings still the operator's PENDING INTENT — newer than anything the car
 * has been given?
 *
 * Only a draft can say yes: an archived session's settings describe a tune that went out, and the
 * car has the say from then on. A draft with no real flash says yes whenever it has settings. A
 * draft that HAS written says yes only when the settings were saved after that write, which is the
 * one case the old rule (the last flash always overrides) got wrong: a stage-2 tune saved with K
 * HOLD off on a car still holding it came back on reopen with K HOLD on, and the next WRITE put the
 * hold back.
 *
 * "Saved after" is `TuningSession.settingsAt` against `FlashRecord.at`. Both are this device's
 * `Date.now()` at the moment of the act, and they are written by the only two acts that move them —
 * `saveTune` (and NEXT, which persists what the child inherits) and `appendFlashRecord`. A write
 * pins its settings at the flash's own timestamp, so settings saved BY a write are not "after" it;
 * they describe the car, and the car is what the seed reads then anyway. A session saved before
 * `settingsAt` existed has none, and with a real flash behind it reads as older than the flash —
 * which is exactly the rule it was reopened under before, so nothing a reopen showed yesterday
 * changes today.
 */
export function settingsAreCurrent(
    session: Pick<TuningSession, 'status' | 'tuneSettings' | 'settingsAt' | 'flashHistory'>,
): boolean {
    if (session.status !== 'draft' || !session.tuneSettings) return false;
    const last = lastRealFlash(session);
    if (!last) return true;
    return session.settingsAt !== undefined && session.settingsAt > last.at;
}

/** The toggles a load may be told outright — the shape of `useBinaryFile`'s ToggleOverrides,
 *  restated so this module does not import a hook. An absent logic patch is detected from the CAR
 *  IMAGE by the load. */
export interface SeededToggles {
    applyPatch?: boolean;
    applyWotDisable?: boolean;
    applyTankVentDisable?: boolean;
    applyRfKorrHold?: boolean;
    writeWarmup?: boolean;
    restoreWotFuel?: boolean;
    restoreVe?: boolean;
    restoreWarmup?: boolean;
    writeRfKorr?: boolean;
    writeVe?: boolean;
}

/**
 * What a reopened (or recovered) session's toggles start at.
 *
 *     draft, settings current     every toggle from the settings — the operator's pending intent
 *     draft, settings older       the four logic patches detected from the car image; the rest of
 *                                 the settings (RF KORR, WARMUP, the restores) kept, since nothing
 *                                 derived has gone out from a draft — and ALPHA-N OFF
 *     draft, no settings          everything detected / defaulted, as a fresh load (ALPHA-N OFF)
 *     archived                    the logic patches detected from the car image, and every derived
 *                                 row OFF — ALPHA-N included
 *
 * ALPHA-N comes back ON only from a current draft's saved choice (operator, 2026-10-24). An armed
 * ALPHA-N over a derived map is what puts WRITE on the hub's ring (lib/hub/ringAction.ts), and a
 * session keeps several runs now, so a reopen that armed it by default would hand back the ring
 * that made the next run unstartable. A current draft's `writeVe: true` is the operator's own arm,
 * saved — `buildSettings` stores the ARMED value, so it is true only where a map existed and the
 * row was ON. (A draft saved after a run under the old armed default carries true as well, and
 * reopens armed; the ring then says WRITE, and turning ALPHA-N off brings START TUNE back — which
 * before this change it did not.) Absent means no choice was recorded and reads OFF. That is a
 * reading of PENDING INTENT only: for reproducing what an archived flash carried, absent still
 * reads TRUE (TuneSettings.writeVe), because before the field the map was always written.
 *
 * Settings older than the last flash are not current intent, and for ALPHA-N they cannot be a
 * pending tune anyway: a write pins its settings at the flash, and a draft's real flash was a
 * patch-only write — one that carried the map would have archived the session.
 *
 * ALPHA-N off on an archived session is the safety half. Its map is re-derived on reopen under
 * today's rules, which are not the rules it was written under, so a re-derived map is not the map in
 * the car. Left armed, switching a patch on a written session would re-send that map along with the
 * patch and nothing on the hub would say so. Off, the build starts from the car image and changes
 * only what was switched; arming ALPHA-N again is still one tap, and then the write says TUNE.
 *
 * `undefined` overrides mean "a fresh load": the hook detects all four patches from the car image
 * and defaults the rest.
 */
export function seedToggles(
    session: Pick<TuningSession, 'status' | 'tuneSettings' | 'settingsAt' | 'flashHistory'>,
): SeededToggles | undefined {
    const s = session.tuneSettings;
    const derivedOff: SeededToggles = {
        writeWarmup: false, restoreWotFuel: false, restoreVe: false, restoreWarmup: false,
        writeRfKorr: false, writeVe: false,
    };
    if (session.status === 'archived') return derivedOff;
    if (!s) return undefined;
    const rest: SeededToggles = {
        writeWarmup: s.writeWarmup,
        restoreWotFuel: s.restoreWotFuel ?? false,
        // Absent reads false, and here that is a fact rather than a default: no session predating
        // these fields could have carried a restore, because neither writer existed.
        restoreVe: s.restoreVe ?? false,
        restoreWarmup: s.restoreWarmup ?? false,
        writeRfKorr: storedWriteRfKorr(s),
        // OFF unless the settings are current — see the header.
        writeVe: false,
    };
    if (!settingsAreCurrent(session)) return rest;
    return {
        applyPatch: s.applyPatch,
        applyWotDisable: s.applyWotDisable,
        // Absent reads off — no session saved before the field could have carried the patch.
        applyTankVentDisable: !!s.applyTankVentDisable,
        applyRfKorrHold: !!s.applyRfKorrHold,
        ...rest,
        // The operator's saved arm. Absent is no choice, so OFF — the seeding reading, not the
        // reproduction one (TuneSettings.writeVe); see the header.
        writeVe: s.writeVe ?? false,
    };
}

/** The four switches NEXT carries over. */
export interface LogicToggles {
    applyPatch: boolean;
    applyWotDisable: boolean;
    applyTankVentDisable: boolean;
    applyRfKorrHold: boolean;
}

/**
 * The toggles a session that is NOT open would show if it were opened: `seedToggles`, with the
 * gaps detected from its car image the way the load would detect them.
 */
export function sessionToggles(
    session: Pick<TuningSession, 'status' | 'tuneSettings' | 'settingsAt' | 'flashHistory'>,
    carImage: ArrayBuffer,
): LogicToggles {
    const seed = seedToggles(session);
    const det = readLogicPatches(carImage);
    return {
        applyPatch: seed?.applyPatch ?? det.applyPatch,
        applyWotDisable: seed?.applyWotDisable ?? det.applyWotDisable,
        applyTankVentDisable: seed?.applyTankVentDisable ?? det.applyTankVentDisable,
        applyRfKorrHold: seed?.applyRfKorrHold ?? !!det.applyRfKorrHold,
    };
}

/** What a NEXT session starts with. */
export interface NextStart {
    /** The child's BASE: the parent's car image, as bytes of its own (a copy, so deleting the
     *  parent cannot strand the child). */
    base: ArrayBuffer;
    origin: BaseOrigin;
    /** Persisted on the child at creation. Not a tune: no TUNED bytes go with it and no `sha256`
     *  is set, so the list offers no TUNED download and lights nothing it would not light anyway. */
    settings: TuneSettings;
}

/**
 * NEXT — the one way to continue: a new draft whose BASE is the parent's CAR IMAGE, with the
 * parent's switches and filter settings carried over.
 *
 * It replaced two branches that each got one half wrong. From TUNED made a SAVEd tune the child's
 * BASE whether or not it had been written — a tune that never reached the car became the reference
 * the next drive was measured against (V0·C², and a lineage mismatch at the next write). From BASE
 * copied the parent's own origin, so the child claimed descent from the grandparent and carried
 * none of the parent's settings. The car image is the only BASE that is both what the next drive
 * runs on and what the next write will find in the ECU.
 *
 * `which: 'car'` makes `parentSessionId` the parent itself, so the tree, the badge ("from #N") and
 * the high-Δ guard's ancestor walk all go to the session this one actually continues.
 *
 * Only the four logic switches and the filter settings travel. The derived rows — ALPHA-N included,
 * which opens OFF as on any fresh load — belong to the parent's drive, the high-Δ guard is the
 * parent's own measurement and is read through the ancestor walk rather than copied, and the
 * calibration edits are already inside the bytes if they were written.
 */
export function nextStart(
    parent: Pick<TuningSession, 'id'>,
    from: {
        carImage: ArrayBuffer;
        toggles: LogicToggles;
        filterConfig: LogFilterConfig;
        interpolationTable: InterpolationPoint[];
    },
): NextStart {
    return {
        base: from.carImage.slice(0),
        origin: { kind: 'session', sessionId: parent.id, which: 'car' },
        settings: {
            filterConfig: from.filterConfig,
            interpolationTable: from.interpolationTable,
            applyPatch: from.toggles.applyPatch,
            applyWotDisable: from.toggles.applyWotDisable,
            applyTankVentDisable: from.toggles.applyTankVentDisable,
            applyRfKorrHold: from.toggles.applyRfKorrHold,
            writeWarmup: false,
            restoreWotFuel: false,
            restoreVe: false,
            restoreWarmup: false,
            writeRfKorr: false,
            // OFF, as every fresh load leaves it (2026-10-24) — and stored rather than left absent
            // so the record says what was meant. It was stored TRUE, and because these settings are
            // the child's current intent until its first SAVE, every child reopened with ALPHA-N
            // armed: the first run's map then put WRITE on the ring and the next run could not
            // start (lib/hub/ringAction.ts). Arming it is the operator's step, taken in the child.
            writeVe: false,
        },
    };
}
