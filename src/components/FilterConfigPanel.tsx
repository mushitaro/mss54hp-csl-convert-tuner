import React, { useState, useEffect } from 'react';
import { X, Filter } from 'lucide-react';
import { LogFilterConfig, RfKorrSource, resolveRfKorr } from '@/lib/types';
import { RfKorrSourceControl } from './RfKorrSourceControl';
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
        locked: '固定 — 保存済みチューンはこの設定で作られています。別のフィルターで調整するには新しいセッションを開始してください。',
        idleHint: 'RPMが下限未満 かつ RO≤1.0 の点を除外',
        tpsHint: 'スロットル開度の変化量(絶対値)',
        immediate: '変更は即時反映されます',
        katsHint: '排気温が上限を超えると触媒保護増量が入り、DMEはλ制御を停止します。凍結したトリム値をVE計算に取り込まないよう、その区間と復帰後20秒を除外します。EGTを含まないログでは何も起きません。',
    },
    en: {
        settings: 'Filter Settings',
        locked: 'Locked — these are the settings this saved tune was built with. Start a new session to tune with different filters.',
        idleHint: 'Exclude if RPM < Limit & RO≤1.0',
        tpsHint: 'Absolute Change in Opening %',
        immediate: 'Adjustments apply immediately',
        katsHint: 'Above this EGT the DME adds cat-protection fuel and switches lambda control off, freezing the trim. Those samples and the 20 s it takes the enrichment to unwind are dropped so a frozen trim never reaches the VE map. Does nothing on a log without EGT.',
    },
};

interface Props {
    config: LogFilterConfig;
    onConfigChange: (newConfig: LogFilterConfig) => void;
    /** Archived sessions show the settings their tune was built with, but must not re-derive it —
     *  changing a filter here would be tuning, which only a draft session may do. */
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
}

export const FilterConfigPanel: React.FC<Props> = ({ config, onConfigChange, readOnly = false, openUp, hasTabg = false, routeGap }) => {
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
