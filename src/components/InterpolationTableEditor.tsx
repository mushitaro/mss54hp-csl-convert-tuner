import React, { useState, useEffect } from 'react';
import { InterpolationPoint } from '@/lib/types';
import { Settings, Save, RotateCcw, Activity } from 'lucide-react';
import { useDialogLang } from '@/hooks/useDialogLang';
import { APP_CONFIG } from '@/config/constants';

/** Prose only. RO CORRECTION, Enable Correction, RPM, Factor (Alpha), Reset and Save Config are
 *  control names — the instrument's vocabulary — and stay in one form on purpose. */
const TEXT = {
    ja: {
        config: 'Alpha-N テーブル設定',
        locked: '固定 — 保存済みチューンはこのテーブルで作られています。別のテーブルで調整するには新しいセッションを開始してください。',
    },
    en: {
        config: 'Alpha-N Table Config',
        locked: 'Locked — this is the table this saved tune was built with. Start a new session to tune with a different one.',
    },
};

interface Props {
    config: InterpolationPoint[];
    onSave: (newConfig: InterpolationPoint[]) => void;
    // [NEW] Enabled State
    enabled: boolean;
    onToggle: (enabled: boolean) => void;
    /** Archived sessions show the table their tune was built with, but must not re-derive it. */
    readOnly?: boolean;
}

// Custom Alpha Icon component to match Lucide style
const AlphaIcon = ({ className }: { className?: string }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
    >
        {/* Improved Alpha (α) path: continuous stroke fish-like shape */}
        <path d="M20 5C17 8 15 11 14 13C13 17 10 20 7 20C4 20 2 17 2 13C2 9 4 6 7 6C10 6 13 9 14 13C15 15 17 19 20 21" />
    </svg>
);

export const InterpolationTableEditor: React.FC<Props> = ({ config, onSave, enabled, onToggle, readOnly = false }) => {
    const [isOpen, setIsOpen] = useState(false);
    const t = TEXT[useDialogLang()];
    const [points, setPoints] = useState<InterpolationPoint[]>(config);

    useEffect(() => {
        setPoints(config);
    }, [config]);

    const handleChange = (index: number, key: keyof InterpolationPoint, value: number) => {
        const newPoints = [...points];
        newPoints[index] = { ...newPoints[index], [key]: value };
        setPoints(newPoints);
    };

    const handleSave = () => {
        const sorted = [...points].sort((a, b) => a.rpm - b.rpm);
        onSave(sorted);
        setIsOpen(false);
    };

    const handleReset = () => {
        setPoints(APP_CONFIG.MSS54HP.INTERPOLATION_TABLE);
    };

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`p-2 rounded text-slate-400 hover:text-orange-400 transition-colors ${isOpen ? 'text-orange-400 bg-slate-800' : 'hover:bg-slate-800'}`}
                title={t.config}
            >
                <AlphaIcon className="w-4 h-4" />
            </button>

            {isOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
                    <div className="absolute right-0 top-10 w-[320px] bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 p-4 animate-in fade-in zoom-in-95 duration-200">
                        <div className="flex flex-col gap-4 mb-4 border-b border-slate-800 pb-2">
                            <div className="flex justify-between items-center">
                                <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                                    <AlphaIcon className="w-3 h-3" />
                                    RO CORRECTION
                                </h3>
                            </div>

                            {readOnly && (
                                <p className="text-[9px] font-mono text-amber-500/80 leading-relaxed">
                                    {t.locked}
                                </p>
                            )}

                            {/* [NEW] Enable Toggle */}
                            <div className={`flex justify-between items-center text-[10px] text-slate-500 uppercase tracking-wider bg-slate-800/50 p-2 rounded ${readOnly ? 'opacity-60 pointer-events-none select-none' : ''}`}>
                                <label className="py-3 -my-3 flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={enabled}
                                        onChange={(e) => onToggle(e.target.checked)}
                                        className="w-3 h-3 accent-blue-500 rounded bg-slate-700 border-none"
                                    />
                                    <span className="font-bold text-slate-400">Enable Correction</span>
                                </label>
                                <span className={`${enabled ? 'text-blue-400' : 'text-slate-600'}`}>
                                    {enabled ? 'ON' : 'OFF'}
                                </span>
                            </div>
                        </div>

                        <div className="max-h-[300px] overflow-y-auto space-y-2 pr-1">
                            <table className={`w-full text-left text-[10px] ${!enabled || readOnly ? 'opacity-50 pointer-events-none' : ''}`}>
                                <thead className="text-slate-500 uppercase">
                                    <tr>
                                        <th className="pb-2">RPM</th>
                                        <th className="pb-2">Factor (Alpha)</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800">
                                    {points.map((p, i) => (
                                        <tr key={i} className="group hover:bg-slate-800/50">
                                            <td className="py-1">
                                                <input
                                                    type="number"
                                                    value={p.rpm}
                                                    onChange={(e) => handleChange(i, 'rpm', Number(e.target.value))}
                                                    className="bg-transparent w-full text-slate-300 focus:text-white outline-none"
                                                />
                                            </td>
                                            <td className="py-1">
                                                <input
                                                    type="number" step="0.01"
                                                    value={p.factor}
                                                    onChange={(e) => handleChange(i, 'factor', Number(e.target.value))}
                                                    className="bg-transparent w-full text-slate-300 focus:text-blue-400 outline-none font-mono"
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {!readOnly && (
                            <div className="mt-4 pt-3 border-t border-slate-800 flex justify-between items-center">
                                <button
                                    onClick={handleReset}
                                    className="text-[10px] text-red-500 hover:text-red-400 flex items-center gap-1"
                                >
                                    <RotateCcw className="w-3 h-3" /> Reset
                                </button>
                                <button
                                    onClick={handleSave}
                                    className="bg-blue-600 hover:bg-blue-500 text-white text-[10px] px-3 py-1 rounded flex items-center gap-1"
                                >
                                    <Save className="w-3 h-3" /> Save Config
                                </button>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};
