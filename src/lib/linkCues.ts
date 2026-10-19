/**
 * The link-gap cues: a datalog's link went, and came back — as SOUND, because the run that needs
 * them is a drive, and the screen is not where the driver is looking.
 *
 * Three cues, told apart without thinking about them:
 *
 *     lost     two tones falling — the link is gone, the app is reconnecting, the log is kept
 *     back     two tones rising — the link is back and the run goes on
 *     gaveUp   one long low tone — the reconnect gave up and the run has ended
 *
 * The drive cues that lived in useDriveCues.ts until 2026-10-18 went with the strip they belonged
 * to (the VE/RF KORR targets and their settle clocks). These are not those: they say nothing about
 * how to drive, only whether the log is still being recorded — the one fact the operator asked to be
 * told by ear (2026-10-19).
 *
 * ## Why Web Audio and not an <audio> element
 *
 * No asset to fetch or decode, so the tone starts on the tick it is asked for and a PWA that lost its
 * network still has it. The player is the one useDriveCues used, kept for the same reasons: a sine
 * with an 8 ms attack and an exponential release, because a hard start and stop is a click.
 *
 * ## The gesture rule
 *
 * Browsers start an AudioContext only after a user gesture. START TUNE is one, and `primeLinkCues`
 * is called from it, so by the time a cue is needed — minutes later, from a timer — the context
 * already exists and is allowed to run. If it will not start, every call is a silent no-op: a cue
 * must never be able to throw into the poll loop.
 *
 * Louder than the drive cues were (0.05-0.10). Those played every second next to the driver's ear and
 * had to be quiet enough not to cause a lift; these play a few times in a drive and have to be heard
 * over the engine, once.
 */

export type LinkCue = 'lost' | 'back' | 'gaveUp';

/** Frequencies in order, seconds per tone, and peak gain. */
const VOICE: Record<LinkCue, { hz: readonly number[]; sec: number; gain: number }> = {
    lost: { hz: [880, 440], sec: 0.16, gain: 0.16 },
    back: { hz: [440, 880], sec: 0.16, gain: 0.16 },
    gaveUp: { hz: [220], sec: 0.7, gain: 0.18 },
};

/** Gap between the tones of one cue, seconds. */
const TONE_GAP_S = 0.06;

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (ctx) return ctx;
    const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
}

/** Creates or resumes the context. Call it from the gesture that starts the run. */
export function primeLinkCues(): void {
    try {
        const c = context();
        if (c && c.state === 'suspended') void c.resume().catch(() => {});
    } catch {
        // No audio here; the cues will be silent and nothing else changes.
    }
}

export function playLinkCue(cue: LinkCue): void {
    try {
        const c = context();
        if (!c) return;
        if (c.state === 'suspended') void c.resume().catch(() => {});
        const { hz, sec, gain } = VOICE[cue];
        let t0 = c.currentTime;
        for (const f of hz) {
            const osc = c.createOscillator();
            const amp = c.createGain();
            osc.type = 'sine';
            osc.frequency.value = f;
            amp.gain.setValueAtTime(0, t0);
            amp.gain.linearRampToValueAtTime(gain, t0 + 0.008);
            amp.gain.exponentialRampToValueAtTime(0.0001, t0 + sec);
            osc.connect(amp).connect(c.destination);
            osc.start(t0);
            osc.stop(t0 + sec + 0.02);
            t0 += sec + TONE_GAP_S;
        }
    } catch {
        // Autoplay policy, no audio device, a context that will not resume. All of them mean the
        // same thing here: no sound, and nothing else changes.
    }
}
