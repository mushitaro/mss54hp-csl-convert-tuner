'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import type { DropCensus as Census, DropReason } from '@/lib/log-engine/lambdaGates';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * Why the log is shorter than the drive was.
 *
 * The count on its own — "751 valid of 1600" — is the least actionable number in the app. Half the
 * drive is gone and nothing says whether the answer is to warm the engine first, hold a steadier
 * throttle, write the tank-vent patch, or stop pulling to redline. Every reason below is separately
 * fixable, and naming them is the difference between a filtered log and an instruction for the next
 * run.
 *
 * ## The nine explanations nobody had ever seen
 *
 * The LABELS were pulled out of a tooltip long ago with the right argument written beside them:
 * this is the number a driver reads standing next to the car on a phone, where hover does not
 * exist. The nine EXPLANATIONS stayed behind in a `title` regardless — so the half that says what
 * to DO about each reason was unreachable on the only device that reads this line, and English-only
 * besides, against the house rule that names stay put while explanations follow the reader. The
 * operator confirmed it on 2026-08-24: never seen one.
 *
 * The line is a button now, and it opens a sheet with every reason it is showing, each with its
 * sentence, in the reader's language. Same door as the DRIVE SPLIT chip and for the same reason: a
 * compact readout that has more to say has to say where the rest of it is.
 */

/** Short enough for a phone, and the same vocabulary the docs and the filter panel use. */
const LABEL: Record<DropReason, string> = {
    coldEngine: 'cold',
    idle: 'idle',
    transient: 'transient',
    catProtect: 'cat protect',
    fullLoad: 'full load',
    controllerStop: 'la stop',
    fuelCut: 'overrun',
    highLoadSettle: 'short pull',
    settle: 'unsettled',
    excluded: 'excluded',
};

/**
 * The one sentence that says what to DO about each, in the reader's language.
 *
 * Same rules as the filter panel's explanations: what was excluded, why that sample cannot be used,
 * and what to do about it next time. One vocabulary across both — a reader who has read the panel
 * should recognise every word here.
 */
