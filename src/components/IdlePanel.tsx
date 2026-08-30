import React, { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Wind } from 'lucide-react';
import type { IdleSample } from '@/lib/dme-link/types';
import type { IdleTables } from '@/lib/idle/idleTables';
import type { IdleTuneResult, IdleRejectReason } from '@/lib/idle/types';
import { useDialogLang } from '@/hooks/useDialogLang';
import { IDLE_WRITE_SEALED } from '@/lib/idle/seal';
import { IdlePreflight } from './IdlePreflight';

/**
 * The idle panel.
 *
 * The trace is the panel. Everything else on this screen is a number the driver could get another
 * way; the one thing they cannot get another way is a picture of `md_llri` sitting away from where
 * the governor is designed to leave it, with the accepted windows marked and the target and the
 * rails drawn in. That single view answers "is the feedforward wrong, and by how much" — which is
 * the whole question.
 *
 * Instrument shorthand stays English in both languages, per the rule in lib/dialog-text.ts. Prose
 * switches.
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
    // The two the retarget to KF_LLS_TV brought with it. `model-disagrees` is the one worth reading
    // first on a first capture: it is not a thin-evidence rejection, it is the map saying it is not
    // the map. See valveModel.ts.
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
    'off-breakpoint': { en: 'the evidence sat too far from this breakpoint', ja: '証拠がこのブレークポイントから離れすぎ' },
    'stall-column': { en: 'the 500 rpm column is the stall catch — warm evidence says nothing about it', ja: '500 rpm 列は失速キャッチ。暖機時の証拠では判断できない' },
    'cold-row': { en: 'not written from warm evidence', ja: '暖機時の証拠から冷間行は書かない' },
    'below-authority-floor': { en: 'the request would fall below where the valve responds at all', ja: 'アイドル弁が応答しなくなる領域まで下げる要求だった' },
    'sub-quantum': { en: 'converged — the map cannot express a smaller change', ja: '収束 ——これ以上細かい変更をマップが表現できない' },
};

const TEXT = {
    ja: {
        title: 'アイドル空気フィードフォワード',
        lede: 'アイドル調速器の I 項 MD_LLRI が「設計上そこに座るはずの値」からどれだけ外れているかを測ります。'
            + '**書き込みは封印中です** ——焼き込む先として選んだマップが、この較正では読まれていないため。'
            + '測定・採否・トレース・セッション保存は動きます。',
        sealed: '書き込み封印中 —— 書き込み先に読み手がいない',
        sealedBody1: 'この機能が書こうとしていた KF_LLR_QVS_GRUND は、この較正では誰にも読まれていません。'
            + 'lls_tv_calc (master 0x025D0A) の呼び出し元は 2 つあり、cfg_m.egas (XDF 0x8012) で排他選択されます。'
            + '実機 BIN でそのバイトは 0x00、XDF 自身の TXTEQ は 0 = Momentenmanager。'
            + 'つまり生きているのは llr_qsoll_calc ではなく egas_compute_throttle_target の側で、'
            + 'KF_LLS_TV は LLR_QSOLL ではなく ML_SOLL_LLS（トルク経路）で引かれます。',
        sealedBody2: '独立した傍証: LLR_QSOLL (0xFFEF1A) は 1 MB 中に絶対参照が 1 箇所しかなく、それは自分への書き込みです。'
            + 'なお、この機能が防御として掲げていた model gate では検出できません ——'
            + 'あれは LLR_QVS がマップから計算されていることを示すだけで、その先を誰かが読んでいることは示しません。'
            + '何を測って何に書くべきかは、逆アセンブルから決め直します。',
        procedure: '手順',
        procedureBody: '停車・ニュートラル・サイドブレーキ・水温 80 °C 以上。A/C OFF、ヘッドライトとブロワも OFF。'
            + 'ハンドルに触れないこと。**60 秒間そのまま静止**。これを 3 回、間に 2000 rpm を 30 秒挟む。',
        recording: '記録中 —— 停めるのはハブの STOP',
        useHub: 'ハブの START IDLE で記録を開始します',
        target: '目標',
        targetNote: 'ゼロではありません。K_LFR_MDADAPT_OFFSET の符号反転で、自車 BIN から読んだ値です。',
        noBin: 'BIN が読み込まれていません。',
        noTables: 'この BIN からアイドル系のテーブルを読めませんでした。'
            + 'K_LLR_Q_MCS または K_LLR_QSOLL_MIN が 0 でないか、KF_LLS_TV の第 1 行が下限レールに無い場合、'
            + 'このツールが前提としている構成と違うため実行しません。',
        census: '採否',
        dwells: 'dwell',
        accepted: '採用',
        error: '誤差',
        cells: 'セル',
        updated: '更新',
        converged: '収束',
        proposal: '提案',
        stock: '現在',
        tuned: '提案値',
        writeArm: 'この提案を書き込みに載せる',
        writeArmed: '書き込みに載せました',
        risk: 'リスク',
        riskBody: 'これはアイドルでエンジンに入る空気量を変えます。'
            + '**多すぎると**アイドルが高く張り付いてハンチングします ——この較正には下げる手段がほとんどありません'
            + '（KL_LFR_TZ_NEG は全ゼロ、P 項は回転が低い側でしか働かず、戻り道は 5.12 s の積分だけ）。'
            + '**少なすぎると**アイドルをアイドル弁ではなくスロットルが保持することになり、応答が遅くなって、'
            + '次のコンプレッサ投入や据切りで失速しえます。書き込むのは 80 °C 行だけです。',
        precondition: '前提（ツールからは確認できません）',
        preconditionBody: 'K_FR_T_ADAPT の系統。Terra プログラムの DME では充填レギュレータ適応が 384 秒ごとになり、'
            + 'まさにこの運転領域に定常誤差が残ります。0xE002 には触らないこと。fr_regler をログして可視化しています。',
        limp: 'アイドル弁が非常運転に入っていました。この run からは何も導出しません。',
        railed: '積分器がクランプに張り付いていました。権限を使い切った状態は測定値ではありません。',
        fallbackNote: 'このセッションは fallback プロファイルで走っています。zustand_motor と kkos_st が無いため、'
            + 'A/C の除外は自動ゲートではなく手順（A/C を切ること）に依存します。',
    },
    en: {
        title: 'IDLE AIR FEEDFORWARD',
        lede: 'Measures how far the idle governor’s I term MD_LLRI sits from where it is designed to '
            + 'rest. **Writing is sealed** — the map it was going to bake that gap into is not read in '
            + 'this calibration. Measurement, census, trace and the session store still run.',
        sealed: 'WRITE SEALED — the target has no consumer',
        sealedBody1: 'KF_LLR_QVS_GRUND, the map this was going to write, is read by nothing in this '
            + 'calibration. lls_tv_calc (master 0x025D0A) has two call sites, mutually exclusive on '
            + 'cfg_m.egas (XDF 0x8012). That byte is 0x00 in this image and the XDF’s own TXTEQ gives '
            + '0 = Momentenmanager, so the live caller is egas_compute_throttle_target rather than '
            + 'llr_qsoll_calc, and KF_LLS_TV is indexed on ML_SOLL_LLS — the torque path — not on '
            + 'LLR_QSOLL.',
        sealedBody2: 'Independent corroboration: LLR_QSOLL (0xFFEF1A) has exactly one absolute reference '
            + 'in the whole 1 MB image, and it is its own write site. The model gate this feature named '
            + 'as its defence would not have caught it — that gate shows LLR_QVS is computed from the '
            + 'map, never that anything downstream reads the result. What to measure and what to write '
            + 'are being re-derived from the disassembly.',
        procedure: 'Procedure',
        procedureBody: 'Stationary, neutral, handbrake on, coolant above 80 °C. A/C off, headlights and '
            + 'blower off, hands off the wheel. **Sit still for 60 s.** Three times, with 30 s at '
            + '~2000 rpm between.',
        recording: 'RECORDING — stop it at the hub',
        useHub: 'START IDLE at the hub begins a run',
        target: 'Target',
        targetNote: 'Not zero. Minus K_LFR_MDADAPT_OFFSET, read from your own BIN.',
        noBin: 'No BIN loaded.',
        noTables: 'The idle tables could not be read from this BIN. If K_LLR_Q_MCS or K_LLR_QSOLL_MIN is '
            + 'non-zero, or KF_LLS_TV’s first row is not at the lower rail, this is not the '
            + 'configuration this tool describes and it will not run.',
        census: 'Census',
        dwells: 'dwells',
        accepted: 'accepted',
        error: 'error',
        cells: 'cells',
        updated: 'updated',
        converged: 'converged',
        proposal: 'Proposal',
        stock: 'current',
        tuned: 'proposed',
        writeArm: 'Arm this proposal for writing',
        writeArmed: 'Armed for writing',
        risk: 'Risk',
        riskBody: 'This changes how much air the engine gets at idle. **Too much** and idle sits high and '
            + 'hunts — this calibration has almost no way down (KL_LFR_TZ_NEG is all zeros, the P term '
            + 'only acts below target, and the only path back is a 5.12 s integrator). **Too little** '
            + 'and idle is held by the throttle instead of the valve, which is slower, and the next '
            + 'compressor engagement can stall it. Only the 80 °C row is written.',
        precondition: 'Precondition (this tool cannot check it)',
        preconditionBody: 'The K_FR_T_ADAPT lineage. On a Terra-program DME the filling regulator adapts '
            + 'every 384 s instead of 1.5, leaving a standing error in exactly this operating region. Do '
            + 'not touch 0xE002. fr_regler is logged so a drifting regulator is at least visible.',
        limp: 'The idle valve was in limp-home. Nothing is derived from this run.',
        railed: 'The integrator was parked on a clamp. Out of authority is not a measurement.',
        fallbackNote: 'This session is on the fallback profile. Without zustand_motor and kkos_st, A/C '
            + 'exclusion is a procedure you follow rather than a gate this tool enforces.',
    },
};

interface Props {
    samples: IdleSample[];
    tables: IdleTables | null;
    result: IdleTuneResult | null;
    running: boolean;
    /** Arms the proposal for the next WRITE / download. Null disarms. */
    onArm?: (values: number[][] | null) => void;
    armed: boolean;
}

