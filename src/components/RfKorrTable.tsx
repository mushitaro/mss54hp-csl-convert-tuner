'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { MapEditor } from './MapEditor';
import { EcuItemList } from './EcuItemList';
import { RfKorrModeControl } from './RfKorrModeControl';
import { RfKorrTuneResult, RejectReason } from '@/lib/ve-calculator/rfKorrTuner';
import {
    RF_KORR_COL_LABEL, RF_KORR_ROW_LABEL, RF_KORR_VALUE_LABEL, RfKorrView, rfKorrViewData,
} from '@/lib/ve-calculator/rfKorrView';
import { RfKorrMode } from '@/lib/types';
import { useDialogLang } from '@/hooks/useDialogLang';

/** Why a cell was left alone, in the reader's language. Kept short — this lands in a tooltip. */
const REASON_TEXT: Record<RejectReason, { en: string; ja: string }> = {
    'no-evidence': {
        en: 'no samples reached this rpm at this exhaust delta',
        ja: 'この回転数・Δ にサンプルが来ていない',
    },
    'thin-count': {
        en: 'too few samples to divide by',
        ja: 'サンプル数が足りない（除算の分母には不足）',
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
};

const TEXT = {
    en: {
        tuned: 'TUNED', stock: 'STOCK', diff: 'CHANGE %',
        axes: 'Rows = model EGT minus measured, °C · Columns = rpm',
        updated: (n: number) => `${n} of 72 cells updated`,
        largest: (v: number) => `largest change ${v >= 0 ? '+' : ''}${v.toFixed(3)}`,
        anchors: (n: number) => `${n} anchor samples`,
        ratios: (n: number) => `${n} ratio samples`,
        veCells: (n: number) => `${n} VE cells anchored`,
        noAnchor: (n: number) => `${n} samples had no anchor in their own VE cell`,
        hysteresis: (n: number) => `${n} dropped in the hysteresis band`,
        thin: 'Nothing here is written unless a cell had samples from at least two VE cells that '
            + 'agreed to within 15 %. Everything else keeps its stock value byte for byte.',
        provisional: 'PROVISIONAL — too few cells moved to be worth writing',
        ecu: 'ECU parameters this table is derived from',
    },
    ja: {
        tuned: 'TUNED', stock: 'STOCK', diff: 'CHANGE %',
        axes: '行 = モデル排気温 − 実測, °C ／ 列 = 回転数',
        updated: (n: number) => `72 セル中 ${n} セルを更新`,
        largest: (v: number) => `最大変化 ${v >= 0 ? '+' : ''}${v.toFixed(3)}`,
        anchors: (n: number) => `アンカー ${n} サンプル`,
        ratios: (n: number) => `比 ${n} サンプル`,
        veCells: (n: number) => `アンカーの立った VE セル ${n} 個`,
        noAnchor: (n: number) => `自セルにアンカーが無く使えなかったサンプル ${n} 個`,
        hysteresis: (n: number) => `ヒステリシス帯で除外 ${n} 個`,
        thin: '2 つ以上の VE セルから来たサンプルが 15 % 以内で一致したセルだけを書き換えます。'
            + 'それ以外は純正値のままバイト単位で不変です。',
        provisional: 'PROVISIONAL — 書き込むには更新セルが少なすぎます',
        ecu: 'この表の元になっている ECU パラメータ',
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
 */
export const RfKorrTable: React.FC<{
    result: RfKorrTuneResult;
    zoom?: number;
    view: RfKorrView;
    onViewChange: (view: RfKorrView) => void;
    /** How the VE map should treat exhaust temperature, and whether MEASURED is available. The
     *  control lives here as well as in the filter popover — this is where a reader goes looking
     *  for anything RF KORR, and it was reported as being nowhere at all. */
    mode: RfKorrMode;
    onModeChange: (mode: RfKorrMode) => void;
    canTune: boolean;
    readOnly?: boolean;
    /** The loaded BIN, for the calibration this table was derived FROM. */
    buffer: ArrayBuffer | null;
}> = ({ result, zoom = 1, view, onViewChange, mode, onModeChange, canTune, readOnly, buffer }) => {
    const lang = useDialogLang();
    const t = TEXT[lang];
    const { report } = result;
    /** Collapsed by default. The grid is the subject of this tab and the calibration is its
     *  provenance — worth being one tap away, not worth taking the grid's height every visit. */
    const [ecuOpen, setEcuOpen] = useState(false);

    const { map, changePercent } = rfKorrViewData(result, view);

    const note = (r: number, c: number) => {
        const parts: string[] = [];
        if (result.updated[r][c]) {
            parts.push(`stock ${result.stock[r][c].toFixed(3)} -> tuned ${result.tuned[r][c].toFixed(3)}`);
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
                {!result.acceptable && (
                    <span className="text-[10px] font-bold text-amber-400">{t.provisional}</span>
                )}
            </div>

            {/* The mode, above the table it decides the fate of.
                It is also still in the filter popover, where the session's other reproducible
                settings live — but that popover is called RAW FILTER and this sat below three
                sliders about temperature and rpm, behind an unlabelled funnel. Reported, correctly,
                as not existing. One component, one piece of state, two places to reach it. */}
            <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
                <RfKorrModeControl
                    mode={mode}
                    onChange={onModeChange}
                    canTune={canTune}
                    readOnly={readOnly}
                />
            </div>

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
                    <span>{t.anchors(report.anchorSamples)}</span>
                    <span>{t.ratios(report.ratioSamples)}</span>
                    <span>{t.veCells(report.veCellsWithAnchor)}</span>
                    {report.samplesNoAnchor > 0 && <span>{t.noAnchor(report.samplesNoAnchor)}</span>}
                    {report.samplesHysteresis > 0 && <span>{t.hysteresis(report.samplesHysteresis)}</span>}
                </div>
                <p>{t.thin}</p>
            </div>

            {/* The calibration this table was derived FROM.
                Here rather than behind an icon in the footer, because reading KF_RF_KORR_DRREL out
                of the binary is how you check that the tuned table above it is a change to the
                right numbers — and those two were previously two taps and a guess apart.

                Collapsed by default and capped at 45 % when open, so opening it can never take the
                grid's height away entirely. `shrink-0` on the closed row keeps the toggle reachable
                on a short landscape phone, where the flex pass would otherwise squeeze it. */}
            <div className="shrink-0 border-t border-slate-800">
                <button
                    type="button"
                    onClick={() => setEcuOpen(o => !o)}
                    className="w-full flex items-center gap-2 px-3 min-h-10 text-[9px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors"
                >
                    {ecuOpen ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                    <span className="text-left">{t.ecu}</span>
                </button>
                {ecuOpen && (
                    <div className="px-3 pb-3 max-h-[45vh] overflow-y-auto overscroll-contain bg-slate-950">
                        <EcuItemList buffer={buffer} />
                    </div>
                )}
            </div>
        </div>
    );
};
