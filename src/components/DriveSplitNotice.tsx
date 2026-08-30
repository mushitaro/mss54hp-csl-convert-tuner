'use client';

import React from 'react';
import { AlertTriangle, Scissors } from 'lucide-react';
import type { DriveSplit, DriveSpan } from '@/lib/log-engine/driveSplit';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * "This drive is not one drive" — the notice, and the one decision it leads to.
 *
 * Two surfaces, two different questions: the CHIP in the stats row answers "is something wrong?"
 * and is a doorway; the panel behind the ⚠ on the TUNED strip answers "what is it, and what do I
 * do?" and is where the decision is made. That panel used to be a BAR exported from here, stacked
 * above the map — three or four lines of amber paragraph on a phone, before the map started, on
 * every drive that split. It is `TunedStatusBar` now, and this file keeps what does not depend on
 * the surface: the chip, and the sentences both of them say. See driveSplit.ts for what is measured
 * and for session #920, the drive that read as -4 % and was -1 %.
 *
 * Nothing here excludes anything on its own. The panel offers it; the operator decides; the choice
 * lands in `LogFilterConfig.excludeTimeRanges`, so the session still rebuilds to the same bytes.
 */

const signed = (pct: number) => `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)} %`;
/** How long the excluded stretch is, for the chip — shorter than a range and the number that
 *  actually matters once the decision is made: how much of the drive is out. */
const spanMinutes = (s: DriveSpan) => `${Math.round((s.to - s.from) / 60)}m`;

/**
 * The stats-row chip. One line, always.
 *
 * That row must never go to two lines: RATE / VALID / TOTAL are read against each other, and the
 * comment beside them in page.tsx records what it cost to get them breaking as a unit. So this
 * chip goes INSIDE their `shrink-0` group — which has no wrap of its own, so a fourth item cannot
 * split the group — and it drops the word SPLIT below 900px, leaving the triangle and the number.
 *
 * Measured at real viewports with the fonts loaded, against the real class strings:
 *
 *     320px   trio + chip 235px   one line   chip level with TOTAL   inside the padding
 *     360px               271px   one line   chip level with TOTAL   57px of headroom
 *
 * (An earlier measurement said 314px and sent me to add a width guard the chip does not need —
 * it was taken before `document.fonts.ready`, on the fallback face. Await the fonts.)
 *
 * Both call sites put it LAST, after TOTAL — one slot for one readout at both widths. Its two
 * states are two different widths (⚠ −6.0 % against ✂ 5m), so anywhere but the end it pushes
 * whatever follows: in the wide row it sat between VALID and TOTAL, and excluding the stretch
 * moved TOTAL sideways at the moment you acted, while the phone showed the same readout in a
 * different place. At the end it can push nothing.
 */
export const DriveSplitChip: React.FC<{
    /** What the detector found in the log AS FILTERED — null once the odd stretch is excluded. */
    split: DriveSplit | null;
    /** What the config says is currently taken out. Independent of the above; see activeExclusion. */
    excludedSpan: DriveSpan | null;
    onOpen: () => void;
}> = ({ split, excludedSpan, onOpen }) => {
    const t = TEXT[useDialogLang()];
    const excluded = !!excludedSpan;
    if (!split && !excluded) return null;
    return (
        <button
            type="button"
            onClick={onOpen}
            title={t.chipTitle(split)}
            className={`flex items-center gap-1 shrink-0 text-[9px] font-mono leading-none transition-colors ${excluded ? 'text-slate-600 hover:text-slate-400' : 'text-amber-400 hover:text-amber-300'
                }`}
        >
            {/* The non-hue channel the palette requires of any non-steady status: a colour alone
                would be the only thing saying this, and this row is mono grey either side of it.
                Two icons, because the two states are two different facts — a warning that has not
                been acted on, and a piece of the drive currently taken out. */}
            {excluded
                ? <Scissors className="w-3 h-3 shrink-0" />
                : <AlertTriangle className="w-3 h-3 shrink-0" />}
            <span className="hidden min-[900px]:inline text-slate-600">{excluded ? 'EXCL' : 'SPLIT'}</span>
            <span className="font-bold">
                {excludedSpan ? spanMinutes(excludedSpan) : signed(split!.gapPct)}
            </span>
        </button>
    );
};