/**
 * The money view: MD_LLRI and the sum against time, with the target and the accepted windows drawn
 * in. Inline SVG rather than Plotly — this is one trace against one horizontal line, and the whole
 * point is that it renders instantly on a phone in a car park.
 *
 * Exported, and rendered by IdleWorkflow into the VISUALIZATION pane rather than inline here. It is
 * the picture this screen is for, and the app already has one place where the picture goes; leaving
 * it buried in the middle of a column of prose put it below the fold on the layout it matters most
 * on. `h-full` rather than a fixed height for the same reason — that pane sizes it now.
 */
export const IdleTrace: React.FC<{ samples: IdleSample[]; result: IdleTuneResult | null; target: number }> =
    ({ samples, result, target }) => {
        const pts = useMemo(() => samples.filter(s => s.mdLlri !== null), [samples]);
        if (pts.length < 2) return null;

        const W = 640;
        const H = 150;
        const t0 = pts[0].time;
        const t1 = pts[pts.length - 1].time || 1;
        const vals = pts.flatMap(s => [s.mdLlri as number, (s.mdLlri as number) + (s.mdLlra ?? 0)]);
        const lo = Math.min(target - 2, ...vals);
        const hi = Math.max(target + 2, ...vals);
        const x = (t: number) => ((t - t0) / Math.max(1e-6, t1 - t0)) * W;
        const y = (v: number) => H - ((v - lo) / Math.max(1e-6, hi - lo)) * H;

        const path = (get: (s: IdleSample) => number) =>
            pts.map((s, i) => `${i ? 'L' : 'M'}${x(s.time).toFixed(1)},${y(get(s)).toFixed(1)}`).join('');

        return (
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-full">
                {/* Accepted windows first, so the traces sit on top of them. */}
                {result?.dwells.filter(d => !d.rejected).map((d, i) => (
                    <rect key={i} x={x(samples[d.startIndex]?.time ?? t0)} y={0}
                        width={Math.max(1, x(samples[d.endIndex]?.time ?? t0) - x(samples[d.startIndex]?.time ?? t0))}
                        height={H} fill="#4ade80" opacity={0.12} />
                ))}
                {/* The target. The single most important line on the screen. */}
                <line x1={0} x2={W} y1={y(target)} y2={y(target)} stroke="#60a5fa" strokeWidth={1} strokeDasharray="4 3" />
                <text x={4} y={y(target) - 3} fill="#60a5fa" fontSize={9} fontFamily="monospace">
                    target {target.toFixed(1)} Nm
                </text>
                <path d={path(s => (s.mdLlri as number) + (s.mdLlra ?? 0))} fill="none" stroke="#f59e0b" strokeWidth={1.5} />
                <path d={path(s => s.mdLlri as number)} fill="none" stroke="#e5e7eb" strokeWidth={1} opacity={0.7} />
            </svg>
        );
    };

