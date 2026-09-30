import React, { useMemo, useState } from 'react';
import { Waves, Info } from 'lucide-react';
import { MapEditor } from './MapEditor';
import { emph, Stat, SectionLabel } from './IdleNote';
import { useDialogLang } from '@/hooks/useDialogLang';
import { RING_GAIN_DEFAULTS, type RingTables, type LlsTvEdit } from '@/lib/lls/ringGain';
import type { LlsSample, LlsSessionSummary } from '@/lib/lls/fromLog';

/**
 * The micro-throttle surface: what the drive measured, what the ring is worth, and what the solve
 * would write.
 *
 * Presentation only. It proposes nothing and arms nothing — `onArm?: never` is the same type-level
 * prohibition IdlePanel carries, for the same reason: the hub's WRITE menu is the one place this
 * app answers "what will the flash change", and a second control for that decision is the
 * confusion DOWNLOAD BIN already taught this codebase.
 *
 * Nothing here appears or disappears with a run. Every section renders at every moment with a dash
 * where there is no reading yet, because "no Td" before a drive and "no Td" after one are different
 * facts and a dash says the first.
 */

const TEXT = {
    en: {
        title: 'LLS RING',
        info: 'At small pedal the throttle is pinned shut and the idle valve carries all the air. '
            + 'The only live controller is a pure integrator, and the filling it works against is '
            + 'not measured — it is **kf_rf_soll’s own output**, so the loop closes inside the '
            + 'model.\n\n**Elasticity** is how much filling the model returns for the air asked '
            + 'for. 1.00 is consistent. Higher means every correction overshoots, the crossover '
            + 'climbs, and against the measured loop delay the phase margin thins until steering '
            + 'load is amplified instead of absorbed.\n\nThe solve rebuilds KF_LLS_TV as the '
            + 'inverse of the three maps downstream of it. **Row 20 is held**, so the idle point '
            + 'does not move and IDLE keeps the cells it needs.',
        drive: 'DRIVE',
        ring: 'RING',
        table: 'KF_LLS_TV',
        loading: 'READING CALIBRATION…',
        noTables: 'This image is missing one of the six tables the ring is made of — nothing can be solved from it.',
        notRolling: 'No rolling samples. A micro-throttle run has to be DRIVEN: 8-11 km/h with the throttle shut.',
        offBand: 'The drive never reached the rows this solves. It needs 18 to 45 kg/h of air, throttle on the floor.',
        offPoint: 'Little of this drive is comparable with the reference — its numbers cannot be read against Session 954.',
        noWrite: 'Nothing to write.',
        atHub: (n: number) => `${n} cell(s) ready — arm on the hub’s WRITE menu, LLS row.`,
        notYet: 'Drive first. The solve needs a run to say which rows it may touch.',
        held: 'HELD',
        tableNote: 'Rows outside the measured band are never written, and the anchor is held by '
            + 'definition. Values are XDF display per cent; one stored step is 0.02.',
        anchor: 'ANCHOR',
        idleLost: (pct: number) => `IDLE keeps ${pct} % of its own idle point`,
        idleZero: 'IDLE cannot reach warm idle at all — it will not converge while this is armed',
        measured: 'measured',
        computed: 'computed',
        direct: 'LLS_TV / ML_SOLL_LLS read',
        reconstructed: 'duty inverted from AQ_REL',
    },
    ja: {
        title: 'LLS RING',
        info: '微開ではスロットルは閉じたままで、空気は全量アイドルバルブが運びます。'
            + '生きている制御は純積分器だけで、その相手の充填率は実測ではなく'
            + '**kf_rf_soll 自身の出力**です。つまりループはモデルの中で閉じています。\n\n'
            + '**弾性**は、要求した空気に対してモデルが返す充填率の比です。1.00 なら整合。'
            + '大きいほど毎回の補正が行き過ぎ、交差周波数が上がり、実測の一巡遅れに対して'
            + '位相余裕が痩せて、操舵の負荷が吸収されず増幅されます。\n\n'
            + 'この計算は KF_LLS_TV を下流 3 枚の逆関数として組み直します。'
            + '**行 20 は据え置く**ので、アイドル点は動かず、IDLE も必要なセルを保ちます。',
        drive: 'DRIVE',
        ring: 'RING',
        table: 'KF_LLS_TV',
        loading: 'READING CALIBRATION…',
        noTables: 'この BIN にはリングを構成する 6 枚のうち欠けているものがあります。計算できません。',
        notRolling: '転がっているサンプルがありません。微開走行は「走る」必要があります —— 8〜11 km/h、スロットルは閉じたまま。',
        offBand: 'この走行は対象の行に届いていません。スロットルは床、空気量 18〜45 kg/h が要ります。',
        offPoint: 'この走行は基準の動作点にほとんど乗っていません。Session 954 と並べて読むことはできません。',
        noWrite: '書くものはありません。',
        atHub: (n: number) => `${n} セル準備できました —— ハブの WRITE メニュー、LLS の行で arm します。`,
        notYet: '先に走ってください。どの行を触ってよいかは走行が決めます。',
        held: 'HELD',
        tableNote: '実測帯の外の行は書きません。アンカーは定義上不変です。値は XDF 表示 %、格納 1 ステップは 0.02。',
        anchor: 'ANCHOR',
        idleLost: (pct: number) => `IDLE のアイドル点到達率 ${pct} %`,
        idleZero: 'IDLE はアイドル点にまったく届きません —— これを arm している間は収束しません',
        measured: '実測',
        computed: '計算',
        direct: 'LLS_TV / ML_SOLL_LLS 直読',
        reconstructed: 'AQ_REL から逆算',
    },
} as const;

