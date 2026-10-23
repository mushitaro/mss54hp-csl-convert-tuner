'use client';

import React from 'react';

/**
 * RUN 1 · 2 · 3 — which of the session's runs the LOG table and the GRAPH chart are showing.
 *
 * The run the workspace holds is the one its maps, its analysis and SAVE are about; any other is
 * there to read (see useRunView), and says so beside the switch rather than only in a tooltip a
 * phone never shows. Nothing at all with one run: there is nothing to choose and nothing to tell
 * apart. Held while a log records — the views are the live run's then.
 */
export default function RunSwitch({ runs, workspace, shown, disabled, onPick }: {
    runs: number;
    /** The run the workspace holds, or null when it holds none. */
    workspace: number | null;
    /** The run on the log views now. */
    shown: number | null;
    disabled: boolean;
    onPick: (run: number) => void;
}) {
    if (runs < 2) return null;
    return (
        <div className="flex shrink-0 items-center gap-1">
            <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">RUN</span>
            {Array.from({ length: runs }, (_, i) => i + 1).map(n => (
                <button
                    key={n}
                    type="button"
                    disabled={disabled && n !== shown}
                    aria-pressed={n === shown}
                    onClick={() => { if (n !== shown) onPick(n); }}
                    title={n === workspace
                        ? `Run ${n}: the run the maps and SAVE are about`
                        : `Run ${n}: an earlier run, to read`}
                    className={`h-6 min-w-6 rounded px-1.5 text-[10px] font-mono transition-colors ${n === shown
                        ? 'bg-blue-900 text-blue-200'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40'}`}
                >
                    {n}
                </button>
            ))}
            {shown !== null && workspace !== null && shown !== workspace && (
                <span className="ml-1 text-[8px] font-bold uppercase tracking-widest text-indigo-400">VIEW ONLY</span>
            )}
        </div>
    );
}
