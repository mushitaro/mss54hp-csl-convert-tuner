'use client';

import React from 'react';
import { X, Cable, Gauge, Database, Download, Upload, FileSpreadsheet } from 'lucide-react';
import { DmeIdentity } from '@/lib/dme-link/types';

/**
 * Everything the header used to carry, for windows too narrow to carry it.
 *
 * Below 900px the header had four things competing for about 312px: the wordmark, the identity
 * strip (VIN/AIF/SW/FLASH), the tab row underneath it, and the session bar under that. The strip
 * resolved to zero and the session bar overflowed its own 26px — its BASE badge wrapped to two
 * lines and painted over the tab row above and the grid below.
 *
 * None of that is a sizing problem. There are four groups of things and one row to put them in, so
 * they go behind one control and the header keeps only what has to be glanceable while driving:
 * link state, which car, and which half of the app you are looking at.
 *
 * Deliberately NOT in here: anything that writes. WRITE, the arming toggles and START/STOP stay on
 * the dashboard where they are one tap apart and visible together — a menu that has to be opened
 * is the wrong place for a control whose state changes what goes into the ECU.
 */
interface Props {
    onClose: () => void;
    tabs: { id: string; label: string; enabled: boolean }[];
    activeTab: string;
    onSelectTab: (id: string) => void;
    identity: DmeIdentity | null;
    linkState: string;
    flashText: string;
    flashColor: string;
    flashEnabled: boolean;
    onOpenFlash: () => void;
    session: { label: string; archived: boolean } | null;
    /** Rendered by the caller so the badge logic stays in one place. */
    baseOrigin?: React.ReactNode;
    logName?: string;
    logPoints?: number;
    actions: {
        label: string;
        onClick: () => void;
        kind: 'bin' | 'save' | 'base' | 'log';
        hint: string;
    }[];
}

const ICONS = { bin: Download, save: Database, base: Upload, log: FileSpreadsheet } as const;

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="px-4 py-3 border-b border-slate-900">
        <h4 className="text-[9px] font-bold uppercase tracking-widest text-slate-600 mb-2">{title}</h4>
        {children}
    </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-baseline gap-3 py-1">
        <span className="w-16 shrink-0 text-[9px] uppercase tracking-widest text-slate-600">{label}</span>
        <span className="min-w-0 flex-1 font-mono text-[11px] text-slate-300 break-all">{children}</span>
    </div>
);

export const MobileMenu: React.FC<Props> = ({
    onClose, tabs, activeTab, onSelectTab, identity, linkState,
    flashText, flashColor, flashEnabled, onOpenFlash,
    session, baseOrigin, logName, logPoints, actions,
}) => (
    <>
        <div className="fixed inset-0 z-[90] bg-slate-950/70 backdrop-blur-sm min-[900px]:hidden" onClick={onClose} />
        <div className="fixed inset-y-0 left-0 z-[95] w-[min(320px,85vw)] flex flex-col bg-slate-900 border-r border-slate-800 min-[900px]:hidden">
            <div className="h-[48px] shrink-0 flex items-center justify-between px-4 border-b border-slate-800">
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Menu</span>
                <button onClick={onClose} aria-label="Close menu" className="p-3 -m-3 text-slate-500 hover:text-slate-300">
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain">
                <Section title="View">
                    {/* The tab row, unrolled. Horizontally it was 916px of labels in a 360px window, so
                        reaching the last tab meant scrolling a strip whose scroll position gave no clue
                        how many were left. Disabled entries stay listed rather than hidden — which map
                        does not exist yet is the same information as which one does. */}
                    <div className="flex flex-col">
                        {tabs.map(t => (
                            <button
                                key={t.id}
                                type="button"
                                disabled={!t.enabled}
                                onClick={() => { onSelectTab(t.id); onClose(); }}
                                className={`text-left py-3 text-[11px] font-bold tracking-widest transition-colors ${activeTab === t.id ? 'text-blue-400'
                                    : t.enabled ? 'text-slate-400' : 'text-slate-700 cursor-default'}`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                </Section>

                <Section title="Vehicle">
                    <Field label="VIN">{identity?.vin ?? <span className="text-slate-600">{linkState === 'disconnected' ? 'not connected' : 'reading'}</span>}</Field>
                    <Field label="AIF">{identity?.aif ?? <span className="text-slate-600">—</span>}</Field>
                    <Field label="SW">{identity?.softwareVersion ?? <span className="text-slate-600">—</span>}</Field>
                    {/* Still a control, and still one step deeper than the number it changes. */}
                    <button
                        type="button"
                        disabled={!flashEnabled}
                        onClick={() => { onOpenFlash(); onClose(); }}
                        className="mt-1 w-full flex items-center gap-3 py-3 text-left enabled:cursor-pointer disabled:cursor-default"
                    >
                        <Gauge className="w-3.5 h-3.5 shrink-0 text-slate-600" />
                        <span className="text-[9px] uppercase tracking-widest text-slate-600">Flash</span>
                        <span className={`font-mono text-[11px] ${flashColor}`}>{flashText}</span>
                    </button>
                </Section>

                {session && (
                    <Section title="Session">
                        <div className="flex items-center gap-2 mb-2 min-w-0">
                            <Cable className="w-3 h-3 shrink-0 text-slate-600" />
                            <span className="min-w-0 truncate text-[11px] font-bold tracking-widest uppercase text-slate-300">{session.label}</span>
                            {session.archived && <span className="shrink-0 text-[8px] uppercase tracking-widest text-slate-500">read-only</span>}
                        </div>
                        {baseOrigin && <div className="mb-1 flex items-center gap-2"><span className="text-[9px] uppercase tracking-widest text-slate-600">Base</span>{baseOrigin}</div>}
                        {logName && (
                            <div className="flex items-center gap-2 min-w-0">
                                <span className="text-[9px] uppercase tracking-widest text-slate-600 shrink-0">Log</span>
                                <span className="min-w-0 truncate font-mono text-[10px] text-slate-400">{logName}</span>
                                {logPoints !== undefined && <span className="shrink-0 font-mono text-[10px] text-slate-600">{logPoints}pts</span>}
                            </div>
                        )}
                    </Section>
                )}

                {actions.length > 0 && (
                    <Section title="Download">
                        {actions.map(a => {
                            const Icon = ICONS[a.kind];
                            return (
                                <button
                                    key={a.label}
                                    type="button"
                                    onClick={() => { a.onClick(); onClose(); }}
                                    title={a.hint}
                                    className="w-full flex items-center gap-3 py-3 text-left cursor-pointer group"
                                >
                                    <Icon className="w-3.5 h-3.5 shrink-0 text-slate-600 group-hover:text-blue-400 transition-colors" />
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 group-hover:text-blue-400 transition-colors">{a.label}</span>
                                </button>
                            );
                        })}
                    </Section>
                )}
            </div>
        </div>
    </>
);
