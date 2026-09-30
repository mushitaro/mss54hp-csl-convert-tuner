import React from 'react';
import type { IdleSample } from '@/lib/dme-link/types';

/**
 * The CORRECTED LOG tab, in IDLE mode.
 *
 * A SECOND table rather than the same one with different columns, and that is forced rather than
 * chosen: an `IdleSample` and a `LogDataPoint` share three fields out of fifty. The idle run reads
 * the governor's integrator, the valve duty and the air split; the log table's row type has a
 * column for none of them. Projecting one onto the other is exactly what `saveResearch` does for
 * storage, and its own comment says why that projection must never be the only copy — it drops
 * `md_llri`, which is the entire measurement.
 *
 * So: same visual grammar as LogDataTable (10px mono, sticky head, sticky time column, one column
 * per channel headed by the DME's own symbol), different rows.
 *
 * ## Which columns, and why these
 *
 * Not every channel the profile polls — the run reads about fifty, most of them survey-lane
 * preconditions that are constant for a whole dwell and belong in IdlePanel's census, not in a row
 * per sample. What is here is the measurement, the two gates that decide whether a sample counts,
 * and the actuator the correction is eventually written into:
 *
 *   md_llri            THE measurement. Rests at -K_LFR_MDADAPT_OFFSET, not at 0
 *   md_llra            the adaptation the I term drains into, same telegram, so their sum is one moment
 *   md_llra_ko         the compressor-on integrator — a dwell straddling an A/C cycle is visible here
 *   lls_tv / llr_qvs   the valve duty and the air request it came from
 *   ml_soll / _lls     the load request and the share the valve is given, i.e. the split itself
 *   LL / A/C           the two bits the dwell is gated on, decoded rather than shown as bytes
 *
 * `null` renders as an em dash and never as 0. On the fallback profile `zustand_motor` and
 * `kkos_st` are not read at all, and a column of zeros there would say "engine not idling, A/C off"
 * about a car nobody asked.
 */

/** One column: its head, and how a sample becomes a cell. */
interface Col {
    /** The DME's own symbol, lowercase, as the field registry's convention requires. */
    symbol: string;
    /** The hover line — what it is, in one sentence. */
    name: string;
    cell: (s: IdleSample) => string;
    /** Tailwind text colour. The measurement is the only one in the accent. */
    className?: string;
}

const num = (v: number | null, digits: number): string => (v === null ? '—' : v.toFixed(digits));

/** Bit `b` of `v`, as a word rather than a number. Null stays null: "not read" and "off" are
 *  different facts, and the fallback profile produces the first one. */
const bit = (v: number | null, b: number, on: string, off: string): string =>
    v === null ? '—' : ((v >> b) & 1) ? on : off;

const COLUMNS: Col[] = [
    { symbol: 'n', name: 'Engine speed, rpm', cell: s => num(s.rpm, 0), className: 'text-slate-300' },
    { symbol: 'llr_n_soll', name: 'Idle governor target speed, rpm. Watching this stand still is the post-start, safety-concept, DS2-test and oil-temperature lockout all at once', cell: s => num(s.nSoll, 0) },
    { symbol: 'tmot', name: 'Coolant temperature, °C. Gates the dwell and picks the row that would be written', cell: s => num(s.coolantTemp, 1) },
    { symbol: 'wdk1', name: 'Throttle plate 1, %. The closed-throttle test — KL_BZ_WDK_LL is 1.2 % at every rpm', cell: s => num(s.wdk1, 1) },
    // The accent, and the only one. This is the quantity the whole run exists to measure.
    { symbol: 'md_llri', name: 'Idle governor I term, Nm. THE measurement — it rests at -K_LFR_MDADAPT_OFFSET, not at 0', cell: s => num(s.mdLlri, 2), className: 'text-blue-400 font-bold' },
    { symbol: 'md_llra', name: 'Idle demand adaptation, compressor off, Nm. Same telegram as md_llri, which is what makes their sum one moment rather than two', cell: s => num(s.mdLlra, 2) },
    { symbol: 'md_llra_ko', name: 'Compressor-on integrator, Nm. Never used by the estimate — read so that a dwell straddling an A/C cycle is visibly excluded', cell: s => num(s.mdLlraKo, 2) },
    { symbol: 'lls_tv', name: 'Idle valve duty, %. 3.0 or 75.0 is the limp branch, not a rail', cell: s => num(s.llsTv, 1) },
    { symbol: 'llr_qvs', name: 'Air request the DME is running, kg/h', cell: s => num(s.llrQvs, 2) },
    { symbol: 'ml_soll', name: 'Load request feeding the split, kg/h', cell: s => num(s.mlSoll, 2) },
    { symbol: 'ml_soll_lls', name: 'The share of the request given to the idle valve, kg/h. The rest goes to the throttle', cell: s => num(s.mlSollLls, 2) },
    { symbol: 'zustand_motor', name: 'Engine state, bit 2 = idle. Not read on the fallback profile, where the throttle test stands in', cell: s => bit(s.engineState, 2, 'LL', '—') },
    { symbol: 'kkos_st', name: 'Compressor status, bit 0. Not read on the fallback profile, where A/C exclusion stops being a gate and becomes a procedure', cell: s => bit(s.kkosSt, 0, 'A/C', 'off') },
];

export const IdleLogTable: React.FC<{ samples: IdleSample[] }> = ({ samples }) => (
    <div className="h-full flex flex-col bg-slate-900/50">
        <div className="px-4 py-2 border-b border-slate-800 text-xs text-slate-400 flex justify-between items-center gap-2">
            <span>
                {samples.length
                    ? <>Displaying <span className="font-mono text-slate-300">{samples.length.toLocaleString()}</span> idle samples</>
                    : 'No idle samples yet'}
            </span>
            {/* Said here because it is the difference between this table and the VE one, and the
                difference is the whole reason there are two. */}
            <span className="text-[9px] text-slate-600">One row per DS2 sample — no filter, no window</span>
        </div>

        {samples.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-[10px] font-mono text-slate-700">
                START on the IDLE tab
            </div>
        ) : (
            <div className="flex-1 overflow-auto relative">
                <table className="w-full text-right border-collapse text-[10px] font-mono">
                    <thead className="sticky top-0 bg-slate-950 z-10 text-slate-500 font-bold uppercase tracking-wider">
                        <tr>
                            <th className="py-2 px-3 text-left border-b border-slate-800 sticky left-0 bg-slate-950">Time</th>
                            {COLUMNS.map(c => (
                                <th key={c.symbol} className="py-2 px-3 border-b border-slate-800 font-mono whitespace-nowrap" title={c.name}>
                                    {c.symbol}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                        {samples.map((s, i) => (
                            <tr key={i} className="hover:bg-slate-800/40 transition-colors">
                                <td className="py-1 px-3 text-left sticky left-0 z-[5] bg-slate-950 text-slate-500">
                                    {s.time.toFixed(1)}
                                </td>
                                {COLUMNS.map(c => (
                                    <td key={c.symbol} className={`py-1 px-3 whitespace-nowrap ${c.className ?? 'text-slate-400'}`}>
                                        {c.cell(s)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        )}
    </div>
);
