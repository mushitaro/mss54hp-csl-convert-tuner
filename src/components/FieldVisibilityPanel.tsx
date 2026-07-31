import React, { useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { FieldKey, LOG_FIELD_REGISTRY, TOGGLEABLE_FIELDS } from '@/lib/field-registry/registry';

interface Props {
    visibleFields: Record<FieldKey, boolean>;
    onToggle: (key: FieldKey) => void;
    onShowCoreOnly: () => void;
    onShowAll: () => void;
}

export const FieldVisibilityPanel: React.FC<Props> = ({ visibleFields, onToggle, onShowCoreOnly, onShowAll }) => {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`p-2 rounded text-slate-400 hover:text-blue-400 transition-colors ${isOpen ? 'text-blue-400 bg-slate-800' : 'hover:bg-slate-800'}`}
                title="Log Fields"
            >
                <SlidersHorizontal className="w-4 h-4" />
            </button>

            {isOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />

                    <div className="absolute right-0 top-10 w-[220px] bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 p-4 animate-in fade-in zoom-in-95 duration-200">
                        <div className="flex justify-between items-center mb-3 border-b border-slate-800 pb-2">
                            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                                <SlidersHorizontal className="w-3 h-3" />
                                LOG FIELDS
                            </h3>
                            <button onClick={() => setIsOpen(false)} className="text-slate-500 hover:text-slate-300">
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="space-y-2">
                            {TOGGLEABLE_FIELDS.map(key => {
                                const meta = LOG_FIELD_REGISTRY[key];
                                return (
                                    <label key={key} className="py-2 -my-2 flex items-center gap-2 cursor-pointer text-[10px] text-slate-400 uppercase tracking-wider">
                                        <input
                                            type="checkbox"
                                            checked={visibleFields[key]}
                                            onChange={() => onToggle(key)}
                                            className="w-3 h-3 accent-blue-500 rounded bg-slate-700 border-none"
                                        />
                                        <span style={{ color: visibleFields[key] ? meta.color : undefined }}>{meta.label}</span>
                                    </label>
                                );
                            })}
                        </div>

                        <div className="mt-3 pt-3 border-t border-slate-800 flex justify-between text-[10px]">
                            <button onClick={onShowCoreOnly} className="text-slate-500 hover:text-blue-400 uppercase tracking-wider">Core Only</button>
                            <button onClick={onShowAll} className="text-slate-500 hover:text-blue-400 uppercase tracking-wider">Show All</button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};
