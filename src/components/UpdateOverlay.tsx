'use client';

import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { DialogFrame } from './DialogFrame';
import { useDialogLang } from '@/hooks/useDialogLang';
import { useUpdateProgress, type UpdatePhase } from '@/hooks/useAppUpdate';

/**
 * What the app shows while it is taking an update.
 *
 * ## Why there is a panel here at all
 *
 * Taking an update is a 6 MB download — 65 files, of which one Plotly chunk is 4.4 MB — and on a
 * garage's WiFi that is tens of seconds. Before this, the whole of the feedback was the header's
 * refresh icon spinning, on a control 16 px tall that on a phone is at the far edge of the header.
 * A wait that long with a mark that small is indistinguishable from a control that missed the
 * press, and that reading is not hypothetical: it is exactly how the same button came to be
 * pressed twice for a year.
 *
 * ## Why it cannot be dismissed
 *
 * `DialogFrame` renders no X and takes no backdrop click when it is given no `onClose` — the
 * treatment its own doc reserves for the phases past the point of no return. This is one. The press
 * ends in `location.reload()` down every path in `reloadForUpdate`, including every failure, so
 * there is no outcome a Cancel button could produce and offering one would be a lie about what the
 * app is going to do next. What the copy does instead is state the deadline, so a wait that is
 * going badly still has a stated end.
 *
 * ## Why it holds off before appearing
 *
 * The normal case is now that the download finished minutes ago and the press only has a worker to
 * swap — a few hundred milliseconds. A full-screen panel for that is a flash, which is worse than
 * nothing. So the panel waits {@link HOLD_MS} from the press before it renders anything: fast
 * updates stay invisible, and only a wait long enough to worry about gets a display.
 *
 * ## Why the numbers are real
 *
 * The bar is bytes stored out of bytes to store, reported by the installing worker as each chunk of
 * each response lands — see `scripts/sw.template.js`. It is not a timer and not a file count. A
 * file count was the obvious cheap version and it would have been a lie in one specific way that
 * matters here: with 4.4 MB of 6.0 in a single file, it would sit near a quarter for almost the
 * whole install and then jump to full.
 */

/**
 * Long enough that a primed update — the normal case — never paints this at all.
 *
 * With the worker already waiting, the press is a postMessage and an `activate`, with no network in
 * either; the panel is for the download, and there is no download left to show. The number is a
 * judgement rather than a measurement of that path: what was observed is only that the panel was
 * still absent 100 ms after a press, in a run whose download then took four seconds.
 *
 * Note for anyone re-measuring this in a headless pane: `setTimeout` is clamped to about 1 Hz in a
 * hidden tab, so this hold and any sampler watching for it both stretch to a second. It cost some
 * confusion once. A tab whose UPDATE button was just pressed is by definition not hidden.
 */
const HOLD_MS = 400;

/**
 * One phase, one colour, in the vocabulary the hub's transfer already uses: blue for the transfer
 * itself, and the near-white ice blue for the pass that confirms it. `TRANSFER_PHASE_STYLE` is not
 * imported and extended because its keys are `TransferPhase` — a DME operation — and widening that
 * type so an app update could join it would put "downloading the app" in the same set as "erasing
 * the ECU". Same palette, same shape, separate table.
 */
const PHASE: Record<Exclude<UpdatePhase, 'idle'>, { label: string; text: string }> = {
    checking: { label: 'Checking…', text: 'text-blue-400' },
    downloading: { label: 'Downloading…', text: 'text-blue-400' },
    activating: { label: 'Activating…', text: 'text-emerald-400' },
};

const TEXT = {
    ja: {
        title: 'UPDATE',
        close: '閉じる',
        body: '新しいビルドを取得しています。取得が終わると自動的に読み込み直します。'
            + 'この画面は操作できません — 取れなかった場合も最大 60 秒で読み込み直すので、待つ以外にすることはありません。',
        offline: '接続が切れた場合、取得済みの分は破棄され、今のビルドのまま起動します。',
    },
    en: {
        title: 'UPDATE',
        close: 'Close',
        body: 'Fetching the new build. The app reloads into it as soon as it is stored. '
            + 'There is nothing to do here — if it cannot be fetched the app reloads anyway, within 60 seconds.',
        offline: 'If the connection drops, the part that was fetched is discarded and the current build starts as it is.',
    },
};

