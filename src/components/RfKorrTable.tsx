'use client';

import React, { useState } from 'react';
import { ListTree } from 'lucide-react';
import { MapEditor } from './MapEditor';
import { EcuItemList } from './EcuItemList';
import { DialogFrame } from './DialogFrame';
import { RfKorrTuneResult, RejectReason } from '@/lib/ve-calculator/rfKorrTuner';
import {
    RF_KORR_COL_LABEL, RF_KORR_ROW_LABEL, RF_KORR_VALUE_LABEL, RfKorrView, rfKorrViewData,
} from '@/lib/ve-calculator/rfKorrView';
import { useDialogLang } from '@/hooks/useDialogLang';

/** Why a cell was left alone — or, for `extrapolated`, how a written cell got its value — in the
 *  reader's language. Kept short — this lands in a tooltip. */
const REASON_TEXT: Record<RejectReason | 'extrapolated', { en: string; ja: string }> = {
    'no-evidence': {
        en: 'no samples reached this rpm at this exhaust delta',
        ja: 'この回転数・Δ にサンプルが来ていない',
    },
    'thin-count': {
        en: 'too few samples to stand for this cell',
        ja: 'サンプル数が足りない',
    },
    'thin-weight': {
        en: 'samples sat too far from this breakpoint to carry it',
        ja: 'ブレークポイントから離れすぎで重みが足りない',
    },
    'single-ve-cell': {
        en: 'only one VE cell contributed — one bad anchor must not become a table entry',
        ja: '寄与した VE セルが 1 つだけ（アンカー 1 個で表を書かせない）',
    },
    'spread': {
        en: 'samples here disagreed by more than 15 % — the separable model is failing',
        ja: 'セル内のばらつきが 15 % 超（負荷と温度が分離できていない）',
    },
    'identity-column': {
        en: 'BMW pinned this rpm column at 1.000 — measured, deliberately not written',
        ja: 'BMW が 1.000 に固定した列。測定はするが書き換えない',
    },
    'identity-row': {
        en: 'the zero-delta row every other row is measured against — never written',
        ja: '他の全行の基準となる Δ=0 行。書き換えない',
    },
    'off-breakpoint': {
        en: 'the samples sat too far from this delta to speak for it — extrapolation, not measurement',
        ja: 'サンプルがこの Δ から離れすぎ（測定ではなく外挿になる）',
    },
    'extrapolated': {
        en: 'no post-ramp data reaches this row — filled with the shrink ratio of the highest measured row',
        ja: '減量後のデータが届かない行。測れた最上段の縮め率で埋めた',
    },
};

const TEXT = {
    en: {
        tuned: 'TUNED', stock: 'STOCK', diff: 'CHANGE %',
        axes: 'Rows = model EGT minus measured, °C · Columns = rpm',
        updated: (n: number) => `${n} of 72 cells updated`,
        largest: (v: number) => `largest change ${v >= 0 ? '+' : ''}${v.toFixed(3)}`,
        used: (n: number) => `${n} samples used`,
        hysteresis: (n: number) => `${n} dropped in the hysteresis band`,
        gateShut: (n: number) => `${n} below the filling floor (correction not running)`,
        notSettled: (n: number) => `${n} with RF or EGT still moving`,
        noGateOpen: 'This drive never held the engine above the correction\'s filling floor for '
            + 'long enough to measure it, so nothing here was derived from the log. rf_korr only '
            + 'runs above 55-80 % filling and above 20 km/h — it needs sustained load, held for '
            + 'seconds, not throttle stabs.',
        kHeld: 'K HOLD was on for this drive, so rf_korr never engaged and there is nothing to '
            + 'derive the table from. Turn K HOLD off and drive again.',
        veNotAnchored: 'The trim where rf_korr was off is not near 1.000, so the VE cannot anchor '
            + 'this table yet. Run VE with K HOLD first.',
        thin: 'Nothing here is written unless a cell had samples from at least two VE cells that '
            + 'agreed to within 15 %, or sits above the highest such row and follows its shrink. '
            + 'Everything else keeps its stock value byte for byte.',
        provisional: 'PROVISIONAL — too few cells moved to be worth writing',
        ecu: 'ECU PARAMETERS',
        close: 'Close',
    },
    ja: {
        tuned: 'TUNED', stock: 'STOCK', diff: 'CHANGE %',
        axes: '行 = モデル排気温 − 実測, °C ／ 列 = 回転数',
        updated: (n: number) => `72 セル中 ${n} セルを更新`,
        largest: (v: number) => `最大変化 ${v >= 0 ? '+' : ''}${v.toFixed(3)}`,
        used: (n: number) => `使ったサンプル ${n} 個`,
        hysteresis: (n: number) => `ヒステリシス帯で除外 ${n} 個`,
        gateShut: (n: number) => `充填率下限未満で除外 ${n} 個（補正が動いていない領域）`,
        notSettled: (n: number) => `RF / 排気温が整定しておらず除外 ${n} 個`,
        noGateOpen: 'この走行では補正の充填率下限を十分な時間超えていないため、'
            + 'ログからは何も導出していません。rf_korr は充填率 55〜80 % 以上かつ 20 km/h 以上でしか'
            + '作動しません。数秒間持続する高負荷が必要で、短いアクセル煽りでは測定できません。',
        kHeld: 'この走行は K HOLD 中で rf_korr が一度も掛かっていないため、表を導出できません。'
            + 'K HOLD を切って走ってください。',
        veNotAnchored: 'rf_korr の掛かっていない区間のトリムが 1.000 から外れていて、VE がまだ'
            + 'この表のアンカーになりません。先に K HOLD で VE を詰めてください。',
        thin: '2 つ以上の VE セルから来たサンプルが 15 % 以内で一致したセルと、その最上段より上で'
            + '縮め率に従うセルだけを書き換えます。それ以外は純正値のままバイト単位で不変です。',
        provisional: 'PROVISIONAL — 書き込むには更新セルが少なすぎます',
        ecu: 'ECU パラメータ',
        close: '閉じる',
    },
};

