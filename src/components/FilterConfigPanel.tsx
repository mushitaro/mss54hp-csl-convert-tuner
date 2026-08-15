import React, { useState, useEffect } from 'react';
import { X, Filter } from 'lucide-react';
import { LogFilterConfig, RfKorrSource, resolveRfKorr } from '@/lib/types';
import { RfKorrSourceControl } from './RfKorrSourceControl';
import { COVERAGE_THIN_DEFAULT, COVERAGE_OK_DEFAULT } from './MapEditor';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * Only the prose is here. The control names — RAW FILTER, Min Temp, Idle RPM Threshold, Transient
 * Filter, Max RO Delta — stay as they are: they are the instrument's vocabulary, the same words the
 * stored TuneSettings and the log columns use, and translating them would break that chain rather
 * than help. What gets translated is the text that explains something.
 */
const TEXT = {
    ja: {
        settings: 'フィルター設定',
        locked: '固定 — このセッションは ECU に書き込み済みで、その ECU に入っているバイト列はこの設定から作られました。ここを動かすと記録が実物と食い違います。別のフィルターで調整するには「Use as base」で新しいセッションを開始してください。（保存しただけなら固定されません。）',
        idleHint: 'RPMが下限未満 かつ RO≤1.0 の点を除外',
        tpsHint: 'スロットル開度の変化量(絶対値)',
        immediate: '変更は即時反映されます',
        katsHint: '排気温が上限を超えると触媒保護増量が入り、DMEはλ制御を停止します。凍結したトリム値をVE計算に取り込まないよう、その区間と復帰後20秒を除外します。EGTを含まないログでは何も起きません。',
        tankVentLabel: 'Tank Vent',
        tankVentHint: 'タンク換気（パージ）中は、DMEが噴いていない燃料がエンジンに入るため、λトリムがその分だけ動きます。λ制御は正常に閉じたままなので、値は「意味がない」のではなく「別の理由で正しい」— そのままVEに取り込むと、次回は存在しない蒸発ガスの分だけマップが動きます。純正は2500rpm以上・中負荷で94〜99.6%作動するので、除外すると大半のサンプルが消えることがあります。本来は K_TE_TVTE_GA=0 で走行中だけ止めるのが正解で、これはそれをしなかったログの救済です。TETVを含まないログでは何も起きません。',
        covTitle: 'COVERAGE — 何セルを書くか',
        covIntro: 'ここから下は「どのサンプルを捨てるか」ではなく「どのセルを書き換えてよいか」を決めます。証拠が足りないセルは純正値のままバイト不変で残ります。',
        covVe: 'VE セル採用',
        covVeHint: '1 セルを動かすのに必要なサンプル数と重み。両方必要です — 4 隅に散った 10 点は重みが乗らず、中央に落ちた数点は重みだけ大きくなるため。2026-08 まで VE マップにはサンプル数の門番が無く、`weightSum > 0.1`（＝セル中央に落ちた 1 点で 1.0）だけでした。',
        covRf: 'RF KORR セル採用',
        covRfHint: '補正テーブル側の同じ門番。VE マップ 480 セルに対しこちらは 72 セルなので、1 セルが結果に効く度合いが桁で違います。だから別の数字。',
        covBands: '表示バンド（薄い / 十分）',
        covBandsHint: 'ヒートマップの色分けだけを決めます。計算のゲートより高く置いてあります — ゲートは「動かしてよいか」、バンドは「もう走らなくてよいか」で、後者のほうが高い基準だからです。既定 50 / 200 は実測から: セッション #902（657 秒・有効 751 点・2.44 Hz）で 480 セル中 155 セルに点が入り、最も濃いセルで 130 点、100 点以上はわずか 4 セルでした。「十分」は 1 回の走行では届かず、数回のキャンペーンで届く水準に置いてあります。',
    },
    en: {
        settings: 'Filter Settings',
        locked: 'Locked — this session has been written to the ECU, and the bytes in it were built from these settings. Changing them here would make the record disagree with the car. Use as base to start a new session and tune with different filters. (Saving alone does not lock anything.)',
        idleHint: 'Exclude if RPM < Limit & RO≤1.0',
        tpsHint: 'Absolute Change in Opening %',
        immediate: 'Adjustments apply immediately',
        katsHint: 'Above this EGT the DME adds cat-protection fuel and switches lambda control off, freezing the trim. Those samples and the 20 s it takes the enrichment to unwind are dropped so a frozen trim never reaches the VE map. Does nothing on a log without EGT.',
        tankVentLabel: 'Tank Vent',
        tankVentHint: 'While the purge valve is open the engine receives fuel the DME did not inject, so the lambda trim moves to cancel it. The loop is still closed, so the trim is not meaningless — it is correct for a reason the VE map cannot reproduce, and folding it in moves cells to chase vapour that will not be there next time. Stock duty is 94-99.6% above 2500 rpm at mid load, so this can discard most of a log. Disabling the valve for the run (K_TE_TVTE_GA = 0) is the real fix; this salvages a log taken without it. Does nothing on a log without TETV.',
        covTitle: 'COVERAGE — which cells get written',
        covIntro: 'Everything above decides which samples to discard. These decide which cells may be rewritten. A cell short of evidence keeps its stock value, byte for byte.',
        covVe: 'VE cell',
        covVeHint: 'Samples and bilinear weight a cell needs before it may move. Both, not either: ten samples spread over four corners carry very little weight, and a large weight can come from a few samples sitting dead centre. Until 2026-08 the VE map had no count threshold at all — only `weightSum > 0.1`, which one sample landing squarely on a cell already clears.',
        covRf: 'RF KORR cell',
        covRfHint: 'The same gate on the correction table. It has 72 cells against the 480 of the VE map, so one of its cells carries far more of the result — which is why it gets its own numbers.',
        covBands: 'Heatmap bands (thin / covered)',
        covBandsHint: 'Display only. Deliberately above the gate: the gate answers "may this cell move", the bands answer "can I stop driving this area", and the second is a higher bar. The 50/200 defaults are measured, not chosen: session #902 (657 s, 751 valid samples at 2.44 Hz) put samples in 155 of 480 cells, peaked at 130 in the busiest, and cleared 100 in only four. "Covered" is therefore a multi-run target rather than something one drive reaches.',
    },
};

