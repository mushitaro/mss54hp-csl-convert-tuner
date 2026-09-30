import React, { useMemo, useState } from 'react';
import { Info, Wind } from 'lucide-react';
import type { IdleSample } from '@/lib/dme-link/types';
import type { IdleTables } from '@/lib/idle/idleTables';
import type { IdleTuneResult, IdleRejectReason } from '@/lib/idle/types';
import { useDialogLang } from '@/hooks/useDialogLang';
import { IDLE_WRITE_SEALED } from '@/lib/idle/seal';
import { isWritableCell, STRUCTURAL_EXCLUSIONS } from '@/lib/idle/tuner';
import { findEcuItem } from '@/lib/ecu-items/catalog';
import { Stat, SectionLabel, emph } from './IdleNote';
import { MapEditor } from './MapEditor';
import { IDLE_TUNE_DEFAULTS } from '@/lib/idle/types';

/**
 * The idle panel: THE TABLE THAT WILL BE WRITTEN, and whether the run earned it. Nothing else.
 *
 * Everything that is an indicator now lives on the visualization pane as a bar against its own
 * threshold (`IdleGauges`), and everything that is an explanation is behind the ⓘ. What is left in
 * this pane is the two things a driver came here to read: what changes, and what the run kept.
 *
 * The panel used to open with a paragraph about the correction, carry a five-card precondition
 * block in the middle, and close with two more cards of standing reference — including a note about
 * what an earlier version of this feature got wrong, which is a code comment wearing a card.
 */

const REASON_TEXT: Record<IdleRejectReason, { en: string; ja: string }> = {
    'not-warm': { en: 'coolant outside 80-105 °C', ja: '水温が 80–105 °C の外' },
    'off-target': { en: 'engine speed away from its target', ja: '回転が目標から外れている' },
    'target-moving': { en: 'the target itself was moving', ja: '目標回転そのものが動いていた' },
    'throttle-open': { en: 'throttle was open', ja: 'スロットルが開いていた' },
    'not-ll': { en: 'the DME was not in its idle state', ja: 'DME がアイドル状態ではなかった' },
    compressor: { en: 'A/C compressor engaged, or within its settling window', ja: 'A/C 作動中、またはその整定窓の中' },
    'electrical-load': { en: 'terminal voltage moved, or sat away from the rest of the run', ja: '端子電圧が動いた、または他の区間と違う値だった' },
    'no-measurement': { en: 'a channel this needs was not in the telegram', ja: '必要なチャネルがテレグラムに無かった' },
    'too-short': { en: 'settled for less than the dwell time', ja: '整定時間が dwell に足りない' },
    'thin-count': { en: 'too few samples', ja: 'サンプル数不足' },
    unsteady: { en: 'the two robust statistics disagreed — an event, not a steady state', ja: '2 つのロバスト統計が不一致 ＝ 定常ではなくイベント' },
    'integrator-drifting': { en: 'the measured quantity was still moving', ja: '測定量がまだ動いていた' },
    'no-air-request': {
        en: 'ML_SOLL_LLS never arrived, so there is no air row to bin this onto',
        ja: 'ML_SOLL_LLS が届いておらず、割り当てる空気量の行が決まらない',
    },
    'model-disagrees': {
        en: 'the duty the DME ran does not match KF_LLS_TV here — cat heating may still be blending, '
            + 'or this is not the map driving the valve',
        ja: 'DME が実際に出したデューティが KF_LLS_TV と合わない —— 触媒暖機がまだ混ざっているか、'
            + 'このマップが弁を駆動していない',
    },
    'adaptation-moved': { en: 'idle adaptation moved during the window', ja: 'アイドル適応が窓の中で動いた' },
    'ndiff-reset': { en: 'the DME zeroed its integrator', ja: 'DME が積分器をゼロ化した' },
    'integrator-railed': { en: 'MD_LLRI was parked on a clamp — not a measurement', ja: 'MD_LLRI がクランプに張り付き ＝ 測定値ではない' },
    'duty-railed-low': { en: 'the valve was already as shut as it goes', ja: 'アイドル弁が下限まで閉じきっていた' },
    'duty-railed-high': { en: 'the valve was already wide open', ja: 'アイドル弁が上限まで開ききっていた' },
    'limp-branch': { en: 'the idle valve was in limp-home — the maps are not being consulted', ja: 'アイドル弁が非常運転 ＝ マップが参照されていない' },
    'no-evidence': { en: 'no dwell landed here', ja: 'この点に dwell が無い' },
    'single-dwell': { en: 'one dwell is one observation repeated, not two', ja: 'dwell 1 本は反復であって独立な 2 観測ではない' },
    'stall-column': { en: 'the 500 rpm column is the stall catch — warm evidence says nothing about it', ja: '500 rpm 列は失速キャッチ。暖機時の証拠では判断できない' },
    'cold-row': { en: 'not written from warm evidence', ja: '暖機時の証拠から冷間行は書かない' },
    'authority-floor-row': { en: 'the 11 kg/h row is the authority floor, not a calibration', ja: '11 kg/h 行は権限の床であって較正値ではない' },
    'below-authority-floor': { en: 'the request would fall below where the valve responds at all', ja: 'アイドル弁が応答しなくなる領域まで下げる要求だった' },
    'sub-quantum': { en: 'converged — the map cannot express a smaller change', ja: '収束 ——これ以上細かい変更をマップが表現できない' },
};