/**
 * The back-calculated KF_RF_KORR_DRREL, on its own axes.
 *
 * Three views of one result rather than three tables. STOCK is what the loaded binary holds, TUNED
 * is what would be written, and CHANGE % is the difference — which is the only one of the three
 * that answers "did this log actually say anything", because an untouched cell reads exactly 0.
 *
 * The selection is the CALLER's, not this component's. It used to be local state here, which meant
 * the 3D surface rendered beside this table could not see it: the grid switched between the three
 * and the surface stayed on TUNED, with nothing on screen admitting they were showing different
 * things. Both now read `rfKorrViewData` from the same selection.
 *
 * Deliberately NOT carrying the rf_korr mode control. It was put here and taken out again: the
 * choice belongs with the session's other reproducible settings in RAW FILTER, one copy, and a
 * second instance on this tab was two places to change one thing for no gain.
 */
export const RfKorrTable: React.FC<{
    result: RfKorrTuneResult;
    zoom?: number;
    view: RfKorrView;
    onViewChange: (view: RfKorrView) => void;
    /** The loaded BIN, for the calibration this table was derived FROM. */
    buffer: ArrayBuffer | null;
}> = ({ result, zoom = 1, view, onViewChange, buffer }) => {
    const lang = useDialogLang();
    const t = TEXT[lang];
    const { report } = result;
    const [ecuOpen, setEcuOpen] = useState(false);

    const { map, changePercent } = rfKorrViewData(result, view);

    const note = (r: number, c: number) => {
        const parts: string[] = [];
        if (result.updated[r][c]) {
            parts.push(`stock ${result.stock[r][c].toFixed(3)} -> tuned ${result.tuned[r][c].toFixed(3)}`);
            // Written without evidence of its own, so the measured/spread pair below would describe
            // samples that did not decide it — or none at all.
            if (result.extrapolated[r][c]) {
                parts.push(REASON_TEXT.extrapolated[lang]);
                return parts.join('\n');
            }
            if (Math.abs(result.measuredMap[r][c] - result.tuned[r][c]) > 0.0005) {
                // The clamp bit here. Saying so is the difference between "the log said this" and
                // "this is what will be written", and they are not the same number.
                parts.push(`measured ${result.measuredMap[r][c].toFixed(3)} (limited)`);
            }
            parts.push(`spread ${result.spreadMap[r][c].toFixed(3)}`);
        } else {
            const reason = result.rejected[r][c];
            parts.push(reason ? REASON_TEXT[reason][lang] : 'unchanged');
            if (result.countMap[r][c] > 0) {
                parts.push(`measured ${result.measuredMap[r][c].toFixed(3)}, `
                    + `${result.countMap[r][c]} samples`);
            }
        }
        return parts.join('\n');
    };

    const buttons: Array<{ id: RfKorrView; label: string }> = [
        { id: 'tuned', label: t.tuned }, { id: 'stock', label: t.stock }, { id: 'diff', label: t.diff },
    ];

    return (
        <div className="h-full w-full flex flex-col">
            <div className="flex items-center gap-3 px-3 py-2 bg-slate-900/50 border-b border-slate-800 flex-wrap">
                <div className="flex gap-1">
                    {buttons.map(b => (
                        <button
                            key={b.id}
                            onClick={() => onViewChange(b.id)}
                            className={`px-2 py-1 text-[10px] font-bold tracking-wider rounded ${view === b.id
                                ? 'bg-blue-600 text-white'
                                : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                        >
                            {b.label}
                        </button>
                    ))}
                </div>
                <span className="text-[10px] text-slate-500">{t.axes}</span>
                <span className="text-[10px] text-slate-300 ml-auto">
                    {t.updated(report.gridCellsUpdated)} · {t.largest(report.largestChange)}
                </span>
                {/* Not on a refusal: nothing there is provisional, it was declined, and the footer
                    says why. */}
                {!result.acceptable && !report.refused && (
                    <span className="text-[10px] font-bold text-amber-400">{t.provisional}</span>
                )}
                {/* The calibration this table was derived FROM, at the right end of the row that
                    switches between views of it — a dialog, not a section, so the grid keeps its
                    full height and the numbers sit over the table rather than under it.

                    Reading KF_RF_KORR_DRREL out of the binary is how you check that the tuned table
                    is a change to the right numbers, which is why it is on this tab at all and not
                    behind an icon in the footer's row of chart controls. */}
                <button
                    type="button"
                    onClick={() => setEcuOpen(true)}
                    title={t.ecu}
                    aria-label={t.ecu}
                    className="ml-1 p-2 -m-1 text-slate-500 hover:text-blue-400 transition-colors shrink-0"
                >
                    <ListTree className="w-4 h-4" />
                </button>
            </div>

            {ecuOpen && (
                <DialogFrame
                    icon={<ListTree className="w-3 h-3" />}
                    title={t.ecu}
                    closeLabel={t.close}
                    onClose={() => setEcuOpen(false)}
                >
                    {/* Scrolls inside the frame, which states its own height — see DialogFrame. */}
                    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
                        <EcuItemList buffer={buffer} />
                    </div>
                </DialogFrame>
            )}

            <div className="flex-1 min-h-0">
                <MapEditor
                    mapData={map}
                    diffData={view === 'diff' ? changePercent : undefined}
                    hitData={result.countMap}
                    weightData={result.weightMap}
                    zoom={zoom}
                    rowLabel={RF_KORR_ROW_LABEL}
                    colLabel={RF_KORR_COL_LABEL}
                    valueLabel={RF_KORR_VALUE_LABEL}
                    rowFormat={v => v.toFixed(0)}
                    valueFormat={v => v.toFixed(3)}
                    cellNote={note}
                    // Every cell the tune declined to write, dimmed but legible. The stock view
                    // dims nothing: all of it is real, it is simply not the result.
                    mutedCells={view === 'stock' ? undefined : result.updated.map(row => row.map(u => !u))}
                />
            </div>

            <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-500 space-y-1">
                <div className="flex gap-3 flex-wrap font-mono">
                    <span>{t.used(report.samplesUsed)}</span>
                    {report.samplesHysteresis > 0 && <span>{t.hysteresis(report.samplesHysteresis)}</span>}
                    {report.samplesGateShut > 0 && <span>{t.gateShut(report.samplesGateShut)}</span>}
                    {report.samplesNotSettled > 0 && <span>{t.notSettled(report.samplesNotSettled)}</span>}
                </div>
                {/* The one thing a reader needs told rather than counted. Every other line here is
                    an "of which"; this is the case where the drive did not contain the experiment
                    at all, and a grid of untouched cells does not say so on its own. A refusal
                    comes first: it is the reason nothing was measured, and it names the run to do. */}
                {report.refused ? (
                    <p className="text-amber-400/90">{t[report.refused]}</p>
                ) : report.samplesUsed === 0 && (
                    <p className="text-amber-400/90">{t.noGateOpen}</p>
                )}
                <p>{t.thin}</p>
            </div>
        </div>
    );
};