interface Props {
    config: LogFilterConfig;
    onConfigChange: (newConfig: LogFilterConfig) => void;
    /** Archived — i.e. FLASHED — sessions show the settings their tune was built with, but must not
     *  re-derive it: those bytes are in an ECU and the record has to keep describing them.
     *
     *  A saved-but-unflashed session is NOT archived and NOT read-only. Saving is how a live run is
     *  persisted at all, so locking on save meant the only way to keep a drive was to give up
     *  adjusting the filters it would be read through. */
    readOnly?: boolean;
    /** Open above the trigger instead of below it. The mobile footer sits at the bottom edge, so a
     *  popover hanging `top-10` off a control down there opens off-screen. */
    openUp?: boolean;
    /** The log carries an exhaust temperature, so the DME-table route can index a Δ. Decided by the
     *  page, which is the only place that can see the processed log. */
    hasTabg?: boolean;
    /** Mean gap between the two rf_korr routes over this log, or undefined when they cannot be
     *  compared. The one check the app has on a DS2 offset nobody has confirmed on a car. */
    routeGap?: number;
    routeSamples?: number;
}

/**
 * Two numbers that belong to one decision, side by side.
 *
 * A slider would be wrong for these. The row filters above are all "somewhere in a range feels
 * right", which is what a slider is for; a sample threshold is a number you mean exactly, you
 * compare against the count in a tooltip, and 10 versus 11 is a real difference you cannot hit by
 * dragging. Number inputs also let the value be typed on a phone without a precise drag.
 */
