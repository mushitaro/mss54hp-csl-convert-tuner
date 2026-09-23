'use client';

import React, { useMemo } from 'react';
import type { Indexed } from '@/lib/calibration-graph/graph';
import type { GraphNode } from '@/lib/calibration-graph/types';
import type { EdgeOrigin } from '@/lib/calibration-graph/types';
import { displayNodeName, originalName } from '@/lib/calibration-graph/names';
import { isToolMetadata } from '@/lib/calibration-graph/logic-format';
import { readMnemonic } from '@/lib/calibration-graph/mnemonic';
import { pickLocalised, t } from '@/lib/calibration-graph/calib-i18n';
import type { CalParamDef, EditLockReason } from '@/lib/calibration/types';
import { cleanUnits } from '@/lib/calibration/catalog';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * The INFO pane: what the selected thing IS — meta, description, the composed
 * mnemonic reading (its own visually distinct tier: it is inference), and who
 * reads/writes it with the evidence origin on every row. Origin is drawn by
 * glyph + line style, never by hue alone: ◆ solid = measured xref, ◇ dashed =
 * operand scan (inferred, may be wrong), § = factory-doc co-occurrence
 * (undirected). That is the same dashed-means-inferred rule the diagram uses.
 */

const LOCK_TEXT: Record<EditLockReason, { ja: string; en: string }> = {
    'no-address': { ja: 'XDF にアドレスの記載がないため表示・編集できません。', en: 'The XDF records no address for this; it cannot be decoded or edited.' },
    'width-32': { ja: '32bit 項目のため v1 では読み取り専用です。', en: '32-bit item — read-only in this version.' },
    'math-unsupported': { ja: 'スケーリング式を解釈できないため raw 表示のみです。', en: 'The scaling equation could not be compiled; raw display only.' },
    'k-linked': { ja: 'スケーリングが他項目の値 (k) を参照するため読み取り専用です。', en: 'The scaling references another item\'s value (k); read-only.' },
    'checksum-slot': { ja: 'チェックサムスロットに重なるため書き込み不可です。', en: 'Overlaps a checksum slot; not writable.' },
    'app-managed': { ja: 'PATCH 系トグルが毎ビルド両方向に書くバイトのため、ここからは編集できません。該当トグルで操作してください。', en: 'These bytes are written both directions by the PATCH toggles on every build. Use those toggles instead.' },
    'idle-sealed': { ja: 'このテーブルへの書き込みは調査完了まで封印されています。ここからも IDLE タブからも書き込まれません。', en: 'Writes to this table are sealed pending the idle investigation. Nothing arms them — here or on the IDLE tab.' },
};

function OriginBadge({ origins }: { origins: ReadonlySet<EdgeOrigin> }) {
    return (
        <span className="flex items-center gap-1 shrink-0">
            {origins.has('xref') && (
                <span className="text-[8px] font-bold px-1 rounded border border-emerald-600 text-emerald-500" title="measured xref">◆ XREF</span>
            )}
            {origins.has('scan') && (
                <span className="text-[8px] font-bold px-1 rounded border border-dashed border-amber-700 text-amber-400" title="operand scan — inferred">◇ SCAN</span>
            )}
            {origins.has('fr') && (
                <span className="text-[8px] font-bold px-1 rounded border border-indigo-600 text-indigo-400" title="factory documents — same page, no direction">§ FR</span>
            )}
        </span>
    );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <span className="flex items-baseline gap-1">
            <span className="text-[8px] font-bold tracking-widest text-slate-600">{label}</span>
            <span className="text-[10px] font-mono text-slate-300">{children}</span>
        </span>
    );
}

