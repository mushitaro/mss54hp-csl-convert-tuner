import React, { useState, useEffect } from 'react';
import { Settings, X, RefreshCw, Filter } from 'lucide-react';
import { LogFilterConfig } from '@/lib/types';

interface Props {
    config: LogFilterConfig;
    onConfigChange: (newConfig: LogFilterConfig) => void;
    /** Archived sessions show the settings their tune was built with, but must not re-derive it —
     *  changing a filter here would be tuning, which only a draft session may do. */
    readOnly?: boolean;
}

export const FilterConfigPanel: React.FC<Props> = ({ config, onConfigChange, readOnly = false }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [localConfig, setLocalConfig] = useState<LogFilterConfig>(config);

    // Sync local config if prop changes (reset)
    useEffect(() => {
        setLocalConfig(config);
    }, [config]);

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
                title="Filter Settings"
            >
                <Filter className="w-4 h-4" />
            </button>

            {isOpen && (
                <>
                    {/* Backdrop to close */}
                    <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />

                    {/* Popover Panel */}
                    <div className="absolute right-0 top-10 w-[280px] bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 p-4 animate-in fade-in zoom-in-95 duration-200">
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
                                Locked — these are the settings this saved tune was built with.
                                Start a new session to tune with different filters.
                            </p>
                        )}

                        <div className={`space-y-5 ${readOnly ? 'opacity-60 pointer-events-none select-none' : ''}`}>
                            {/* Alpha-N Correction Moved to Table Editor */}

                            {/* Min Temp */}
                            <div className="space-y-1">
                                <div className="flex justify-between items-center text-[10px] text-slate-500 uppercase tracking-wider">
                                    <label className="flex items-center gap-2 cursor-pointer">
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
                                    <label className="flex items-center gap-2 cursor-pointer">
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
                                <p className="text-[9px] text-slate-600">Exclude if RPM &lt; Limit & RO&le;1.0</p>
                            </div>

                            {/* Transient Header */}
                            <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
                                <label className="flex items-center gap-2 cursor-pointer text-[10px] text-slate-500 uppercase tracking-wider font-bold">
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
                                <p className="text-[9px] text-slate-600">Absolute Change in Opening %</p>
                            </div>
                        </div>

                        <div className="mt-4 pt-3 border-t border-slate-800 text-center">
                            <span className="text-[10px] text-slate-600">Adjustments apply immediately</span>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};