/** Reserved lines for the reject list, so the grid under it cannot move. */
const REJECT_ROWS = 3;

const TEXT = {
    ja: {
        title: 'IDLE VALVE DUTY',
        census: '採否',
        table: 'KF_LLS_TV',
        tableNote: '実線は、この run の暖機データが実際に載った行です。'
            + '500 rpm 列は失速キャッチ、11 kg/h 行は権限の床なので、どちらも書きません。'
            + '残りの行は「冷間だから」ではなく「この run が測っていないから」暗く出ます。',
        noWrite: '変更なし',
        pooled: (n: number) => `同一 BASE の過去 ${n} 本を含む`,
        atHub: (n: number) => `書き込みはハブの WRITE メニューの IDLE 行で —— ${n} セル`,
        notYet: '書き込める提案はまだありません',
        sealed: '書き込み封印中 —— 書き込み先に読み手がいない',
        noTables: 'この BIN からアイドル系のテーブルを読めませんでした。KF_LLS_TV の構成が想定と違います。',
        limp: 'アイドル弁が非常運転でした。この run からは何も導出しません。',
        railed: '積分器がクランプに張り付いていました。権限を使い切った状態は測定値ではありません。',
        info: 'アイドル調速器の I 項 MD_LLRI が「設計上そこに座るはずの値」からどれだけ外れているかを測り、'
            + 'その差を **KF_LLS_TV**（アイドル弁デューティ、0x9E10）に書きます。'
            + '車が実際にアイドルする回転数は軸のブレークポイントの間にあるので、補正は DME が補間する'
            + '各セルへ重み付きで分配されます。1 パスあたり 1 セル 3.0 % が上限。'
            + '目標がゼロでないのは K_LFR_MDADAPT_OFFSET の符号反転だからで、自車 BIN から読んでいます。\n\n'
            + '**リスク。** これはアイドルでエンジンに入る空気量を変えます。多すぎるとアイドルが高く張り付いて'
            + 'ハンチングします —— この較正には下げる手段がほとんどありません（KL_LFR_TZ_NEG は全ゼロ、'
            + 'P 項は回転が低い側でしか働かず、戻り道は 5.12 s の積分だけ）。少なすぎるとアイドルを'
            + 'スロットルが保持することになり、応答が遅くなって次のコンプレッサ投入で失速しえます。\n\n'
            + '書き換えるのは、この run の暖機 dwell が実際に載った行だけです。'
            + '500 rpm 列（失速キャッチ）と 11 kg/h 行（権限の床）は書きません。'
            + '縦軸は水温ではなく空気要求量なので、行番号で冷間かどうかを決めることはしません。',
    },
    en: {
        title: 'IDLE VALVE DUTY',
        census: 'Census',
        table: 'KF_LLS_TV',
        tableNote: 'Solid rows are the ones this run’s own warm dwells landed on. The 500 rpm column '
            + 'is the stall catch and the 11 kg/h row is the authority floor, so neither is ever written. '
            + 'The rest are dim because this run did not measure them, not because they are cold.',
        noWrite: 'nothing moves',
        pooled: (n: number) => `+${n} earlier runs on this BASE`,
        atHub: (n: number) => `The WRITE menu's IDLE row carries this — ${n} cells`,
        notYet: 'No proposal to write yet',
        sealed: 'WRITE SEALED — the target has no consumer',
        noTables: 'The idle tables could not be read from this BIN — KF_LLS_TV is not the configuration '
            + 'this tool describes.',
        limp: 'The idle valve was in limp-home. Nothing is derived from this run.',
        railed: 'The integrator was parked on a clamp. Out of authority is not a measurement.',
        info: 'Measures how far the idle governor’s I term MD_LLRI sits from where it is designed to '
            + 'rest, and writes that gap into **KF_LLS_TV** — the idle valve duty map, 0x9E10. The idle '
            + 'this car holds sits between breakpoints, so the correction is shared across the cells '
            + 'the DME interpolates, weighted. Capped at 3.0 % per cell per pass. The target is not '
            + 'zero because it is minus K_LFR_MDADAPT_OFFSET, read from your own BIN.\n\n'
            + '**Risk.** This changes how much air the engine gets at idle. Too much and idle sits high '
            + 'and hunts — this calibration has almost no way down (KL_LFR_TZ_NEG is all zeros, the P '
            + 'term only acts below target, and the only path back is a 5.12 s integrator). Too little '
            + 'and idle is held by the throttle instead of the valve, and the next compressor '
            + 'engagement can stall it.\n\n'
            + 'Only the rows this run’s own warm dwells landed on are written. The 500 rpm column is '
            + 'the stall catch and the 11 kg/h row is the authority floor, so neither ever is. The axis is '
            + 'air demand, not coolant, so nothing decides cold-versus-warm by row number.',
    },
};