export function ParamInfo({
    graph,
    node,
    def,
    onSelect,
}: {
    graph: Indexed;
    node: GraphNode | null;
    /** The adapted def when the node is a parameter; carries the lock. */
    def: CalParamDef | null;
    onSelect: (id: string) => void;
}) {
    const lang = useDialogLang();

    const relations = useMemo(() => {
        if (!node) return { readers: [], writers: [], frSections: [] as string[] };
        const readers = new Map<string, Set<EdgeOrigin>>();
        const writers = new Map<string, Set<EdgeOrigin>>();
        const frSections = new Set<string>();
        const note = (map: Map<string, Set<EdgeOrigin>>, id: string, o: EdgeOrigin) => {
            const set = map.get(id) ?? new Set<EdgeOrigin>();
            set.add(o);
            map.set(id, set);
        };
        for (const e of graph.in.get(node.id) ?? []) {
            const other = graph.byId.get(e.s);
            if (other?.t === 'func' && e.o !== 'fr') note(e.k === 'write' ? writers : readers, other.id, e.o);
        }
        for (const e of graph.out.get(node.id) ?? []) {
            const other = graph.byId.get(e.d);
            if (other?.t === 'frpage' && other.section) frSections.add(other.section);
        }
        const list = (m: Map<string, Set<EdgeOrigin>>) =>
            [...m.entries()]
                .map(([id, origins]) => ({ node: graph.byId.get(id)!, origins }))
                .filter(r => r.node)
                .sort((a, b) => a.node.name.localeCompare(b.node.name));
        return { readers: list(readers), writers: list(writers), frSections: [...frSections].sort() };
    }, [graph, node]);

    if (!node) {
        return <p className="p-3 text-[11px] text-slate-500">{t(lang, 'selectPrompt')}</p>;
    }

    const original = originalName(node);
    const desc = lang === 'ja' ? (node.desc?.ja ?? node.desc?.en) : node.desc?.en;
    const showDesc = desc && !isToolMetadata(desc);
    const enFallback = lang === 'ja' && !node.desc?.ja && node.desc?.en && !isToolMetadata(node.desc.en);
    const mnemonic = readMnemonic(node.name, graph.raw.glossary, lang);
    const kindKey = node.t === 'param'
        ? (node.kind === 'map' ? 'kindMap' : node.kind === 'curve' ? 'kindCurve' : 'kindConstant')
        : node.t === 'func' ? 'kFunc' : node.t === 'ram' ? 'kRam' : node.t === 'frpage' ? 'kFrpage' : 'kUnknown';

    return (
        <div className="h-full overflow-y-auto p-3 space-y-3">
            {/* Header */}
            <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-mono text-[13px] font-bold text-slate-100">{displayNodeName(node)}</span>
                <span className="text-[9px] text-slate-500">{t(lang, kindKey)}</span>
                {node.conf && (
                    <span className={`text-[8px] font-bold px-1 rounded border ${node.conf === 'documented' ? 'border-slate-700 text-slate-400' : 'border-dashed border-slate-700 text-slate-500'}`}>
                        {t(lang, node.conf === 'documented' ? 'confDocumented' : 'confDerived')}
                    </span>
                )}
                {original && (
                    <span className="text-[9px] font-mono text-slate-600">
                        {t(lang, 'originalSpelling')}: {original}
                    </span>
                )}
            </div>

            {/* Meta line */}
            {(node.addr !== undefined || node.t === 'param') && (
                <div className="flex items-center gap-3 flex-wrap">
                    {node.addr !== undefined && (
                        <Meta label={t(lang, 'address')}>0x{node.addr.toString(16).toUpperCase().padStart(4, '0')}</Meta>
                    )}
                    {node.bank && <Meta label="BANK">{t(lang, node.bank === 'master' ? 'master' : 'slave')}</Meta>}
                    {node.bits !== undefined && (
                        <Meta label={t(lang, 'width')}>
                            {node.bits}bit {node.signed ? t(lang, 'signed') : t(lang, 'unsigned')}
                        </Meta>
                    )}
                    {cleanUnits(node.units) && <Meta label={t(lang, 'units')}>{cleanUnits(node.units)}</Meta>}
                    {node.math && <Meta label={t(lang, 'scaling')}>{node.math}</Meta>}
                    {def?.rows !== undefined && <Meta label="DIMS">{def.rows}×{def.cols}</Meta>}
                </div>
            )}

            {/* Lock notice — the reason a parameter cannot be edited, stated in place. */}
            {def?.lock.locked && (
                <p className="text-[10px] text-amber-400 border border-dashed border-amber-700 rounded px-2 py-1">
                    {LOCK_TEXT[def.lock.reason][lang]}
                </p>
            )}

            {/* Categories */}
            {node.cats && node.cats.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                    {node.cats.map(id => {
                        const cat = graph.raw.categories.find(c => c.id === id);
                        return cat ? (
                            <span key={id} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                                {pickLocalised(lang, cat)}
                            </span>
                        ) : null;
                    })}
                </div>
            )}

            {/* Description */}
            {showDesc && (
                <div>
                    <div className="text-[8px] font-bold tracking-widest text-slate-600 mb-0.5">{t(lang, 'description').toUpperCase()}</div>
                    <p className="text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap">{desc}</p>
                    {enFallback && <p className="text-[9px] text-slate-600 mt-0.5">{t(lang, 'descriptionEnOnly')}</p>}
                </div>
            )}

            {/* Mnemonic reading — its own tier: composed, not measured. */}
            {mnemonic && (
                <div className="border-l-2 border-amber-500 pl-3">
                    <div className="text-[8px] font-bold tracking-widest text-amber-400 mb-0.5">
                        ⌾ {t(lang, 'mnemonicReading').toUpperCase()}
                    </div>
                    {mnemonic.reading ? (
                        <p className="text-[11px] text-slate-300">{mnemonic.reading}</p>
                    ) : (
                        <p className="text-[10px] text-slate-500">{t(lang, 'mnemonicNoReading')}</p>
                    )}
                    <p className="text-[9px] font-mono text-slate-500 mt-0.5">
                        {mnemonic.terms.map(term => `${term.token}=${term.reading}`).join(' · ')}
                        {mnemonic.unknown.length > 0 && (
                            <span className="text-slate-600"> · {t(lang, 'mnemonicUnknown')}: {mnemonic.unknown.join(' ')}</span>
                        )}
                    </p>
                    <p className="text-[9px] text-slate-600 mt-0.5">{t(lang, 'mnemonicNote')}</p>
                </div>
            )}

            {/* Consumers / producers */}
            {relations.readers.length > 0 && (
                <div>
                    <div className="text-[8px] font-bold tracking-widest text-slate-600 mb-0.5">{t(lang, 'consumers').toUpperCase()}</div>
                    {relations.readers.map(r => (
                        <button
                            key={r.node.id}
                            onClick={() => onSelect(r.node.id)}
                            className="w-full flex items-center gap-2 h-[20px] text-left hover:bg-slate-900 transition px-1"
                        >
                            <span className="flex-1 font-mono text-[10px] text-slate-300 truncate">{r.node.name}</span>
                            <OriginBadge origins={r.origins} />
                        </button>
                    ))}
                </div>
            )}
            {relations.writers.length > 0 && (
                <div>
                    <div className="text-[8px] font-bold tracking-widest text-slate-600 mb-0.5">{t(lang, 'producers').toUpperCase()}</div>
                    {relations.writers.map(r => (
                        <button
                            key={r.node.id}
                            onClick={() => onSelect(r.node.id)}
                            className="w-full flex items-center gap-2 h-[20px] text-left hover:bg-slate-900 transition px-1"
                        >
                            <span className="flex-1 font-mono text-[10px] text-slate-300 truncate">{r.node.name}</span>
                            <OriginBadge origins={r.origins} />
                        </button>
                    ))}
                </div>
            )}
            {node.t === 'param' && relations.writers.length === 0 && (
                <p className="text-[9px] text-slate-600">{t(lang, 'noUpstreamForParam')}</p>
            )}

            {/* Factory documentation */}
            <div>
                <div className="text-[8px] font-bold tracking-widest text-slate-600 mb-0.5">{t(lang, 'documents')}</div>
                {relations.frSections.length ? (
                    <div className="flex items-center gap-2 flex-wrap">
                        {relations.frSections.map(section => {
                            const doc = graph.raw.frDocs.find(d => d.section === section);
                            const href = doc?.pathDe
                                ? `${graph.raw.meta.docBase}/${encodeURI(doc.pathDe)}`
                                : undefined;
                            const label = doc ? `${section} ${pickLocalised(lang, doc)}` : section;
                            return href ? (
                                <a
                                    key={section}
                                    href={href}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[9px] text-indigo-400 hover:text-indigo-300 transition underline underline-offset-2"
                                >
                                    § {label}
                                </a>
                            ) : (
                                <span key={section} className="text-[9px] text-slate-500">§ {label}</span>
                            );
                        })}
                    </div>
                ) : (
                    <p className="text-[9px] text-slate-600">{t(lang, 'noDocs')}</p>
                )}
            </div>
        </div>
    );
}