export const IdlePanel: React.FC<Props> = ({ samples, tables, result, running, onArm, armed }) => {
    const lang = useDialogLang();
    const t = TEXT[lang === 'ja' ? 'ja' : 'en'];
    const rep = result?.report;
    const target = tables?.idleTargetNm ?? 0;

    const topRejects = useMemo(() => {
        if (!rep) return [];
        return (Object.entries(rep.rejects) as [IdleRejectReason, number][])
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4);
    }, [rep]);

    const warmRow = result ? result.cells[result.cells.length - 1] : null;
    const onFallback = samples.length > 0 && samples.every(s => s.engineState === null);

    return (
        <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2">
                <Wind className="w-4 h-4 text-sky-400" />
                <h2 className="font-mono tracking-wide">{t.title}</h2>
            </div>
            <p className="text-white/70 leading-relaxed">{t.lede}</p>

            {!tables && (
                <p className="flex gap-2 text-amber-300"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{t.noTables}</p>
            )}

            <div className="rounded border border-white/10 p-3 space-y-1">
                <div className="font-mono text-xs text-white/50">{t.procedure}</div>
                <p className="text-white/80 leading-relaxed">{t.procedureBody}</p>
            </div>

            {/* No START button here. The hub is the one place that answers "what do I do next", and
                a second control for the same action is the confusion the DOWNLOAD BIN pair already
                taught this codebase. This says where the control is instead. */}
            <div className="flex items-center gap-3 font-mono text-xs">
                <span className={running ? 'text-amber-400' : 'text-white/50'}>
                    {running ? t.recording : t.useHub}
                </span>
                <span className="text-white/50">
                    {samples.length} samples
                    {tables && <> · {t.target} <span className="text-sky-300">{target.toFixed(1)} Nm</span></>}
                </span>
            </div>
            {tables && <p className="text-xs text-white/40">{t.targetNote}</p>}

            {/* Above the census on purpose. This is not a quality score on the run — it is whether
                the run is a measurement at all, and reading it after the numbers would be reading it
                too late. */}
            <IdlePreflight samples={samples} tables={tables} />

            {onFallback && (
                <p className="flex gap-2 text-amber-300 text-xs">
                    <AlertTriangle className="w-4 h-4 shrink-0" />{t.fallbackNote}
                </p>
            )}

            {rep && (
                <div className="font-mono text-xs space-y-1">
                    <div className={rep.dwellsAccepted === 0 ? 'text-red-400' : 'text-white/80'}>
                        {t.census}: {rep.dwellsFound} {t.dwells} · {rep.dwellsAccepted} {t.accepted}
                        {' · '}{t.error} {rep.worstErrorNm.toFixed(2)} Nm
                        {' · '}{t.cells} {rep.cellsUpdated} {t.updated} / {rep.cellsConverged} {t.converged}
                        {' · gain '}{rep.gainUsed.toFixed(3)}{rep.gainLearned ? ' (learned)' : ''}
                    </div>
                    {topRejects.length > 0 && (
                        <ul className="text-white/50 space-y-0.5">
                            {topRejects.map(([r, n]) => (
                                <li key={r}>{r} × {n} — {REASON_TEXT[r][lang === 'ja' ? 'ja' : 'en']}</li>
                            ))}
                        </ul>
                    )}
                    {rep.limpSeen && <div className="text-red-400">{t.limp}</div>}
                    {rep.integratorRailed && <div className="text-red-400">{t.railed}</div>}
                </div>
            )}

            {warmRow && (
                <div className="space-y-2">
                    <div className="font-mono text-xs text-white/50">{t.proposal} — {result!.tmotAxis[result!.tmotAxis.length - 1]} °C</div>
                    <table className="w-full font-mono text-xs">
                        <thead className="text-white/40">
                            <tr><th className="text-left">RPM</th><th className="text-right">{t.stock}</th>
                                <th className="text-right">{t.tuned}</th><th className="text-right">Nm</th>
                                <th className="text-left pl-3">—</th></tr>
                        </thead>
                        <tbody>
                            {warmRow.map(c => (
                                <tr key={c.col} className={c.tuned !== c.stock ? 'text-emerald-300' : 'text-white/50'}>
                                    <td>{c.rpm}</td>
                                    <td className="text-right">{c.stock.toFixed(1)}</td>
                                    <td className="text-right">{c.tuned.toFixed(1)}</td>
                                    <td className="text-right">{c.errorNm ? c.errorNm.toFixed(2) : '—'}</td>
                                    <td className="pl-3 text-white/40">
                                        {c.rejected
                                            ? <span className="flex items-center gap-1">
                                                {c.converged ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <CircleSlash className="w-3 h-3" />}
                                                {REASON_TEXT[c.rejected][lang === 'ja' ? 'ja' : 'en']}
                                            </span>
                                            : `${c.dwells} dwells · ${c.samples} samples`}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
                <div className="font-mono text-xs text-amber-300">{t.risk}</div>
                <p className="text-white/80 leading-relaxed text-xs">{t.riskBody}</p>
            </div>

            {/* No ARM button while the write is sealed. The proposal above is still computed and
                still worth reading — the arithmetic is not what is in doubt — but it cannot reach a
                byte, and a button that armed something the patcher refuses would be a lie about what
                happens next. See lib/idle/seal.ts for the disassembly. */}
            {IDLE_WRITE_SEALED ? (
                <div className="rounded border border-red-500/40 bg-red-500/5 p-3 space-y-2">
                    <div className="font-mono text-xs text-red-300">{t.sealed}</div>
                    <p className="text-white/80 leading-relaxed text-xs">{t.sealedBody1}</p>
                    <p className="text-white/70 leading-relaxed text-xs">{t.sealedBody2}</p>
                </div>
            ) : result?.acceptable && onArm && (
                <button
                    onClick={() => onArm(armed ? null : result.tuned)}
                    className={`px-4 py-2 rounded font-mono text-xs tracking-wider
                        ${armed ? 'bg-emerald-600/80' : 'bg-white/10 hover:bg-white/20'}`}
                >
                    {armed ? t.writeArmed : t.writeArm}
                </button>
            )}

            <div className="rounded border border-white/10 p-3 space-y-1">
                <div className="font-mono text-xs text-white/50">{t.precondition}</div>
                <p className="text-white/60 leading-relaxed text-xs">{t.preconditionBody}</p>
            </div>
        </div>
    );
};