/**
 * The finding's own words, for whatever surface is showing it.
 *
 * The bar below owned this copy and was the only thing that could say it. The TUNED tab now says
 * it inside a panel behind the ⚠ instead — a stacked amber paragraph is most of a phone screen
 * before the map starts (operator, 2026-08-25) — and the two must not drift into two accounts of
 * the same drive. So the sentences live here and the surfaces borrow them.
 */
export const splitBody = (lang: 'ja' | 'en', from: string, to: string, s: DriveSplit) =>
    TEXT[lang].body(from, to, s);
export const splitExcludedBody = (lang: 'ja' | 'en', from: string, to: string, rest: DriveSplit | null) =>
    TEXT[lang].excludedBody(from, to, rest);
/** EXCLUDE / RESTORE are the instrument's vocabulary and stay English in both — see TEXT below. */
export const SPLIT_ACTIONS = { exclude: 'Exclude', restore: 'Restore' } as const;

/**
 * The explanation switches language; the control words do not.
 *
 * SPLIT / EXCL / EXCLUDE / RESTORE are this instrument's vocabulary — the same words the stored
 * config and this file's own type use — and the house rule is that a name stays put while the
 * text that explains it moves. What a reader needs in their own language is what the finding
 * means and what to do about it, and that is the body.
 */
const TEXT = {
    ja: {
        chipTitle: (s: DriveSplit | null) => s
            ? `この走行は 2 つの母集団に分かれています（共通 ${s.sharedCells} セルで ${signed(s.gapPct)}）。タップで詳細へ。`
            : '一部の区間を除外してマップを作っています。タップで詳細と復元へ。',
        body: (from: string, to: string, s: DriveSplit) => (
            <>
                <span className="font-bold">この走行は 2 つに分かれています。</span>
                {` ${from}〜${to} 分は、残りの区間より `}
                <span className="font-bold text-amber-300 font-mono">{Math.abs(s.gapPct).toFixed(1)} %</span>
                {s.gapPct < 0 ? ' 少ない' : ' 多い'}
                {`燃料で釣り合っています（両方が通った ${s.sharedCells} セルで比較、${s.oddSamples.toLocaleString()} / ${s.restSamples.toLocaleString()} サンプル）。`}
                <span className="text-slate-400">
                    {' 両方を平均したマップは、どちらの区間にも合いません。書き込む前に、その区間で何が変わったかを確かめてください。'}
                </span>
            </>
        ),
        excludedBody: (from: string, to: string, rest: DriveSplit | null) => (
            <>
                {`${from}〜${to} 分を除外してこのマップを作っています。設定はセッションに保存され、次に開いても同じマップになります。`}
                {rest
                    ? <span className="text-amber-400">{` 残りの区間もまだ ${signed(rest.gapPct)} 分かれています。`}</span>
                    : <span className="text-slate-400">{' 残りの区間は 1 つの母集団として一貫しています。'}</span>}
            </>
        ),
    },
    en: {
        chipTitle: (s: DriveSplit | null) => s
            ? `This drive splits into two populations (${signed(s.gapPct)} over ${s.sharedCells} shared cells). Tap for detail.`
            : 'Part of this drive is excluded from the map. Tap for detail and to restore it.',
        body: (from: string, to: string, s: DriveSplit) => (
            <>
                <span className="font-bold">This drive splits in two.</span>
                {` Minutes ${from}-${to} balanced on `}
                <span className="font-bold text-amber-300 font-mono">{Math.abs(s.gapPct).toFixed(1)} %</span>
                {s.gapPct < 0 ? ' less' : ' more'}
                {` fuel than the rest, measured over the ${s.sharedCells} cells both stretches visited `}
                {`(${s.oddSamples.toLocaleString()} vs ${s.restSamples.toLocaleString()} samples).`}
                <span className="text-slate-400">
                    {' A map averaged from both is right for neither. Look at what changed there before you write.'}
                </span>
            </>
        ),
        excludedBody: (from: string, to: string, rest: DriveSplit | null) => (
            <>
                {`This map is built with minutes ${from}-${to} excluded. The choice is stored with the session, so it rebuilds the same way.`}
                {rest
                    ? <span className="text-amber-400">{` What remains still splits by ${signed(rest.gapPct)}.`}</span>
                    : <span className="text-slate-400">{' What remains reads as one population.'}</span>}
            </>
        ),
    },
};
