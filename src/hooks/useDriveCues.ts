'use client';

import { useEffect, useRef } from 'react';

/**
 * The drive readout, as SOUND — so the eyes stay on the road.
 *
 * The strip above the map says which cell the car is in and whether the pull is being kept. Reading
 * it costs a glance, and the states it reports occur at two thirds throttle. A tuning aid that is
 * only legible while looking away from the road at speed is not one that should be used, and asking
 * someone to do it was the mistake this replaces.
 *
 * Three cues, chosen so they can be told apart without thinking about them:
 *
 *     tick      once a second while above the filling floor and still waiting — a countdown
 *     rise      the pull is now being kept; everything from here banks samples
 *     fall      it was being kept and is not any more — you lifted, or squeezed
 *
 * The FALL is the one that earns the feature. Under the old readout a pull that eased off at nine
 * seconds looked identical to one that did not, and the difference was only visible afterwards in a
 * census. Now it is audible the moment it happens, which is the only time it can be acted on.
 *
 * ## Why Web Audio and not an <audio> element
 *
 * No asset to load, no decode, and the tone starts on the same tick it is asked for. A cue that
 * arrives 200 ms late is worse than none: it would report a state the car has already left.
 *
 * ## The gesture rule
 *
 * Browsers will not start an AudioContext without a user gesture. START TUNE is one, and it always
 * precedes any of this, so the context is created lazily on the first cue and resumed if the
 * browser suspended it. If it will not start, every call is a silent no-op — a driving aid must
 * never throw into the poll loop.
 */

type Cue = 'tick' | 'rise' | 'fall';

/** Frequency, seconds, and peak gain per cue. Quiet on purpose: this plays over an engine, but it
 *  plays next to the driver's ear, and a cue loud enough to startle is a cue that causes a lift. */
const VOICE: Record<Cue, { hz: number; sec: number; gain: number }> = {
    tick: { hz: 660, sec: 0.035, gain: 0.05 },
    rise: { hz: 990, sec: 0.12, gain: 0.10 },
    fall: { hz: 300, sec: 0.20, gain: 0.10 },
};

/**
 * Plays the cues for a live drive.
 *
 * @param holding  above the filling floor at all — null heldSec means no
 * @param counting the pull has cleared the settle requirement, so samples are being kept
 * @param heldSec  how long it has been held, for the once-a-second tick
 * @param enabled  false silences everything, and stops the context ever being created
 */
export function useDriveCues(
    { holding, counting, heldSec, enabled = true }:
    { holding: boolean; counting: boolean; heldSec: number | null; enabled?: boolean },
) {
    const ctxRef = useRef<AudioContext | null>(null);
    const prevCounting = useRef(false);
    const prevHolding = useRef(false);
    const lastTick = useRef(-1);

    // Held in a ref and not in the effect's closure: the effect runs on every sample, and
    // re-creating the player each time would allocate at the sample rate.
    const play = useRef((cue: Cue) => {
        try {
            const Ctor = window.AudioContext
                ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctor) return;
            const ctx = ctxRef.current ?? (ctxRef.current = new Ctor());
            if (ctx.state === 'suspended') void ctx.resume();
            const { hz, sec, gain } = VOICE[cue];
            const osc = ctx.createOscillator();
            const amp = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = hz;
            // A hard start and stop on a sine is a click; the ramp is what makes it a tone.
            const t0 = ctx.currentTime;
            amp.gain.setValueAtTime(0, t0);
            amp.gain.linearRampToValueAtTime(gain, t0 + 0.008);
            amp.gain.exponentialRampToValueAtTime(0.0001, t0 + sec);
            osc.connect(amp).connect(ctx.destination);
            osc.start(t0);
            osc.stop(t0 + sec + 0.02);
        } catch {
            // Autoplay policy, no audio device, a suspended context that will not resume. All of
            // them mean the same thing here: no sound, and nothing else changes.
        }
    });

    useEffect(() => {
        if (!enabled) {
            prevCounting.current = counting;
            prevHolding.current = holding;
            return;
        }
        // RISE on the edge into counting. FALL on the edge out of it, which covers both ways of
        // losing a pull: lifting under the floor, and squeezing hard enough to restart the clock.
        if (counting && !prevCounting.current) play.current('rise');
        else if (!counting && prevCounting.current) play.current('fall');
        else if (holding && !counting && heldSec !== null) {
            // One tick per whole second of the wait, so the countdown is audible without a number.
            const whole = Math.floor(heldSec);
            if (whole !== lastTick.current) {
                lastTick.current = whole;
                play.current('tick');
            }
        }
        if (!holding) lastTick.current = -1;
        prevCounting.current = counting;
        prevHolding.current = holding;
    }, [holding, counting, heldSec, enabled]);

    // Closing the context on unmount, so a finished run does not leave one open. Not awaited: a
    // failed close is not something the page can do anything about.
    useEffect(() => () => { void ctxRef.current?.close().catch(() => {}); }, []);
}
