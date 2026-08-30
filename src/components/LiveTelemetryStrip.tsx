'use client';

import { useLiveReadout } from '@/hooks/useLiveRun';
import type { useLiveRun } from '@/hooks/useLiveRun';

/**
 * The raw DME sample, over the visualisation, while a log is running.
 *
 * Its own component for one reason: it is the only thing on the page that changes at the sample
 * rate. Held as page state, every sample re-rendered the map, the visualiser, the panels and the
 * session bar to change seven small numbers — four or five times a second, at exactly the moment the
 * main thread is most wanted elsewhere, since the poll loop is sitting between two DS2 exchanges and
 * everything spent here is a sample not taken. Subscribing here means nothing outside this box
 * renders at all.
 *
 * Floats over the visualiser rather than sitting in the layout, so the panel below is identical
 * whether logging or stopped — the inputs do not move when a run starts.
 */
export function LiveTelemetryStrip({ feed }: { feed: ReturnType<typeof useLiveRun>['readout'] }) {
    const { sample, count, hz } = useLiveReadout(feed);
    return (
        <div className="absolute top-2 left-2 right-2 z-20 px-2 py-1.5 rounded bg-slate-950/85 border border-slate-800 backdrop-blur-sm grid grid-cols-7 gap-x-2 font-mono pointer-events-none">
            {([
                { label: 'RPM', value: sample ? sample.rpm.toFixed(0) : '—', color: 'text-slate-200' },
                { label: 'RO %', value: sample ? sample.rawLoad.toFixed(1) : '—', color: 'text-blue-400' },
                // Warm end of the M-red ramp, matching LOG_FIELD_REGISTRY.coolantTemp. Not the
                // amber (now violet) status ramp: violet reads as "armed / busy" everywhere
                // else in this panel, and coolant temp is a readout, not a machine state.
                { label: 'TEMP', value: sample?.coolantTemp !== undefined ? `${sample.coolantTemp.toFixed(0)}°` : '—', color: 'text-red-300' },
                { label: 'SAMP', value: String(count), color: 'text-slate-500' },
                // Grey, deliberately. A sample rate is a readout, not machine state — violet
                // means "armed / busy" and the red ramp is coolant temp, so borrowing either
                // would report a condition this cell does not describe.
                {
                    label: 'HZ',
                    value: hz === null ? '—' : hz >= 100 ? hz.toFixed(0) : hz.toFixed(1),
                    color: 'text-slate-400',
                },
                { label: 'STFT1', value: sample ? (sample.stft1 ?? NaN).toFixed(3) : '—', color: 'text-green-400' },
                { label: 'STFT2', value: sample ? (sample.stft2 ?? NaN).toFixed(3) : '—', color: 'text-green-400' },
            ]).map(cell => (
                <div key={cell.label} className="flex flex-col leading-none">
                    <span className="text-[8px] text-slate-600 uppercase tracking-wider">{cell.label}</span>
                    <span className={`text-[11px] font-bold ${cell.color}`}>{cell.value}</span>
                </div>
            ))}
        </div>
    );
}