const WHY: Record<'ja' | 'en', Record<DropReason, string>> = {
    en: {
        coldEngine: 'The DME does not close the lambda loop below 60 °C, so the lambda trim was not being updated. Let the coolant reach temperature before starting the log.',
        idle: 'At the lowest filling the DME adds 12-30 % more fuel from a table this tool does not write, and the lambda trim falls to cancel it. Not a fault, and not information about air flow.',
        transient: 'Engine speed or throttle was still changing, so the lambda trim had not finished moving to its new value. Hold a steady pedal for longer.',
        catProtect: 'The DME was enriching to protect the catalyst, which suspends lambda control — the trim held its last value. Includes the 20 s the enrichment takes to clear.',
        fullLoad: 'Past the DME\'s full-load threshold, where lambda control is switched off. The WOT TH patch keeps it running.',
        controllerStop: 'The lambda trim was pinned at its own limit, so it reports "at least this much" rather than a measurement.',
        fuelCut: 'You lifted off in gear and the DME shut the injectors, so there was no mixture to measure and the trim parked at exactly 1.000. Nothing to fix — every drive contains these, and counting them as "this cell is perfect" is what this removes.',
        highLoadSettle: 'The pull was too fresh. Above 55 % filling the DME steps its exhaust-temperature correction up off a sensor that lags, and the lambda trim needs about six seconds to walk after it — until then the reading is high by whatever it has not covered. Hold the pull longer: two drives disagreed by 5 % at high load until the short-pull samples came out.',
        settle: 'The operating point was still moving a settle ago, so the two things rf_korr is a ratio OF were measured at different air flows. This does not touch the VE map: the sample stays in the log and can still earn a cell. Hold a steady throttle for longer than Settle Time if the rf_korr table is what you are after.',
        excluded: 'You took this stretch out of the drive, because it disagreed with the rest of it. Nothing is wrong with these samples except that they belong to a different population; RESTORE on the map tab puts them back.',
    },
    ja: {
        coldEngine: '水温 60 °C 未満では DME が λ 制御を閉じないため、λ トリムが更新されていません。水温が上がってからログを開始してください。',
        idle: '最低充填では、本ツールが書き換えない表から DME が 12〜30 % 増量し、λ トリムがそれを打ち消すぶん下がります。故障ではなく、空気量についての情報でもありません。',
        transient: '回転数かスロットルがまだ変化していて、λ トリムが新しい値へ移動し終えていません。ペダルをもっと長く一定に保ってください。',
        catProtect: '触媒保護のために DME が増量しており、その間 λ 制御は停止してトリムは直前の値を保持します。増量が抜けるまでの 20 秒も含みます。',
        fullLoad: 'DME の全負荷閾値を超えた区間で、λ 制御が切られています。WOT TH パッチはこれを生かし続けるためのものです。',
        controllerStop: 'λ トリムが自身の上下限に張り付いていました。「少なくともこれだけ」という表示であって、測定値ではありません。',
        fuelCut: 'ギアを入れたままアクセルを戻し、DME が噴射を止めた区間です。混合気が無いので測るものが無く、トリムはちょうど 1.000 で止まります。直すものはありません — どの走行にも必ず含まれ、これを「このセルは完璧」と数えないための除外です。',
        highLoadSettle: '引きが新しすぎます。充填 55 % を超えると DME は排気温補正を一段上げますが、その元になるセンサーは遅れて読むため、λ トリムが追いつくのに約 6 秒かかります。それまでの値は、追いつけていない分だけ高く出ます。引きをもっと長く保持してください — 2 本の走行が高負荷で 5 % 食い違い、この短い引きを除いて一致しました。',
        settle: 'Settle Time だけ前の時点で、まだ回転数か開度が動いていました。rf_korr は 2 つの量の比なので、その 2 つが別々の空気量で測られたことになります。VE マップには影響しません — このサンプルはログに残り、セルの根拠にもなります。rf_korr の表が目的なら、Settle Time より長くアクセルを一定に保ってください。',
        excluded: '走行の一部を、残りの区間と食い違うという理由であなたが除外しました。サンプル自体に問題はなく、別の母集団に属しているというだけです。マップタブの RESTORE で戻せます。',
    },
};

const SHEET = {
    ja: { title: '除外されたサンプル', hint: 'それぞれ、次の走行で減らす方法が違います。' },
    en: { title: 'Samples left out', hint: 'Each one has a different cure on the next drive.' },
} as const;