const mb = (bytes: number) => (bytes / 1048576).toFixed(2);

/**
 * The build this document was stamped with, by `scripts/build-id.mjs`.
 *
 * Read once, during the first render, which is a DOM read during render — allowed here only because
 * the panel is mounted behind `reloading` in page.tsx and so cannot exist during the prerender. The
 * `typeof` guard is the second lock on the same door: this returning undefined on a server is a
 * dash in one corner of a panel, where it throwing is a failed static export.
 */
function runningBuild(): string | undefined {
    if (typeof document === 'undefined') return undefined;
    return document.querySelector('meta[name="build-id"]')?.getAttribute('content')?.trim() || undefined;
}

export const UpdateOverlay: React.FC = () => {
    const t = TEXT[useDialogLang()];
    const { phase, loaded, total, incoming, startedAt } = useUpdateProgress();
    const [shown, setShown] = useState(() => Date.now() - startedAt >= HOLD_MS);
    const [from] = useState(runningBuild);

    useEffect(() => {
        if (shown) return;
        const timer = setTimeout(() => setShown(true), Math.max(0, HOLD_MS - (Date.now() - startedAt)));
        return () => clearTimeout(timer);
    }, [shown, startedAt]);

    if (phase === 'idle' || !shown) return null;

    const style = PHASE[phase];
    /**
     * `null` where there is no quantity to state, which is both ends of the operation: the probe has
     * nothing to measure, and by `activating` the download is over. Reporting `activating` as a
     * percentage would mean painting 100 % over a step that is not a transfer at all.
     */
    const percent = phase === 'activating' ? 100
        : phase === 'downloading' && total > 0 ? Math.min(100, Math.round((loaded / total) * 100))
            : null;

    return (
        <DialogFrame
            icon={<RefreshCw className="w-3 h-3 animate-spin" />}
            title={t.title}
            closeLabel={t.close}
            autoHeight
        >
            {/* Every row below is a fixed-height slot holding whatever this phase has to put in it.
                The panel walks three phases while the user watches, and the one thing it must not do
                is resize as it does — the same rule DialogFrame's own header comment states, for the
                same reason: a box that jumps while it works reads as something going wrong. */}
            <div className="flex flex-col gap-3">
                <div className="flex items-baseline justify-between h-4">
                    <span className={`text-[10px] font-bold uppercase tracking-widest ${style.text}`}>
                        {style.label}
                    </span>
                    <span className={`text-[10px] font-mono ${style.text}`}>
                        {percent === null ? '' : `${percent}%`}
                    </span>
                </div>

                {/* The track pulses whenever there is no percentage, which is the hub ring's answer
                    to the same problem during ERASE: a bar that is simply empty for a step that
                    reports nothing looks like a transfer that has stalled.
                    The fill carries NO transition, deliberately, and that is not a style choice — a
                    transition on a width driven by 10 Hz updates freezes the rendered value at the
                    one the first transition started from. Measured on the hub's arc, which sat at
                    ~4 % for an entire read until the transition came off. */}
                <div className={`h-1 rounded-full bg-slate-800 overflow-hidden ${percent === null ? 'animate-pulse' : ''}`}>
                    {percent !== null && (
                        <div
                            className={`h-full rounded-full bg-current ${style.text}`}
                            style={{ width: `${percent}%`, filter: 'drop-shadow(0 0 3px currentColor)' }}
                        />
                    )}
                </div>

                <div className="flex items-baseline justify-between gap-3 h-4 text-[10px] font-mono">
                    {/* Machine data, so mono — and stated even at `checking`, where it is a dash
                        rather than a zero. A zero would be a claim that nothing has arrived; the
                        dash says the worker has not reported yet, which is the true state. */}
                    <span className="text-slate-400 shrink-0">
                        {total > 0 ? `${mb(loaded)} / ${mb(total)} MB` : '—'}
                    </span>
                    {/* Which build is replacing which. The same stamp the diagnostics store records,
                        so "did the phone take the build I pushed" is answerable at the phone. */}
                    <span className="text-slate-600 truncate">
                        {from ?? '—'}{incoming ? ` → ${incoming}` : ''}
                    </span>
                </div>

                <p className="text-[11px] leading-relaxed text-slate-500">{t.body}</p>
                <p className="text-[11px] leading-relaxed text-slate-600">{t.offline}</p>
            </div>
        </DialogFrame>
    );
};