interface Props {
    samples: IdleSample[];
    tables: IdleTables | null;
    result: IdleTuneResult | null;
    running: boolean;
    /** Drawn on the gauge rack now, not here. Kept on the props so the page has one place to pass it. */
    sourceProven?: boolean | null;
    /**
     * GONE from this panel, and named here so the absence is deliberate.
     *
     * Arming happens on the hub's WRITE row, which is where "what will the flash change" is
     * answered. `IdleWorkflow` still holds `onArm` — it disarms on START, so a new run cannot leave
     * the previous run's bytes armed — it just no longer hands a button to this pane.
     */
    onArm?: never;
    /** How many EARLIER runs on this same BASE are underneath the census and the proposal. */
    pooledRuns?: number;
}

export const IdlePanel: React.FC<Props> = ({ samples, tables, result, pooledRuns = 0 }) => {
    const lang = useDialogLang();
    const t = TEXT[lang === 'ja' ? 'ja' : 'en'];
    const [info, setInfo] = useState(false);
    const rep = result?.report;
    const target = tables?.idleTargetNm ?? 0;

    /**
     * The reasons a driver can act on, biggest first.
     *
     * The structural exclusions are filtered out. They fire on the same cells every run — 99
     * cold-row, 13 stall-column, 9 authority-floor-row on this binary — so sorted by count they took
     * three of the four slots and pushed the one actionable line (`throttle-open x 58`) to the
     * bottom. The map above says which cells they are by drawing them dim; this list is for the run.
     */
    const topRejects = useMemo(() => {
        if (!rep) return [];
        return (Object.entries(rep.rejects) as [IdleRejectReason, number][])
            .filter(([r, n]) => n > 0 && !STRUCTURAL_EXCLUSIONS.has(r))
            .sort((a, b) => b[1] - a[1])
            .slice(0, REJECT_ROWS);
    }, [rep]);

    /**
     * WHAT THE GRID IS DRAWN FROM.
     *
     * `MapEditor` rather than a table written here — it is the component the VE map, the diff, the
     * lambda grid and KF_RF_KORR_DRREL are all drawn with, and it has been generic over its axes and
     * labels since the rf_korr work. A second grid built beside it is a second grid that drifts:
     * this one already had different borders, a different header treatment and no coverage tint.
     *
     * `hits` is per-cell dwell samples, so the same ice-blue coverage fill that says "you have
     * driven this VE cell enough" says "the evidence landed here". `muted` dims the cells the writer
     * refuses. `tint` and `note` mark what moved.
     */
    /**
     * THE AXES AND THEIR UNITS, taken from the definition rather than typed here.
     *
     * The three carry three DIFFERENT units and the labels said only one of them: rows were
     * `ML_LL`, columns `RPM`, cells `LLS_TV %`, so the legend line read `ML_LL · RPM · LLS_TV %`
     * and the only unit on it was the one at the end. Read left to right that says all three are
     * per cent, and the rows are not — they are the air the engine is asking for, in kg/h. The
     * catalog has always been unambiguous (`y.units 'kg/h'`, `values.units '%'`); the screen was not.
     */
    const axes = useMemo(() => {
        const def = findEcuItem('KF_LLS_TV');
        if (!def || def.kind !== 'map') return null;
        return {
            row: `${def.y.label ?? 'ML_LL'} ${def.y.units}`,
            col: def.x.label ?? 'RPM',
            value: `LLS_TV ${def.values.units}`,
            /** The whole shape in one line, so the units are readable without opening the ⓘ. */
            summary: `0x${def.values.address.toString(16).toUpperCase()}`
                + ` · ${def.y.units} × ${def.x.units} → ${def.values.units}`,
        };
    }, []);

    const grid = useMemo(() => {
        if (!tables) return null;
        const y = tables.llsTv.y;
        const x = tables.llsTv.x;
        const cell = (r: number, c: number) => result?.cells[r]?.[c];
        return {
            map: {
                xAxis: x,
                yAxis: y,
                data: y.map((_, r) => x.map((__, c) => cell(r, c)?.tuned ?? tables.llsTv.values[r][c])),
            },
            hits: y.map((_, r) => x.map((__, c) => cell(r, c)?.samples ?? 0)),
            muted: y.map((_, r) => x.map((__, c) => !isWritableCell(r, c))),
            tint: (r: number, c: number) => {
                const k = cell(r, c);
                return k && k.tuned !== k.stock ? 'text-emerald-400' : undefined;
            },
            note: (r: number, c: number) => {
                const k = cell(r, c);
                if (!k || k.tuned === k.stock) return undefined;
                return `${k.stock.toFixed(2)} -> ${k.tuned.toFixed(2)} `
                    + `(${k.tuned > k.stock ? '+' : ''}${(k.tuned - k.stock).toFixed(2)})`;
            },
        };
    }, [tables, result]);

    /** The one line under the grid: which cells move and by how much. Always rendered. */
    const moved = useMemo(
        () => (result?.cells.flat() ?? []).filter(c => c.tuned !== c.stock),
        [result]);
    const movedCount = moved.length;

    return (
        /**
         * NOTHING HERE APPEARS OR DISAPPEARS WITH A RUN.
         *
         * Pressing START used to grow the census block and the ARM button and push the grid down the
         * page; stopping grew the moved-cell list on top of that. The reader's eye had to find the
         * table again after every transition. Every section below is rendered at every moment, with
         * a dash where there is no reading yet — which is also the honest thing to draw, because
         * "0 dwells accepted" before a run and "0 dwells accepted" after one are different facts and
         * a dash says the first one.
         *
         * The only thing that changes height is the info button, which the reader pressed.
         */
        <div className="space-y-3 text-slate-300">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
                <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-300">
                    <Wind className="h-3 w-3" />{t.title}
                </h3>
                <span className="ml-auto font-mono text-[10px] text-slate-500">
                    {samples.length} samples
                    {tables && <> · <span className="text-blue-400">{target.toFixed(1)} Nm</span></>}
                </span>
                <button type="button" onClick={() => setInfo(v => !v)} aria-expanded={info}
                    aria-label={t.title}
                    className={`-mr-1 rounded p-1 ${info ? 'text-blue-400' : 'text-slate-600 hover:text-slate-400'}`}>
                    <Info className="h-3 w-3" />
                </button>
            </div>

            {info && (
                <p className="whitespace-pre-line text-[10px] leading-relaxed text-slate-500">
                    {emph(t.info)}
                </p>
            )}

            {/* A RESERVED line for the three facts that invalidate everything under them. Empty
                rather than absent, so a run that goes wrong does not reflow the panel. */}
            <p className="h-[13px] truncate font-mono text-[10px] leading-none text-red-400">
                {!tables ? t.noTables : rep?.limpSeen ? t.limp : rep?.integratorRailed ? t.railed : ''}
            </p>

            <div className="space-y-2">
                {/* The pool is NAMED. A write standing on three drives while the screen says one
                    is a number the reader cannot check, and this session recorded only one of them. */}
                <SectionLabel trailing={rep
                    ? `${pooledRuns ? t.pooled(pooledRuns) + ' · ' : ''}gain ${rep.gainUsed.toFixed(3)}${rep.gainLearned ? ' learned' : ''}`
                    : 'gain —'}>
                    {t.census}
                </SectionLabel>
                <div className="grid grid-cols-5 gap-x-2">
                    <Stat label="DWELLS" value={rep?.dwellsFound ?? '—'} tone="text-slate-400" />
                    <Stat label="ACCEPTED" value={rep?.dwellsAccepted ?? '—'}
                        tone={!rep ? 'text-slate-600' : rep.dwellsAccepted === 0 ? 'text-red-400' : 'text-emerald-400'} />
                    <Stat label="ERROR" value={rep ? rep.worstErrorNm.toFixed(2) : '—'} tone="text-blue-400" />
                    <Stat label="UPDATED" value={rep?.cellsUpdated ?? '—'} tone="text-slate-200" />
                    <Stat label="CONVERGED" value={rep?.cellsConverged ?? '—'} tone="text-slate-400" />
                </div>
                {/* Exactly REJECT_ROWS lines, blank ones included. The list was 0 to 4 long and the
                    grid below it moved every time a reason appeared. */}
                <ul className="font-mono text-[10px] leading-[13px] text-slate-500">
                    {Array.from({ length: REJECT_ROWS }, (_, i) => {
                        const r = topRejects[i];
                        return (
                            <li key={i} className="flex h-[13px] gap-1.5">
                                {r && <>
                                    <span className="shrink-0 text-slate-400">{r[0]} × {r[1]}</span>
                                    <span className="min-w-0 truncate">
                                        — {REASON_TEXT[r[0]][lang === 'ja' ? 'ja' : 'en']}
                                    </span>
                                </>}
                            </li>
                        );
                    })}
                </ul>
            </div>

            <div className="space-y-1.5">
                {/* The units are IN the header, not behind the ⓘ. A unit is part of the number, not
                    an explanation of it — and rows, columns and cells carry three different ones. */}
                <SectionLabel trailing={axes
                    ? `${tables ? `${tables.llsTv.y.length}x${tables.llsTv.x.length} · ` : ''}${axes.summary}`
                    : undefined}>
                    {t.table}
                </SectionLabel>
                {/* THE SAME GRID THE VE MAP IS, at the VE map's own scale.
                    `!h-auto` beats MapEditor's own `h-full`, so the grid is exactly its thirteen
                    rows and never scrolls vertically. It had a 300 px box, which cut four rows off
                    and put a scrollbar inside a pane measured at 806 px wide with the table only
                    485 of them — a scroll invented by the container, not needed by the content.

                    No box around it either: the grid draws its own borders on every cell, and a
                    frame outside them is a second device on the same edge. */}
                <div>
                    {grid && (
                        <MapEditor
                            className="!h-auto"
                            mapData={grid.map}
                            hitData={grid.hits}
                            mutedCells={grid.muted}
                            cellTint={grid.tint}
                            cellNote={grid.note}
                            rowLabel={axes?.row}
                            colLabel={axes?.col}
                            valueLabel={axes?.value}
                            rowFormat={(v: number) => v.toFixed(0)}
                            valueFormat={(v: number) => v.toFixed(2)}
                            coverageThin={IDLE_TUNE_DEFAULTS.minCellSamples / 2}
                            coverageOk={IDLE_TUNE_DEFAULTS.minCellSamples}
                        />
                    )}
                </div>
                {/* One reserved line: what moves, and by how much. `title` has no hover on a phone,
                    so the delta has to be on the screen rather than only in the cell's tooltip. */}
                <p className="h-[13px] truncate font-mono text-[10px] leading-none text-slate-500">
                    {moved.length === 0 ? t.noWrite : moved.map(c =>
                        `${c.rpm} ${c.tuned > c.stock ? '+' : ''}${(c.tuned - c.stock).toFixed(2)}`).join('  ·  ')}
                </p>
                <p className="text-[9px] leading-relaxed text-slate-600">{t.tableNote}</p>
            </div>

            {/* NO ARM BUTTON. The hub's WRITE menu is the one place this app answers "what will
                the flash change", and a second control for the same decision is the confusion the
                DOWNLOAD BIN pair already taught this codebase — the same reason there is no START
                button on this panel either. What is left is one reserved line saying where the
                control is and what it would carry, which is the rule every hint here follows. */}
            <p className="h-[13px] truncate font-mono text-[10px] leading-none text-slate-500">
                {IDLE_WRITE_SEALED ? t.sealed
                    : result?.acceptable ? t.atHub(movedCount)
                        : t.notYet}
            </p>
        </div>
    );

};
