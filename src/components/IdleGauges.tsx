'use client';

import React, { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import type { IdleSample } from '@/lib/dme-link/types';
import type { IdleTables } from '@/lib/idle/idleTables';
import type { IdleTuneResult } from '@/lib/idle/types';
import { IDLE_TUNE_DEFAULTS } from '@/lib/idle/types';
import { idleGateNow } from '@/lib/idle/tuner';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * THE VISUALIZATION PANE for the IDLE tab: every gate the write applies, as a bar with the reading
 * on it.
 *
 * Not a chart of the log — the log is the LOG tab's job. A time series answers what happened;
 * standing in a car park holding a procedure the question is how far this reading is from the
 * limit, and `WDK 0.40 %` against a 0.8 % gate and `WDK 6.50 %` are the same line on a trace and
 * opposite ends of a bar.
 *
 * ## EVERY ROW IS A GATE THAT DECIDES. That is the rule this file is built on.
 *
 * The first version drew twelve bars, and five of them came from `evaluateIdlePreflight` — a module
 * whose only consumer was this component. Nothing in `tuneIdleFeedforward` has ever read it. So a
 * driver was watching `LWS_LRW`, `EVAN1_IST`, `FR gap`, `EGAS_MAX_WDK` and `MD_RES` change colour
 * next to gates that were throwing their run away, with nothing on screen saying which was which.
 * Meanwhile four gates that DO refuse a window — the voltage spread, the target spread, the two
 * robust means' disagreement, and the duty against the map — were not drawn at all.
 *
 * So the rack is now exactly `rejectSample` and `judgeWindow`, in their own order, and every
 * reading comes off the `IdleDwell` those functions produce rather than being recomputed here. A
 * bar cannot say "inside" beside a census that refused the window for that same gate, because there
 * is one verdict.
 *
 * The preflight's tests are still worth knowing and still tested — they are what says whether the
 * governor is in the state this measurement assumes. They are diagnosis, not admission, and they do
 * not belong on the surface that answers "is this being recorded".
 *
 * ## Two kinds of bar
 *
 *   limit  a bound to stay inside. Outside is red: act now.
 *   fill   a quantity accumulating toward a target. Below it is blue, never red, and the bar fills.
 *          HOLD at 6 of 20 s means the driver is doing exactly the right thing.
 *
 * ## Every explanation is behind its own ⓘ
 *
 * One line per row, opened by the same `Info` button `FilterPanelControls` uses.
 */

type Status = 'ok' | 'fail' | 'unknown';

interface Gauge {
    id: string;
    status: Status;
    kind: 'limit' | 'fill';
    /** The reading, formatted with its unit. */
    read: string;
    /** Where the marker goes, 0..1 across the track. Null when there is no reading. */
    at: number | null;
    /** The allowed band as a fraction of the track. */
    bandFrom: number;
    bandTo: number;
    /** The rule, in the option's or the binary's own number. */
    rule: string;
    /** Which rejection this gate produces, so the row names the census line it feeds. */
    reason: string;
    hint: string;
}

interface Pip {
    id: string;
    status: Status;
    read: string;
    hint: string;
}

const TONE: Record<Status, { text: string; bar: string; border: string }> = {
    ok: { text: 'text-emerald-400', bar: 'bg-emerald-500', border: 'border-emerald-900' },
    fail: { text: 'text-red-400', bar: 'bg-red-500', border: 'border-red-900' },
    unknown: { text: 'text-slate-600', bar: 'bg-slate-600', border: 'border-slate-800' },
};

const TEXT = {
    ja: {
        sample: 'サンプル', window: '窓', dwells: 'DWELL',
        blocked: '記録対象外', holding: '記録中', waiting: '待機',
        noRun: '記録を開始すると判定が出ます',
        noWindow: '整定した窓がまだありません',
        hints: {
            TMOT: '暖機の窓。外れたサンプルは 1 つも採用しません。',
            WDK: 'KL_BZ_WDK_LL は全回転で 1.2 %。これを超えるとアイドルではありません。',
            'N−N_SOLL': '調速器が目標を保持できている幅。K_LL_DN_MAX の半分。',
            HOLD: '整定待ち 5.12 s の 4 倍。ここに届くまで窓は数えません。',
            SAMP: '窓の中のサンプル数。レートが落ちた run を弾きます。',
            DRIFT: '測定量 (md_llri + md_llra) の振れ幅。動いていれば定常ではありません。',
            UB: '端子電圧の振れ幅。窓の中で電気負荷が入り切りされたことを検出します。',
            'UB OFF': '窓の平均電圧と run 全体の静止電圧の差。窓じゅう入りっぱなしの負荷はこれでしか見えません。',
            'N_SOLL DR': '目標回転そのものの振れ幅。目標が動いていれば偏差は測定になりません。',
            STAT: 'トリム平均と中央値の差。食い違うのは定常ではなくイベント（積分器ゼロ化、分割読み）です。',
            MODEL: '実測デューティと KF_LLS_TV の差。**これが開くと、そのマップが弁を駆動していません。**'
                + '触媒暖機が混ざっているときも開きます。',
            LLS_TV: 'アイドル弁デューティ。レールに張り付いていれば権限を使い切っており、補正しても動きません。',
            LL: 'DME 自身のアイドル判定 (zustand_motor bit2)。',
            'A/C': 'コンプレッサ。作動中と、その前後 12 秒は除外します。',
            SRC: 'MD_LLRI の RAM アドレスを block 19 と突き合わせた結果。未確認なら数値は信用できません。',
            'ML_LL': '空気要求。これが届かないと補正を載せる行が決まりません。',
        } as Record<string, string>,
    },
    en: {
        sample: 'SAMPLE', window: 'WINDOW', dwells: 'DWELLS',
        blocked: 'NOT RECORDING', holding: 'RECORDING', waiting: 'WAITING',
        noRun: 'Start a run to get the verdict',
        noWindow: 'No settled window yet',
        hints: {
            TMOT: 'The warm window. Not one sample outside it is admitted.',
            WDK: 'KL_BZ_WDK_LL is 1.2 % at every rpm, so past this it is not idle.',
            'N−N_SOLL': 'How well the governor is holding target. Half of K_LL_DN_MAX.',
            HOLD: 'Four times the 5.12 s settle constant. No window counts before it.',
            SAMP: 'Samples inside the window — refuses a run whose rate collapsed.',
            DRIFT: 'Spread of the measured quantity (md_llri + md_llra). Moving is not settled.',
            UB: 'Terminal voltage spread — catches an electrical load being switched inside the window.',
            'UB OFF': "The window's mean voltage against the run's resting one. A load left on for the "
                + 'whole window is invisible any other way.',
            'N_SOLL DR': 'Spread of the target itself. A moving target makes the deviation meaningless.',
            STAT: 'Trimmed mean against median. They disagree on an EVENT — an integrator zeroing, a '
                + 'split read — rather than on a steady state.',
            MODEL: 'Measured duty against KF_LLS_TV. **Open, and that map is not driving the valve.** '
                + 'It also opens while catalyst heating is still blending in.',
            LLS_TV: 'Idle valve duty. On a rail the authority is already spent and a correction moves nothing.',
            LL: "The DME's own idle verdict (zustand_motor bit2).",
            'A/C': 'Compressor. Engaged, and 12 s either side of it, are excluded.',
            SRC: "MD_LLRI's RAM address checked against block 19. Unconfirmed means these numbers cannot be trusted.",
            'ML_LL': 'The air request. Without it there is no row to put the correction on.',
        } as Record<string, string>,
    },
};

/** Where a reading sits on a track, clamped so an out-of-range value still shows which end. */
const pos = (v: number, lo: number, hi: number) =>
    Math.max(0, Math.min(1, (v - lo) / Math.max(1e-9, hi - lo)));

export const IdleGauges: React.FC<{
    samples: IdleSample[];
    tables: IdleTables | null;
    result: IdleTuneResult | null;
    running?: boolean;
    sourceProven?: boolean | null;
}> = ({ samples, tables, result, running, sourceProven }) => {
    const lang = useDialogLang();
    const t = TEXT[lang === 'ja' ? 'ja' : 'en'];
    const [open, setOpen] = useState<string | null>(null);

    const now = useMemo(() => idleGateNow(samples, tables), [samples, tables]);
    const last = samples.length ? samples[samples.length - 1] : null;
    const accepted = result?.report.dwellsAccepted ?? 0;
    const need = IDLE_TUNE_DEFAULTS.minCellDwells;

    const groups: { label: string; gauges: Gauge[]; pips: Pip[] }[] = useMemo(() => {
        const o = now?.opts ?? IDLE_TUNE_DEFAULTS;
        const g = (
            id: string, reason: string, status: Status, value: number | null, dp: number, unit: string,
            lo: number, hi: number, okLo: number, okHi: number, rule: string,
            kind: 'limit' | 'fill' = 'limit',
        ): Gauge => ({
            id, reason, status, kind,
            read: value === null ? '—' : `${value.toFixed(dp)}${unit}`,
            at: value === null ? null : pos(value, lo, hi),
            bandFrom: pos(okLo, lo, hi), bandTo: pos(okHi, lo, hi),
            rule, hint: t.hints[id] ?? '',
        });
        const st = (ok: boolean | null | undefined): Status =>
            ok === null || ok === undefined ? 'unknown' : ok ? 'ok' : 'fail';
        const gate = (id: string) => now?.gates.find(x => x.id === id) ?? null;
        // K_LLS_TV_MIN / K_LLS_TV_MAX. A fallback rather than a guard, so the LLS_TV band is drawn
        // before a BIN is loaded instead of the row disappearing.
        const tvMin = tables?.tvMin ?? 14.0;
        const tvMax = tables?.tvMax ?? 97.0;

        // ── SAMPLE: `rejectSample`, in its own order. What stops this instant being recorded.
        const sampleGauges: Gauge[] = [
            g('TMOT', 'not-warm', st(gate('TMOT')?.ok), last?.coolantTemp ?? null, 0, '°',
                60, 115, o.minCoolantC, o.maxCoolantC, `${o.minCoolantC}–${o.maxCoolantC}`),
            g('WDK', 'throttle-open', st(gate('WDK')?.ok), last?.wdk1 ?? null, 2, '%',
                0, 3, 0, o.maxThrottlePct, `<= ${o.maxThrottlePct}`),
            g('N−N_SOLL', 'off-target', st(gate('N−N_SOLL')?.ok),
                last?.rpm != null && last?.nSoll != null ? last.rpm - last.nSoll : null, 0, '',
                -100, 100, -o.maxSpeedErrorRpm, o.maxSpeedErrorRpm, `+/-${o.maxSpeedErrorRpm}`),
        ];
        const samplePips: Pip[] = [
            { id: 'LL', status: st(gate('LL')?.ok), read: gate('LL')?.value ?? '—', hint: t.hints.LL },
            { id: 'A/C', status: st(gate('A/C')?.ok), read: gate('A/C')?.value ?? '—', hint: t.hints['A/C'] },
            {
                id: 'ML_LL',
                status: last?.mlSollLls == null ? 'unknown' : 'ok',
                read: last?.mlSollLls == null ? '—' : last.mlSollLls.toFixed(1),
                hint: t.hints.ML_LL,
            },
            {
                id: 'SRC',
                status: sourceProven === true ? 'ok' : sourceProven === false ? 'fail' : 'unknown',
                read: sourceProven === true ? 'RAM' : sourceProven === false ? 'BAD' : '?',
                hint: t.hints.SRC,
            },
        ];

        // ── WINDOW: `judgeWindow`, in its own order. Every reading is that dwell's own statistic.
        //
        // Built UNCONDITIONALLY. These existed only once `idleGateNow` had something to say, so
        // pressing START grew nine rows and the pane jumped under the reader's eyes — and the rows
        // most worth reading BEFORE a run, the ones that say what you are about to be judged
        // against, were exactly the ones missing. A gauge with nothing measured draws its band and
        // a dash.
        const w = now?.window ?? null;
        const has = now !== null;
        const judge = (v: number | null | undefined, ok: boolean): Status =>
            !has || v === null || v === undefined ? 'unknown' : ok ? 'ok' : 'fail';
        const windowGauges: Gauge[] = [
            g('HOLD', 'too-short',
                judge(has ? now.heldSec : null, (now?.heldSec ?? 0) >= o.dwellSec),
                has ? now.heldSec : null, 0, 's',
                0, o.dwellSec * 1.5, o.dwellSec, o.dwellSec * 1.5, `>= ${o.dwellSec.toFixed(0)}`, 'fill'),
            g('SAMP', 'thin-count',
                judge(has ? now.heldSamples : null, (now?.heldSamples ?? 0) >= o.minDwellSamples),
                has ? now.heldSamples : null, 0, '',
                0, o.minDwellSamples * 1.5, o.minDwellSamples, o.minDwellSamples * 1.5,
                `>= ${o.minDwellSamples}`, 'fill'),
            g('DRIFT', 'integrator-drifting',
                judge(w?.errorDrift, (w?.errorDrift ?? 0) <= o.maxMdLlriDriftNm),
                w?.errorDrift ?? null, 2, ' Nm',
                0, o.maxMdLlriDriftNm * 1.5, 0, o.maxMdLlriDriftNm, `<= ${o.maxMdLlriDriftNm.toFixed(1)}`),
            g('UB', 'electrical-load', judge(w?.ubDrift, (w?.ubDrift ?? 0) <= o.maxUbDriftV),
                w?.ubDrift ?? null, 2, ' V',
                0, o.maxUbDriftV * 2, 0, o.maxUbDriftV, `<= ${o.maxUbDriftV.toFixed(2)}`),
            g('UB OFF', 'electrical-load', judge(w?.ubOffset, (w?.ubOffset ?? 0) <= o.maxUbDriftV),
                w?.ubOffset ?? null, 2, ' V',
                0, o.maxUbDriftV * 2, 0, o.maxUbDriftV, `<= ${o.maxUbDriftV.toFixed(2)}`),
            g('N_SOLL DR', 'target-moving',
                judge(w?.nSollDrift, (w?.nSollDrift ?? 0) <= o.maxNSollDriftRpm),
                w?.nSollDrift ?? null, 0, '',
                0, o.maxNSollDriftRpm * 2, 0, o.maxNSollDriftRpm, `<= ${o.maxNSollDriftRpm}`),
            g('STAT', 'unsteady', judge(w?.statDisagree, (w?.statDisagree ?? 0) <= o.maxStatDisagreeNm),
                w?.statDisagree ?? null, 2, ' Nm',
                0, o.maxStatDisagreeNm * 2, 0, o.maxStatDisagreeNm, `<= ${o.maxStatDisagreeNm.toFixed(1)}`),
            // THE ONE THAT SAYS THIS IS THE RIGHT MAP. Signed, and both directions matter.
            g('MODEL', 'model-disagrees',
                judge(w?.modelDeltaPct, Math.abs(w?.modelDeltaPct ?? 0) <= o.maxModelDeltaPct),
                w?.modelDeltaPct ?? null, 2, '%',
                -o.maxModelDeltaPct * 2, o.maxModelDeltaPct * 2, -o.maxModelDeltaPct, o.maxModelDeltaPct,
                `+/-${o.maxModelDeltaPct.toFixed(1)}`),
            // The valve's own authority, from the binary's rails — the write's gate, not the 25 %
            // the preflight infers. Railed at either end and a correction moves nothing.
            g('LLS_TV', 'duty-railed',
                judge(w?.llsTvMean, (w?.llsTvMean ?? 0) > tvMin + o.railToleranceDutyPct
                    && (w?.llsTvMean ?? 0) < tvMax - o.railToleranceDutyPct),
                w?.llsTvMean ?? null, 1, '%',
                tvMin, tvMax, tvMin + o.railToleranceDutyPct, tvMax - o.railToleranceDutyPct,
                `${tvMin.toFixed(0)}–${tvMax.toFixed(0)}`),
        ];

        return [
            { label: t.sample, gauges: sampleGauges, pips: samplePips },
            { label: t.window, gauges: windowGauges, pips: [] },
        ];
    }, [now, last, tables, sourceProven, t]);

    const blocked = now?.blocking ?? null;

    return (
        <div className="flex h-full w-full flex-col overflow-hidden">
            <div className="flex h-[26px] shrink-0 items-center gap-2 border-b border-slate-800 px-2">
                <span className={`font-mono text-[10px] font-bold uppercase tracking-widest ${blocked ? 'text-red-400' : running ? 'text-emerald-400' : 'text-slate-600'
                    }`}>
                    {blocked ? t.blocked : running ? t.holding : t.waiting}
                </span>
                <span className={`ml-auto font-mono text-[10px] font-bold ${accepted >= need ? 'text-emerald-400' : 'text-slate-500'
                    }`}>
                    {t.dwells} {accepted}/{need}
                </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {/* Every group, every row, always — and the only thing that ever changes height is
                    an info button the reader pressed. */}
                {groups.map(grp => (
                    <section key={grp.label} className="pt-2">
                        <div className="mb-1 border-b border-slate-800 pb-0.5 text-[9px] font-bold uppercase tracking-widest text-slate-600">
                            {grp.label}
                        </div>
                        {grp.gauges.map(x => (
                            <GaugeRow key={x.id} g={x} open={open === x.id}
                                onToggle={() => setOpen(open === x.id ? null : x.id)} />
                        ))}
                        {grp.pips.length > 0 && (
                            <>
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {grp.pips.map(p => (
                                        <button key={p.id} type="button"
                                            onClick={() => setOpen(open === p.id ? null : p.id)}
                                            className={`flex items-baseline gap-1 rounded border px-1.5 py-0.5 font-mono leading-none ${TONE[p.status].border} ${TONE[p.status].text}`}
                                        >
                                            <span className="text-[8px] uppercase tracking-wider opacity-70">{p.id}</span>
                                            <span className="text-[9px] font-bold">{p.read}</span>
                                        </button>
                                    ))}
                                </div>
                                {/* One RESERVED line for whichever pip is open, so pressing a chip
                                    cannot push the group below it down. */}
                                <p className="h-[12px] truncate pt-0.5 text-[9px] leading-none text-slate-500">
                                    {grp.pips.find(p => p.id === open)?.hint ?? ''}
                                </p>
                            </>
                        )}
                    </section>
                ))}
            </div>
        </div>
    );
};

/**
 * One gate: the name, the track with its allowed band, the reading's position, the reading.
 *
 * The band is drawn rather than stated, which is the point — `0.40 % against <= 1.0` is a sentence
 * you do arithmetic on; a marker 40 % of the way into a shaded region is a glance. The ⓘ carries the
 * rule, the census line this gate feeds, and what being outside it means.
 */
const GaugeRow: React.FC<{ g: Gauge; open: boolean; onToggle: () => void }> = ({ g, open, onToggle }) => {
    // A fill that has not arrived is IN PROGRESS, which is the primary role, not a failure.
    const filling = g.kind === 'fill' && g.status === 'fail';
    const tone = filling
        ? { text: 'text-blue-400', bar: 'bg-blue-400', border: 'border-blue-900' }
        : TONE[g.status];
    return (
        <div className="py-[3px]">
            <div className="flex items-center gap-1.5">
                <span className="w-[74px] shrink-0 truncate font-mono text-[9px] uppercase tracking-wider text-slate-500">
                    {g.id}
                </span>
                <div className="relative h-[9px] min-w-0 flex-1 rounded-sm bg-slate-800">
                    <div className="absolute inset-y-0 rounded-sm bg-slate-700"
                        style={{ left: `${g.bandFrom * 100}%`, right: `${(1 - g.bandTo) * 100}%` }} />
                    {/* A fill shows how much of the way there it is; a limit shows WHERE it is. The
                        marker is 2px rather than a dot because a dot at the track's end sits half
                        outside it, and which end you are on is the thing being asked. */}
                    {g.at !== null && (g.kind === 'fill' ? (
                        <div className={`absolute inset-y-0 left-0 rounded-sm ${tone.bar} opacity-70`}
                            style={{ width: `${g.at * 100}%` }} />
                    ) : (
                        <div className={`absolute inset-y-[-2px] w-[2px] ${tone.bar}`}
                            style={{ left: `calc(${g.at * 100}% - 1px)` }} />
                    ))}
                </div>
                <span className={`w-[58px] shrink-0 truncate text-right font-mono text-[10px] font-bold ${tone.text}`}>
                    {g.read}
                </span>
                <button type="button" onClick={onToggle} aria-expanded={open} aria-label={g.id}
                    className={`-mr-1 shrink-0 rounded p-1 ${open ? 'text-blue-400' : 'text-slate-700 hover:text-slate-500'}`}>
                    <Info className="h-3 w-3" />
                </button>
            </div>
            {open && (
                <p className="py-0.5 pl-[80px] text-[9px] leading-relaxed text-slate-500">
                    <span className="font-mono text-slate-600">{g.rule} · {g.reason}</span> — {emphHint(g.hint)}
                </p>
            )}
        </div>
    );
};

/** `**bold**` -> slate-300, so the one sentence that matters in a hint carries. */
function emphHint(text: string): React.ReactNode[] {
    return text.split('**').map((part, i) =>
        i % 2 === 1
            ? <strong key={i} className="font-semibold text-slate-300">{part}</strong>
            : <React.Fragment key={i}>{part}</React.Fragment>);
}
