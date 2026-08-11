import React, { useState, useEffect } from 'react';
import { Settings, X, RefreshCw, Filter } from 'lucide-react';
import { LogFilterConfig, RfKorrMode, resolveRfKorrMode } from '@/lib/types';
import { useDialogLang } from '@/hooks/useDialogLang';

/** The three answers, in the order they escalate: safe default, opt-out, opt-in-with-a-write. */
const RF_KORR_CHOICES: Array<{ id: RfKorrMode; label: string }> = [
    { id: 'nominal', label: 'NOMINAL' },
    { id: 'as-logged', label: 'AS-LOGGED' },
    { id: 'tuned', label: 'TUNED' },
];

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
        korrOn: 'NOMINAL: テーブルは「公称排気温での充填」を持ちます。排気が冷えたログで作ったマップが、温まった後も正しいままになります（推奨）。',
        korrOff: 'AS-LOGGED: テーブルは「ログを取った時の rf_korr での充填」を持ちます。BMWの密度モデルがこのエンジンに合っている場合のみ正しく、合っていないと排気が温まった時にリーン側に外れます。',
        korrTuned: 'TUNED: ログから逆算した KF_RF_KORR_DRREL で割ってから VE を更新し、その表を BIN にも書き込みます。VE テーブルは「純正の密度モデル」ではなく「実測した密度効果」を前提にした値になります。片方だけでは成立しないため、書き込みは同時に行われます。',
        korrTunedWhy: '逆算した表を書かずに VE だけ更新すると、DME は元の表を掛け続けるので差分がそのまま残ります（純正ピークで最大 −27 %、リーン側）。',
        korrLocked: 'TUNED を選ぶには、BIN のテーブルが読めていること・ログに排気温(EGT)があること・逆算が成立していること・ログが PATCH ON で取られていることが必要です。',
    },
    en: {
        settings: 'Filter Settings',
        locked: 'Locked — these are the settings this saved tune was built with. Start a new session to tune with different filters.',
        idleHint: 'Exclude if RPM < Limit & RO≤1.0',
        tpsHint: 'Absolute Change in Opening %',
        immediate: 'Adjustments apply immediately',
        katsHint: 'Above this EGT the DME adds cat-protection fuel and switches lambda control off, freezing the trim. Those samples and the 20 s it takes the enrichment to unwind are dropped so a frozen trim never reaches the VE map. Does nothing on a log without EGT.',
        korrOn: 'NOMINAL: the table holds filling at NOMINAL exhaust temperature, so a map tuned on a cold-exhaust drive stays right once things heat up (recommended).',
        korrOff: 'AS-LOGGED: the table holds filling at the rf_korr the log was taken under. Only correct if BMW\'s density model matches this engine; if it does not, the map goes lean under load once the exhaust warms up.',
        korrTuned: 'TUNED: divide by the KF_RF_KORR_DRREL back-calculated from this log before updating the VE map, and write that table into the binary as well. The VE table then rests on the density effect actually measured rather than on BMW\'s model. The write is not separable — neither half is correct alone.',
        korrTunedWhy: 'Updating the VE map without writing the derived table leaves the DME applying the old one, so the difference survives intact — up to −27 % at the stock peak, on the lean side.',
        korrLocked: 'TUNED needs the binary\'s tables to decode, an EGT channel in the log, a back-calculation that met its evidence thresholds, and a log recorded with the PATCH on.',
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
    /** Whether TUNED may be chosen at all. False disables it and shows why. Decided by the page,
     *  which is the only place that can see the binary, the log and the back-calculation at once. */
    canTuneRfKorr?: boolean;
}

export const FilterConfigPanel: React.FC<Props> = ({ config, onConfigChange, readOnly = false, openUp, canTuneRfKorr = false }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [localConfig, setLocalConfig] = useState<LogFilterConfig>(config);
    const t = TEXT[useDialogLang()];

    // Sync local config if prop changes (reset)
    useEffect(() => {
        setLocalConfig(config);
    }, [config]);

    const rfKorrMode = resolveRfKorrMode(localConfig);

    /** Writes the mode AND the legacy boolean it supersedes, so a session saved here still reads
     *  sanely in a build that only knows `applyRfKorr`. TUNED has no boolean equivalent; it maps
     *  to the rich-safe one, which is the correct fallback for a build that cannot divide. */
    const setRfKorrMode = (mode: RfKorrMode) => {
        if (readOnly) return;
        const newCfg: LogFilterConfig = {
            ...localConfig, rfKorrMode: mode, applyRfKorr: mode !== 'as-logged',
        };
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
                                reproducible. Defaults to NOMINAL: the three settings fail in
                                different directions and only AS-LOGGED can leave the map lean
                                under load.

                                ONE control, not two. TUNED also writes the back-calculated table
                                into the binary, and the two halves are only correct together —
                                a VE map built for the new table while the DME still applies the
                                old one is off by their ratio, which reaches -27 % on the lean
                                side. Two checkboxes could express that; a three-way cannot. */}
                            <div className="space-y-1">
                                <div className="flex justify-between items-center text-[10px] text-slate-500 uppercase tracking-wider">
                                    <span>RF KORR</span>
                                    <span className={rfKorrMode === 'as-logged' ? 'text-red-400'
                                        : rfKorrMode === 'tuned' ? 'text-amber-400' : 'text-slate-300'}>
                                        {rfKorrMode === 'as-logged' ? 'AS-LOGGED'
                                            : rfKorrMode === 'tuned' ? 'TUNED + WRITE' : 'NOMINAL'}
                                    </span>
                                </div>
                                <div className="flex gap-1">
                                    {RF_KORR_CHOICES.map(choice => {
                                        const locked = choice.id === 'tuned' && !canTuneRfKorr;
                                        return (
                                            <button
                                                key={choice.id}
                                                type="button"
                                                disabled={readOnly || locked}
                                                onClick={() => setRfKorrMode(choice.id)}
                                                // min-h-10, not padding alone. The checkboxes in this
                                                // panel reach a 38px target with `py-3 -my-3` — a big
                                                // hit area behind a small mark — but a segmented
                                                // control has no separate mark to keep small, so it
                                                // just gets the height. Measured at 26px before this.
                                                className={`flex-1 min-h-10 px-1 text-[9px] font-bold tracking-wider rounded ${rfKorrMode === choice.id
                                                    ? 'bg-blue-600 text-white'
                                                    : locked
                                                        ? 'bg-slate-900 text-slate-700 cursor-not-allowed'
                                                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                                            >
                                                {choice.label}
                                            </button>
                                        );
                                    })}
                                </div>
                                <p className="text-[9px] text-slate-600">
                                    {rfKorrMode === 'as-logged' ? t.korrOff
                                        : rfKorrMode === 'tuned' ? t.korrTuned : t.korrOn}
                                </p>
                                {rfKorrMode === 'tuned' && (
                                    <p className="text-[9px] text-amber-500/80">{t.korrTunedWhy}</p>
                                )}
                                {!canTuneRfKorr && (
                                    <p className="text-[9px] text-slate-700">{t.korrLocked}</p>
                                )}
                            </div>

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