export const DropCensusLine: React.FC<{
    census: Census;
    className?: string;
    /**
     * Clip to one line instead of wrapping.
     *
     * For the header, where the slot is a measured 243px on a phone and a line that grew would push
     * the readouts beside it off the screen. The sheet is what makes the clipping honest: the row
     * is sorted by count, so what falls off the end is the smallest reason, and everything is one
     * tap away. The wide layout keeps the wrapping it was measured with.
     */
    compact?: boolean;
    /**
     * One token — the total left out — instead of the reasons.
     *
     * For the phone band, which had this line to itself and could not fit it: the row is a measured
     * 343px, the readouts beside it take 327, and the census wants 189. It got its own line, and a
     * whole line of a phone screen for a list read once is the thing the operator asked to reclaim
     * (2026-08-25). As a chip it joins the readouts — VALID and DROP are the pair that matter, and
     * TOTAL was the sum of them — and every reason is still one tap away in the same sheet.
     */
    chip?: boolean;
    /**
     * The drive's TOTAL sample count, which turns the chip from "how many were left out" into
     * "how many there were" (operator, 2026-08-30).
     *
     * VALID sits beside it and the drop count is their difference, so TOTAL is the number that
     * cannot be worked out from the other one on the row — and it is the one that says whether a
     * drive was long enough to mean anything before any of the filtering is argued about.
     *
     * The door stays. Tapping still opens the census that says WHY the difference exists, which is
     * the only part of it anyone can act on. Given this, the chip also survives a drive with
     * nothing dropped: it renders as plain text rather than a button, because a control that opens
     * an empty sheet is worse than a number.
     */
    total?: number;
}> = ({ census, className, compact = false, chip = false, total }) => {
    const lang = useDialogLang();
    const [open, setOpen] = React.useState(false);
    /**
     * The sheet is portalled to `document.body`, and that is not tidiness.
     *
     * On a phone this line lives in the header, and the header carries `backdrop-blur-md` — a
     * backdrop-filter makes its element the containing block for every `position: fixed`
     * descendant. Rendered in place, `bottom-[60px]` measured 60px up from the HEADER's bottom
     * edge: the sheet opened at y = -422 on a 812px screen, entirely off the top, while every
     * class on it read as correct. Measured 2026-08-24.
     *
     * `mounted` because a portal needs a DOM and this component is in the static export.
     */
    const [mounted, setMounted] = React.useState(false);
    React.useEffect(() => setMounted(true), []);

    const rows = (Object.keys(LABEL) as DropReason[])
        .map(r => [r, census[r]] as const)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);

    const dropped = rows.reduce((sum, [, n]) => sum + n, 0);

    // Nothing dropped is worth saying out loud — it is the best possible outcome and an empty row
    // would read as a missing feature. Unless a TOTAL was given: that number is about the drive
    // rather than about the filter, so it belongs on the row either way, and only the door goes.
    if (!rows.length) {
        return total === undefined ? null : (
            <span className={`flex items-center gap-1.5 text-[9px] font-mono leading-none whitespace-nowrap ${className ?? ''}`}>
                <span className="text-slate-600">TOTAL</span>
                <span className="text-slate-500 font-bold">{total.toLocaleString()}</span>
            </span>
        );
    }

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title={SHEET[lang].title}
                className={`flex items-center gap-x-2 gap-y-0.5 text-[9px] font-mono leading-none text-left ${compact ? 'flex-nowrap overflow-hidden min-w-0' : 'flex-wrap'} ${className ?? ''}`}
            >
                {chip ? (
                    /* Same slot and same shape as VALID beside it, so the pair reads as one
                       statement: this many kept, this many left out. */
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                        <span className="text-slate-600">{total === undefined ? 'DROP' : 'TOTAL'}</span>
                        <span className="text-slate-500 font-bold">
                            {(total ?? dropped).toLocaleString()}
                        </span>
                    </span>
                ) : rows.map(([reason, n]) => (
                    <span key={reason} className="text-slate-600 whitespace-nowrap">
                        {LABEL[reason]} <span className="text-slate-500">{n.toLocaleString()}</span>
                    </span>
                ))}
            </button>

            {open && mounted && createPortal(
                <>
                    {/* Tinted, and closed on pointerdown — the rule the session sheet was fixed to.
                        An invisible scrim over a phone is indistinguishable from the screen having
                        stopped working. No backdrop-blur: measured elsewhere here at ~1 s of paint. */}
                    <div className="fixed inset-0 z-[95] bg-slate-950/70" onPointerDown={() => setOpen(false)} />
                    {/* Viewport-pinned rather than hung off the line. On a phone this line sits in a
                        48px header, and a popover anchored to it would open past the screen edge off
                        a control far narrower than itself. Same geometry as the other sheets. */}
                    <div className="fixed z-[96] inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),420px)] overflow-y-auto bg-slate-900 border border-slate-700 rounded shadow-xl">
                        <div className="sticky top-0 bg-slate-900 px-3 pt-2.5 pb-1.5 border-b border-slate-800">
                            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
                                {SHEET[lang].title}
                            </div>
                            <div className="text-[9px] text-slate-600 mt-0.5">{SHEET[lang].hint}</div>
                        </div>
                        <div className="px-3 py-2 space-y-2.5">
                            {rows.map(([reason, n]) => (
                                <div key={reason}>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-[10px] font-mono font-bold text-slate-300">{LABEL[reason]}</span>
                                        <span className="text-[10px] font-mono text-blue-400">{n.toLocaleString()}</span>
                                    </div>
                                    <p className="text-[10px] leading-snug text-slate-500 mt-0.5">{WHY[lang][reason]}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </>,
                document.body,
            )}
        </>
    );
};