interface Props {
    samples: readonly LlsSample[];
    tables: RingTables | null;
    summary: LlsSessionSummary | null;
    edits: readonly LlsTvEdit[] | null;
    running: boolean;
    /** The CALIBRATION artifact is still being fetched. A different fact from "this image has no
     *  such table", and the reserved line has to say which — otherwise a slow network reads as a
     *  broken binary. */
    catalogLoading?: boolean;
    /** The row the solve holds. Selectable: see RingGainOptions.anchorMlKgH for what it costs. */
    anchorMlKgH: number;
    onAnchorChange: (ml: number) => void;
    /**
     * What IDLE could still move at warm idle if this were armed, 0-1.
     *
     * Not decoration and not a warning badge: at 0 the mode that controls idle cannot reach its own
     * operating point at all, and this car has a recorded failure from being at 37 %.
     */
    idleReach: number | null;
    /** Deliberately impossible. Arming is the hub's, not this panel's. */
    onArm?: never;
}

const dash = '—';
const fmt = (v: number | null | undefined, digits: number, suffix = '') =>
    v === null || v === undefined || !Number.isFinite(v) ? dash : v.toFixed(digits) + suffix;

const LlsPanel: React.FC<Props> = ({
    samples, tables, summary, edits, running, catalogLoading = false,
    anchorMlKgH, onAnchorChange, idleReach,
}) => {
    const lang = useDialogLang();
    const t = TEXT[lang];
    const [info, setInfo] = useState(false);

    const anchor = anchorMlKgH;
    // What the solve will actually write: the rows the drive reached, minus the anchor it holds.
    const writable = useMemo(
        () => (summary?.reachedRows ?? RING_GAIN_DEFAULTS.writableMlKgH).filter(ml => ml !== anchor),
        [summary, anchor]);
    // Anchor candidates are rows the drive reached — anchoring on a cell the car never visited
    // pins the whole column to a number nothing measured.
    const anchorChoices = useMemo(
        () => (summary?.reachedRows?.length ? summary.reachedRows : tables?.llsTv.y ?? []),
        [summary, tables]);

    const grid = useMemo(() => {
        if (!tables) return null;
        const y = tables.llsTv.y;
        const x = tables.llsTv.x;
        const editAt = (r: number, c: number) =>
            edits?.find(e => e.mlKgH === y[r] && e.rpm === x[c]) ?? null;
        return {
            map: {
                xAxis: x,
                yAxis: y,
                data: y.map((_, r) => x.map((__, c) => editAt(r, c)?.afterPct ?? tables.llsTv.values[r][c])),
            },
            // Rows this solve may never touch read as muted, so the grid says the rule rather than
            // leaving the reader to infer it from which cells happen to have moved.
            muted: y.map(ml => x.map(() => !writable.includes(ml))),
            tint: (r: number, c: number) => {
                const e = editAt(r, c);
                if (!e) return undefined;
                const d = e.afterPct - e.beforePct;
                if (Math.abs(d) < 0.02) return undefined;
                // M-red for a cell that opens further, M-blue for one that closes — the same
                // signed convention the diff map uses.
                const a = Math.min(0.7, Math.max(0.1, (Math.abs(d) / 6) * 0.6));
                return d > 0 ? `rgba(241,26,34,${a})` : `rgba(10,155,219,${a})`;
            },
            note: (r: number, c: number) => {
                if (y[r] === anchor) return t.held;
                const e = editAt(r, c);
                if (!e) return undefined;
                const d = e.afterPct - e.beforePct;
                return `${e.beforePct.toFixed(1)} → ${e.afterPct.toFixed(2)} (${d > 0 ? '+' : ''}${d.toFixed(2)})`;
            },
        };
    }, [tables, edits, anchor, writable, t.held]);

    const moved = useMemo(
        () => (edits ?? []).filter(e => Math.abs(e.afterPct - e.beforePct) >= 0.02),
        [edits]);

    const reachedOk = (summary?.reachedRows.length ?? 0) > 0;
    const problem = catalogLoading ? t.loading
        : !tables ? t.noTables
        : summary && summary.rolling === 0 ? t.notRolling
            : summary && !reachedOk ? t.offBand
                : summary && summary.onTargetShare !== null && summary.onTargetShare < 0.25 ? t.offPoint
                    : '';

    return (
        <div className="space-y-3 text-slate-300">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
                <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-300">
                    <Waves className="h-3 w-3" />{t.title}
                </h3>
                <span className="ml-auto font-mono text-[10px] text-slate-500">
                    {samples.length} samples
                    {summary && <> · <span className="text-blue-400">{summary.rolling} rolling</span></>}
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

            {/* RESERVED: the facts that invalidate everything under them. */}
            <p className="h-[13px] truncate font-mono text-[10px] leading-none text-red-400">{problem}</p>

            <div className="space-y-2">
                {/* Provenance is permanent text, not a tooltip: Td is measured at ONE operating
                    point on ONE log, and a reader deciding whether to trust 0.58 s needs that on
                    screen rather than on hover, which a phone does not have. */}
                <SectionLabel trailing={summary
                    ? `${fmt(summary.cadenceHz, 2)} Hz · ${summary.source === 'direct' ? t.direct : t.reconstructed}`
                    : undefined}>
                    {t.drive}
                </SectionLabel>
                <div className="grid grid-cols-7 gap-x-2">
                    <Stat label="Td" value={fmt(summary?.td?.lagS, 2, ' s')}
                        tone={summary?.td ? 'text-blue-400' : 'text-slate-600'} />
                    <Stat label="r" value={fmt(summary?.td?.r, 2)} tone="text-slate-400" />
                    <Stat label="DUTY" value={summary?.duty
                        ? `${summary.duty.min.toFixed(0)}-${summary.duty.max.toFixed(0)}` : dash}
                        tone="text-slate-200" />
                    <Stat label="AIR KG/H" value={summary?.ml
                        ? `${summary.ml.min.toFixed(1)}-${summary.ml.max.toFixed(1)}` : dash}
                        tone="text-slate-200" />
                    <Stat label="ROWS" value={summary?.reachedRows.length ? summary.reachedRows.join(' ') : dash}
                        tone={reachedOk ? 'text-emerald-400' : 'text-slate-600'} />
                    {/* The integrator. Dashed on every log recorded before the channel existed,
                        which is the honest reading — it was never absent, it was never asked for. */}
                    <Stat label="FR p-p" value={summary?.frRegler
                        ? (summary.frRegler.max - summary.frRegler.min).toFixed(3) : dash}
                        tone={summary?.frRegler ? 'text-blue-400' : 'text-slate-600'} />
                    {/* The same verdict the live strip showed during the run, from the same
                        function — so "it looked green" and "the log says so" cannot diverge. */}
                    <Stat label="ON POINT" value={summary?.onTargetShare === null
                        || summary?.onTargetShare === undefined
                        ? dash : `${(summary.onTargetShare * 100).toFixed(0)}%`}
                        tone={!summary || summary.onTargetShare === null ? 'text-slate-600'
                            : summary.onTargetShare >= 0.6 ? 'text-emerald-400' : 'text-red-400'} />
                </div>
            </div>

            <div className="space-y-2">
                <SectionLabel trailing={summary ? `PM ${t.computed}` : undefined}>{t.ring}</SectionLabel>
                <div className="grid grid-cols-5 gap-x-2">
                    <Stat label="ELAST" value={fmt(summary?.elasticity?.median, 2)}
                        tone={!summary?.elasticity ? 'text-slate-600'
                            : Math.abs(summary.elasticity.median - 1) < 0.15 ? 'text-emerald-400' : 'text-red-400'} />
                    <Stat label="PM MEAN" value={fmt(summary?.phaseMarginDeg?.median, 0, '°')}
                        tone="text-blue-400" />
                    <Stat label="PM P10" value={fmt(summary?.phaseMarginDeg?.p5, 0, '°')}
                        tone="text-slate-400" />
                    <Stat label="THIN" value={summary?.thinMarginShare === null
                        || summary?.thinMarginShare === undefined
                        ? dash : `${(summary.thinMarginShare * 100).toFixed(1)}%`}
                        tone={!summary || summary.thinMarginShare === null ? 'text-slate-600'
                            : summary.thinMarginShare > 0.1 ? 'text-red-400' : 'text-emerald-400'} />
                    <Stat label="MOVES" value={edits ? moved.length : dash}
                        tone={moved.length ? 'text-indigo-400' : 'text-slate-600'} />
                </div>
            </div>

            <div className="space-y-1.5">
                <SectionLabel trailing={tables
                    ? `${tables.llsTv.y.length}x${tables.llsTv.x.length} · rpm × kg/h · duty %`
                    : undefined}>
                    <span className="inline-flex items-center gap-2">
                        {t.table}
                        {/* A lifted chip wrapping a bare select, the house selector. The anchor is
                            a choice with a measured cost on either side, so it is on the surface
                            rather than a constant somebody has to read the source to find. */}
                        <span className="inline-flex items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5">
                            <span className="text-[8px] font-bold uppercase tracking-widest text-slate-500">
                                {t.anchor}
                            </span>
                            <select
                                value={anchor}
                                onChange={e => onAnchorChange(Number(e.target.value))}
                                className="bg-transparent font-mono text-[10px] text-blue-400 outline-none"
                            >
                                {anchorChoices.map(ml => (
                                    <option key={ml} value={ml} className="bg-slate-900">{ml}</option>
                                ))}
                            </select>
                        </span>
                    </span>
                </SectionLabel>
                <div>
                    {grid && (
                        <MapEditor
                            className="!h-auto"
                            mapData={grid.map}
                            mutedCells={grid.muted}
                            cellTint={grid.tint}
                            cellNote={grid.note}
                            rowLabel="ml_ll kg/h"
                            colLabel="rpm"
                            valueLabel="duty %"
                            rowFormat={(v: number) => v.toFixed(0)}
                            valueFormat={(v: number) => v.toFixed(2)}
                        />
                    )}
                </div>
                {/* RESERVED: what moves. On screen rather than in a title, because there is no
                    hover on a phone and this is the line that says what the flash would change. */}
                <p className="h-[13px] truncate font-mono text-[10px] leading-none text-slate-500">
                    {moved.length === 0 ? t.noWrite : moved.map(e =>
                        `${e.rpm}/${e.mlKgH} ${e.afterPct > e.beforePct ? '+' : ''}${(e.afterPct - e.beforePct).toFixed(2)}`
                    ).join('  ·  ')}
                </p>
                <p className="text-[9px] leading-relaxed text-slate-600">{t.tableNote}</p>
            </div>

            {/* RESERVED: where the control is, and what it would carry. No ARM button here. */}
            <p className="h-[13px] truncate font-mono text-[10px] leading-none text-slate-500">
                {running ? '' : moved.length ? t.atHub(moved.length) : t.notYet}
            </p>
            {/* RESERVED: what this anchor costs the other mode. Empty only when it costs nothing.
                Red rather than violet at zero, because that is not a caution — at zero the idle
                corrector has no authority left at its own operating point. */}
            <p className={`h-[13px] truncate font-mono text-[10px] leading-none ${
                idleReach === 0 ? 'text-red-400' : 'text-indigo-400'}`}>
                {idleReach === null || idleReach >= 0.999 ? ''
                    : idleReach === 0 ? t.idleZero
                        : t.idleLost(Math.round(idleReach * 100))}
            </p>
        </div>
    );
};

export default LlsPanel;
