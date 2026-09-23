'use client';

import { useLiveReadout } from '@/hooks/useLiveRun';
import type { useLiveRun } from '@/hooks/useLiveRun';
import { REFERENCE_BAND, onTarget } from '@/lib/lls/fromLog';

/**
 * Whether the car is on the reference operating point, while there is still time to steer onto it.
 *
 * ## Why this is on the picture and not in the panel
 *
 * Three drives in a row came back uncomparable. 954 ran at 1162 rpm and 10 km/h; 956 at 932 and 7;
 * 957 at 900 and 6. Every one of them improved the ring numbers and not one of them could separate
 * that from "the car was somewhere else", because the loop delay moves with rpm and load. The panel
 * already reported the band — afterwards, when the drive was over and the only remaining option was
 * to do it again.
 *
 * A judgement that arrives after the run is a report. The same judgement during the run is a
 * control, and it belongs where the driver is already looking.
 *
 * ## One verdict, not two
 *
 * `onTarget` is imported, not reimplemented. The share this strip is lighting up cell by cell is
 * the same function `summariseSession` reports as `onTargetShare` afterwards, so the light on the
 * screen during the drive and the number in the panel after it cannot disagree — and if they ever
 * did, the one the driver acted on is the one that was wrong.
 *
 * ## Mechanics
 *
 * Its own component and its own subscription, exactly like `LiveTelemetryStrip`: this is the only
 * thing on the page that changes at the sample rate, and holding it as page state re-rendered the
 * panels and the grid several times a second at the precise moment the poll loop wants the main
 * thread. Floats absolutely over the visualiser so the layout is identical running or stopped.
 */
export function LlsLiveStrip({ feed }: { feed: ReturnType<typeof useLiveRun>['readout'] }) {
    const { sample, count, hz } = useLiveReadout(feed);
    const b = REFERENCE_BAND;

    // Air comes from ML_SOLL_LLS when the DME is serving it, and is simply absent otherwise — no
    // reconstruction here. A strip is a glance, and inverting two maps per sample to fill a cell
    // that the run may not need is work done on the poll loop's thread.
    const air = sample?.mlSollLls;
    const verdict = onTarget(b, {
        rpm: sample?.rpm, airKgH: air, speedKmH: sample?.vehicleSpeed, throttlePct: sample?.wdk1,
    });

    // Ice blue is OK, M-red is off target, and slate is "no reading" — which is neither. An absent
    // channel must not read as a pass, and must not read as a failure either.
    const tone = (ok: boolean, present: boolean) =>
        !present ? 'text-slate-600' : ok ? 'text-emerald-400' : 'text-red-400';
    const num = (v: number | undefined, digits: number) =>
        v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);

    const cells = [
        {
            label: `SPEED ${b.speedMin}-${b.speedMax}`,
            value: num(sample?.vehicleSpeed, 0),
            tone: tone(verdict.speed, Number.isFinite(sample?.vehicleSpeed as number)),
        },
        {
            label: `RPM ${b.rpmMin}-${b.rpmMax}`,
            value: num(sample?.rpm, 0),
            tone: tone(verdict.rpm, Number.isFinite(sample?.rpm as number)),
        },
        {
            label: `AIR ${b.airMin}-${b.airMax}`,
            value: num(air, 1),
            tone: tone(verdict.air, Number.isFinite(air as number)),
        },
        {
            label: 'WDK 0',
            value: num(sample?.wdk1, 1),
            tone: tone(verdict.throttle, Number.isFinite(sample?.wdk1 as number)),
        },
        { label: 'FR', value: num(sample?.frRegler, 3), tone: 'text-blue-400' },
        { label: 'DUTY', value: num(sample?.llsTv, 1), tone: 'text-indigo-300' },
        { label: 'SAMP', value: String(count), tone: 'text-slate-500' },
        {
            label: 'HZ',
            value: hz === null ? '—' : hz.toFixed(1),
            tone: 'text-slate-400',
        },
    ];

    return (
        <div className="pointer-events-none absolute inset-x-2 top-2 z-20 rounded bg-slate-950/85 px-2 py-1.5 font-mono min-[900px]:backdrop-blur-sm">
            <div className="grid grid-cols-8 gap-x-2">
                {cells.map(c => (
                    <div key={c.label} className="flex min-w-0 flex-col leading-none">
                        <span className="truncate text-[8px] uppercase tracking-wider text-slate-600">{c.label}</span>
                        <span className={`truncate text-[11px] font-bold ${c.tone}`}>{c.value}</span>
                    </div>
                ))}
            </div>
            {/* A RESERVED line, so the strip is the same height whether or not the car is on point.
                The whole verdict in one place, because four green cells and one red is a thing the
                driver has to assemble, and they are driving. */}
            <p className={`mt-1 h-[11px] truncate text-[9px] uppercase tracking-wider ${
                !sample ? 'text-slate-600' : verdict.all ? 'text-emerald-400' : 'text-red-400'}`}>
                {!sample ? '—'
                    : verdict.all ? `ON POINT · comparable with ${b.label}`
                        : `OFF POINT · ${[
                            verdict.speed ? null : 'speed',
                            verdict.rpm ? null : 'rpm',
                            verdict.air ? null : 'air',
                            verdict.throttle ? null : 'throttle',
                        ].filter(Boolean).join(' · ')}`}
            </p>
        </div>
    );
}