const NumberPair: React.FC<{
    label: string; hint: string;
    a: { value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void };
    b: { value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void };
}> = ({ label, hint, a, b }) => {
    const box = (f: typeof a) => (
        <label className="flex-1 min-w-0 flex items-center gap-1">
            <input
                type="number"
                value={f.value}
                min={f.min} max={f.max} step={f.step}
                // Clamped here rather than trusted from the input: `min`/`max` are advisory on a
                // number input, and a typed 0 would silently reopen the no-gate behaviour this
                // section exists to close.
                onChange={e => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) f.onChange(Math.min(f.max, Math.max(f.min, n)));
                }}
                className="w-full min-w-0 bg-slate-800 text-[10px] font-mono text-slate-300 rounded px-1.5 py-1 outline-none border border-slate-700 focus:border-blue-500"
            />
            <span className="text-[9px] text-slate-600 shrink-0">{f.unit}</span>
        </label>
    );
    return (
        <div className="space-y-1">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</div>
            <div className="flex items-center gap-2">{box(a)}{box(b)}</div>
            <p className="text-[9px] text-slate-600">{hint}</p>
        </div>
    );
};

export const FilterConfigPanel: React.FC<Props> = ({ config, onConfigChange, readOnly = false, openUp, hasTabg = false, routeGap, routeSamples }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [localConfig, setLocalConfig] = useState<LogFilterConfig>(config);
    const t = TEXT[useDialogLang()];

    // Sync local config if prop changes (reset)
    useEffect(() => {
        setLocalConfig(config);
    }, [config]);

    const rfKorrSource = resolveRfKorr(localConfig).source;

    /** Writes the source AND clears the two fields it supersedes.
     *
     *  Cleared rather than kept in step, which is the opposite of what the old three-way did. Those
     *  fields are now read ONLY when `rfKorrSource` is absent (see resolveRfKorr), so leaving a
     *  stale `rfKorrMode: 'tuned'` behind would be a second, invisible opinion about the table
     *  write — and `storedWriteRfKorr` consults exactly that field when reconstructing an old
     *  session. A config that carries the current field must not also answer the legacy question. */
    const setRfKorrSource = (source: RfKorrSource) => {
        if (readOnly) return;
        const newCfg: LogFilterConfig = { ...localConfig, rfKorrSource: source };
        delete newCfg.rfKorrMode;
        delete newCfg.applyRfKorr;
        setLocalConfig(newCfg);
        onConfigChange(newCfg);
    };

    const handleChange = (key: keyof LogFilterConfig, value: number | boolean) => {
        if (readOnly) return;
        // @ts-ignore
        const newCfg = { ...localConfig, [key]: value };
        setLocalConfig(newCfg);
        onConfigChange(newCfg);
    };

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`p-2 rounded text-slate-400 hover:text-blue-400 transition-colors ${isOpen ? 'text-blue-400 bg-slate-800' : 'hover:bg-slate-800'}`}
                title={t.settings}
            >
                <Filter className="w-4 h-4" />
            </button>

            {isOpen && (
                <>
                    {/* Backdrop to close */}
                    <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />

                    {/* Popover Panel */}
                    <div className={`${openUp ? 'fixed inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),494px)] overflow-y-auto overscroll-contain' : 'absolute right-0 top-10 w-[280px] max-h-[min(70dvh,494px)] overflow-y-auto overscroll-contain'} bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 p-4 animate-in fade-in zoom-in-95 duration-200`}>
                        <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-2">
                            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                                <Filter className="w-3 h-3" />
                                RAW FILTER
                            </h3>
                            <button
                                onClick={() => setIsOpen(false)}
                                className="text-slate-500 hover:text-slate-300"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {readOnly && (
                            <p className="mb-3 text-[9px] font-mono text-amber-500/80 leading-relaxed">
                                {t.locked}
                            </p>
                        )}

                        <div className={`space-y-5 ${readOnly ? 'opacity-60 pointer-events-none select-none' : ''}`}>
                            {/* Alpha-N Correction Moved to Table Editor */}

                            {/* Min Temp */}
                            <div className="space-y-1">
                                <div className="flex justify-between items-center text-[10px] text-slate-500 uppercase tracking-wider">
                                    <label className="py-3 -my-3 flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={localConfig.enableMinTemp}
                                            onChange={(e) => handleChange('enableMinTemp', e.target.checked)}
                                            className="w-3 h-3 accent-blue-500 rounded bg-slate-700 border-none"
                                        />
                                        <span>Min Temp</span>
                                    </label>
                                    <span className={`${localConfig.enableMinTemp ? 'text-slate-300' : 'text-slate-600'}`}>{localConfig.minTemp}°C</span>
                                </div>
                                <input
                                    type="range"
                                    min="0" max="100"
                                    disabled={!localConfig.enableMinTemp}
                                    value={localConfig.minTemp}
                                    onChange={(e) => handleChange('minTemp', Number(e.target.value))}
                                    className={`w-full h-1 rounded-lg appearance-none cursor-pointer ${localConfig.enableMinTemp ? 'bg-slate-700 accent-blue-500' : 'bg-slate-800 accent-slate-600'}`}
                                />
                            </div>

                            {/* Idle RPM */}
                            <div className="space-y-1">
                                <div className="flex justify-between items-center text-[10px] text-slate-500 uppercase tracking-wider">
                                    <label className="py-3 -my-3 flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={localConfig.enableIdle}
                                            onChange={(e) => handleChange('enableIdle', e.target.checked)}
                                            className="w-3 h-3 accent-blue-500 rounded bg-slate-700 border-none"
                                        />
                                        <span>Idle RPM Threshold</span>
                                    </label>
                                    <span className={`${localConfig.enableIdle ? 'text-slate-300' : 'text-slate-600'}`}>{localConfig.idleRpm} RPM</span>
                                </div>
                                <input
                                    type="range"
                                    min="500" max="2000" step="50"
                                    disabled={!localConfig.enableIdle}
                                    value={localConfig.idleRpm}
                                    onChange={(e) => handleChange('idleRpm', Number(e.target.value))}
                                    className={`w-full h-1 rounded-lg appearance-none cursor-pointer ${localConfig.enableIdle ? 'bg-slate-700 accent-blue-500' : 'bg-slate-800 accent-slate-600'}`}
                                />
                                <p className="text-[9px] text-slate-600">{t.idleHint}</p>
                            </div>

                            {/* Cat Protect — open-loop exclusion. Defaults ON (`?? true` in the
                                filter), so a session saved before this field existed behaves the
                                same as a new one rather than silently keeping frozen-trim rows. */}
                            <div className="space-y-1">
                                <div className="flex justify-between items-center text-[10px] text-slate-500 uppercase tracking-wider">
                                    <label className="py-3 -my-3 flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={localConfig.enableOpenLoopExclusion ?? true}
                                            onChange={(e) => handleChange('enableOpenLoopExclusion', e.target.checked)}
                                            className="w-3 h-3 accent-blue-500 rounded bg-slate-700 border-none"
                                        />
                                        <span>Cat Protect EGT</span>
                                    </label>
                                    <span className={`${(localConfig.enableOpenLoopExclusion ?? true) ? 'text-slate-300' : 'text-slate-600'}`}>
                                        {localConfig.katsTabgOn ?? 850} °C
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    // 700 °C is well below anything that arms the enrichment;
                                    // 950 is above the sensor's useful working range here. The
                                    // stock K_TI_KATS_TABG_EIN sits at 850, mid-scale.
                                    min="700" max="950" step="10"
                                    disabled={!(localConfig.enableOpenLoopExclusion ?? true)}
                                    value={localConfig.katsTabgOn ?? 850}
                                    onChange={(e) => handleChange('katsTabgOn', Number(e.target.value))}
                                    className={`w-full h-1 rounded-lg appearance-none cursor-pointer ${(localConfig.enableOpenLoopExclusion ?? true) ? 'bg-slate-700 accent-blue-500' : 'bg-slate-800 accent-slate-600'}`}
                                />
                                <p className="text-[9px] text-slate-600">{t.katsHint}</p>
                            </div>

                            {/* Tank Vent. Defaults OFF, unlike Cat Protect above — see
                                LogFilterConfig. No slider: the threshold exists in the config for a
                                car whose valve reads a small non-zero at rest, but the useful
                                setting is "anything the DME calls open", and a control offering a
                                number here would imply there is a good one to pick. */}
                            <div className="space-y-1">
                                <div className="flex justify-between items-center text-[10px] text-slate-500 uppercase tracking-wider">
                                    <label className="py-3 -my-3 flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={localConfig.enableTankVentExclusion ?? false}
                                            onChange={(e) => handleChange('enableTankVentExclusion', e.target.checked)}
                                            className="w-3 h-3 accent-blue-500 rounded bg-slate-700 border-none"
                                        />
                                        <span>{t.tankVentLabel}</span>
                                    </label>
                                    <span className={`${(localConfig.enableTankVentExclusion ?? false) ? 'text-slate-300' : 'text-slate-600'}`}>
                                        &gt; {localConfig.tankVentMaxMs ?? 0} ms
                                    </span>
                                </div>
                                <p className="text-[9px] text-slate-600">{t.tankVentHint}</p>
                            </div>

                            {/* COVERAGE — a section, not another row, because these answer a
                                different question from everything above them. The row filters decide
                                which samples survive; these decide which CELLS may be rewritten from
                                the samples that did. Mixing them into one list is how the map ended
                                up with no evidence gate at all while looking like it had one. */}
                            <div className="pt-2 mt-1 border-t border-slate-800/60 space-y-3">
                                <div>
                                    <div className="text-[10px] text-slate-400 uppercase tracking-wider">{t.covTitle}</div>
                                    <p className="text-[9px] text-slate-600 mt-0.5">{t.covIntro}</p>
                                </div>

                                <NumberPair
                                    label={t.covVe} hint={t.covVeHint}
                                    a={{ value: localConfig.minVeCellSamples ?? 10, min: 1, max: 200, step: 1, unit: 'samples',
                                        onChange: v => handleChange('minVeCellSamples', v) }}
                                    b={{ value: localConfig.minVeCellWeight ?? 5.0, min: 0.5, max: 100, step: 0.5, unit: 'weight',
                                        onChange: v => handleChange('minVeCellWeight', v) }}
                                />
                                <NumberPair
                                    label={t.covRf} hint={t.covRfHint}
                                    a={{ value: localConfig.rfKorrMinCellSamples ?? 10, min: 1, max: 200, step: 1, unit: 'samples',
                                        onChange: v => handleChange('rfKorrMinCellSamples', v) }}
                                    b={{ value: localConfig.rfKorrMinCellWeight ?? 5.0, min: 0.5, max: 100, step: 0.5, unit: 'weight',
                                        onChange: v => handleChange('rfKorrMinCellWeight', v) }}
                                />
                                <NumberPair
                                    label={t.covBands} hint={t.covBandsHint}
                                    a={{ value: localConfig.coverageThin ?? COVERAGE_THIN_DEFAULT, min: 1, max: 1000, step: 5, unit: 'thin',
                                        onChange: v => handleChange('coverageThin', v) }}
                                    b={{ value: localConfig.coverageOk ?? COVERAGE_OK_DEFAULT, min: 1, max: 2000, step: 10, unit: 'covered',
                                        onChange: v => handleChange('coverageOk', v) }}
                                />
                            </div>

                            {/* RF KORR — not a filter, but it belongs to "how this log becomes a
                                map" and has to travel with the session for the tune to be
                                reproducible, which is why it is in this panel at all.

                                The control itself is RfKorrModeControl, shared with the RF KORR
                                tab. It is the same setting in two places rather than two settings:
                                a reader looking for anything RF KORR goes to that tab, and this
                                copy is what keeps NOMINAL vs LOGGED reachable on a log that has an
                                RF channel but no exhaust probe — exactly when that tab does not
                                exist.

                                ONE control, not two. MEASURED also writes the back-calculated
                                table into the binary, and the two halves are only correct together:
                                a VE map built for the new table while the DME still applies the old
                                one is off by their ratio, which reaches -27 % on the lean side. Two
                                checkboxes could express that; a three-way cannot. */}
                            <RfKorrSourceControl
                                source={rfKorrSource}
                                onChange={setRfKorrSource}
                                hasTabg={hasTabg}
                                readOnly={readOnly}
                                routeGap={routeGap}
                                routeSamples={routeSamples}
                            />

                            {/* Transient Header */}
                            <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
                                <label className="py-3 -my-3 flex items-center gap-2 cursor-pointer text-[10px] text-slate-500 uppercase tracking-wider font-bold">
                                    <input
                                        type="checkbox"
                                        checked={localConfig.enableTransient}
                                        onChange={(e) => handleChange('enableTransient', e.target.checked)}
                                        className="w-3 h-3 accent-orange-500 rounded bg-slate-700 border-none"
                                    />
                                    <span>Transient Filter</span>
                                </label>
                            </div>

                            {/* Transient Window */}
                            <div className={`space-y-1 ${!localConfig.enableTransient ? 'opacity-50 pointer-events-none' : ''}`}>
                                <div className="flex justify-between text-[10px] text-slate-500 uppercase tracking-wider">
                                    <span>Window Size</span>
                                    <span className="text-slate-300">{localConfig.transientWindow} Frames</span>
                                </div>
                                <input
                                    type="range"
                                    min="1" max="10"
                                    value={localConfig.transientWindow}
                                    onChange={(e) => handleChange('transientWindow', Number(e.target.value))}
                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                                />
                            </div>

                            {/* RPM Stable Threshold */}
                            <div className={`space-y-1 ${!localConfig.enableTransient ? 'opacity-50 pointer-events-none' : ''}`}>
                                <div className="flex justify-between text-[10px] text-slate-500 uppercase tracking-wider">
                                    <span>Max RPM Delta</span>
                                    <span className="text-slate-300">{localConfig.rpmStableThreshold}%</span>
                                </div>
                                <input
                                    type="range"
                                    min="1" max="50"
                                    value={localConfig.rpmStableThreshold}
                                    onChange={(e) => handleChange('rpmStableThreshold', Number(e.target.value))}
                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                                />
                            </div>

                            {/* TPS Stable Threshold (RO) */}
                            <div className={`space-y-1 ${!localConfig.enableTransient ? 'opacity-50 pointer-events-none' : ''}`}>
                                <div className="flex justify-between text-[10px] text-slate-500 uppercase tracking-wider">
                                    <span>Max RO Delta</span>
                                    <span className="text-slate-300">{localConfig.tpsStableThreshold}%</span>
                                </div>
                                <input
                                    type="range"
                                    min="1" max="50"
                                    value={localConfig.tpsStableThreshold}
                                    onChange={(e) => handleChange('tpsStableThreshold', Number(e.target.value))}
                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                                />
                                <p className="text-[9px] text-slate-600">{t.tpsHint}</p>
                            </div>
                        </div>

                        <div className="mt-4 pt-3 border-t border-slate-800 text-center">
                            <span className="text-[10px] text-slate-600">{t.immediate}</span>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};
