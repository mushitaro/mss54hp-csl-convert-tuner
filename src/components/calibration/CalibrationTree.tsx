'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { Indexed } from '@/lib/calibration-graph/graph';
import { searchNodes } from '@/lib/calibration-graph/graph';
import type { GraphNode } from '@/lib/calibration-graph/types';
import { displayName } from '@/lib/calibration-graph/names';
import { pickLocalised, t } from '@/lib/calibration-graph/calib-i18n';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * The tree, on two tabs.
 *
 * PARAMETERS is the factory's own category partition, and inside each category
 * the three storage kinds — a constant, a curve, a map are different things to
 * open, and a category like SMG holds all three. So the nesting is
 * category → kind → symbol, sorted at every level.
 *
 * FUNCTIONS is a flat list. A function has no second axis to group by, and the
 * single "ƒ" node that used to wrap the list was a level that answered nothing.
 *
 * Collapses to a 28 px rail rather than vanishing — the pane edge never moves.
 */

type TreeTab = 'params' | 'funcs';

type ParamKind = 'constant' | 'curve' | 'map';

/** Storage kinds in the order they are shown: simplest first, and the order a
 *  reader scanning a category expects them in. Labels are the app's own kind
 *  vocabulary (see the diagram legend and the info pane), one English form. */
const KINDS: { id: ParamKind; label: string; mark: string }[] = [
    { id: 'constant', label: 'CONSTANT', mark: '●' },
    { id: 'curve', label: 'CURVE', mark: '◠' },
    { id: 'map', label: 'MAP', mark: '▦' },
];

const MARK_BY_KIND: Record<string, string> = Object.fromEntries(KINDS.map(k => [k.id, k.mark]));

/** The bucket for the one parameter the XDF files under no category at all.
 *  Without it that symbol is reachable only by search. */
const NO_CATEGORY = -1;

interface KindGroup {
    kind: ParamKind;
    label: string;
    members: GraphNode[];
}

interface CategoryGroup {
    id: number;
    label: string;
    total: number;
    kinds: KindGroup[];
}

const NodeRow = React.memo(function NodeRow({
    node,
    indent,
    isLast,
    selected,
    edited,
    onSelect,
    scrollTo,
}: {
    node: GraphNode;
    /** Left padding in px; 0 draws no guide glyph (the flat lists). */
    indent: number;
    isLast: boolean;
    selected: boolean;
    edited: boolean;
    onSelect: (id: string) => void;
    scrollTo: boolean;
}) {
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (scrollTo) ref.current?.scrollIntoView({ block: 'nearest' });
    }, [scrollTo]);
    const mark = node.t === 'param' ? MARK_BY_KIND[node.kind ?? 'constant'] : node.t === 'func' ? 'ƒ' : '~';
    return (
        <button
            ref={ref}
            onClick={() => onSelect(node.id)}
            style={{ paddingLeft: indent }}
            className={`w-full flex items-center gap-1 text-left h-[22px] min-[900px]:h-[20px] pr-1 transition ${selected ? 'bg-slate-800 text-blue-400' : 'text-slate-400 hover:text-slate-200'}`}
        >
            {indent > 0 && (
                <span className="font-mono text-slate-700 whitespace-pre select-none text-[9px]">
                    {isLast ? '└─▸' : '├─▸'}
                </span>
            )}
            <span className={`text-[9px] ${node.t === 'param' ? 'text-blue-500/70' : 'text-slate-600'}`}>{mark}</span>
            <span className="font-mono text-[10px] truncate">{displayName(node.name, node.t)}</span>
            {edited && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />}
        </button>
    );
});

export function CalibrationTree({
    graph,
    selectedId,
    editedIds,
    onSelect,
    collapsed,
    onToggleCollapse,
}: {
    graph: Indexed;
    selectedId: string | null;
    /** Params with pending edits — a blue dot in the tree. */
    editedIds: ReadonlySet<string>;
    onSelect: (id: string) => void;
    collapsed: boolean;
    onToggleCollapse: () => void;
}) {
    const lang = useDialogLang();
    const [tab, setTab] = useState<TreeTab>('params');
    const [query, setQuery] = useState('');
    const [openCats, setOpenCats] = useState<ReadonlySet<number>>(new Set());
    /** Open kind groups, keyed `${categoryId}:${kind}` — the same kind can be
     *  open under one category and shut under another. */
    const [openKinds, setOpenKinds] = useState<ReadonlySet<string>>(new Set());

    /** Category → kind → symbols, sorted at every level. */
    const categories = useMemo<CategoryGroup[]>(() => {
        const byId = new Map(graph.raw.categories.map(c => [c.id, c]));
        const groups: CategoryGroup[] = [];
        const build = (id: number, label: string, members: GraphNode[]) => {
            if (!members.length) return;
            const kinds = KINDS
                .map(k => ({
                    kind: k.id,
                    label: k.label,
                    // categoryMembers is already name-sorted; the filter keeps that order.
                    members: members.filter(m => (m.kind ?? 'constant') === k.id),
                }))
                .filter(g => g.members.length > 0);
            groups.push({ id, label, total: members.length, kinds });
        };
        for (const cat of graph.raw.categories) {
            build(cat.id, pickLocalised(lang, byId.get(cat.id)), graph.categoryMembers.get(cat.id) ?? []);
        }
        groups.sort((a, b) => a.label.localeCompare(b.label));
        // Uncategorised last: it is a leftover of the source document, not a
        // functional area, and it holds one symbol.
        build(NO_CATEGORY, 'UNCATEGORISED', graph.params.filter(p => !p.cats?.length));
        return groups;
    }, [graph, lang]);

    const namedFuncs = useMemo(
        () => graph.raw.nodes
            .filter(n => n.t === 'func' && n.named)
            .sort((a, b) => a.name.localeCompare(b.name)),
        [graph],
    );

    /** Search runs inside the active tab — the tab says what you are looking
     *  for, so results from the other kind would be answers to another question. */
    const results = useMemo(() => {
        if (!query.trim()) return null;
        const wanted = tab === 'params' ? 'param' : 'func';
        return searchNodes(graph, query, 240).filter(n => n.t === wanted).slice(0, 100);
    }, [graph, query, tab]);

    // A selection made elsewhere (diagram, compare list) brings its tab forward
    // and opens the branches holding it. Render-time adjustment on a genuine
    // selection change only.
    const [prevSelected, setPrevSelected] = useState<string | null>(null);
    if (selectedId !== prevSelected) {
        setPrevSelected(selectedId);
        const node = selectedId ? graph.byId.get(selectedId) : undefined;
        // A selection made elsewhere has to be VISIBLE here, and a query left in
        // the box would filter it out — the tab would come forward holding an
        // empty list. Cleared only when the selection is not already among the
        // results, so clicking one result does not collapse the list you are
        // working through.
        if (selectedId && results && !results.some(r => r.id === selectedId)) setQuery('');
        if (node?.t === 'param') {
            setTab('params');
            const cat = node.cats?.[0] ?? NO_CATEGORY;
            const key = `${cat}:${node.kind ?? 'constant'}`;
            if (!openCats.has(cat)) setOpenCats(new Set([...openCats, cat]));
            if (!openKinds.has(key)) setOpenKinds(new Set([...openKinds, key]));
        }
        if (node?.t === 'func') setTab('funcs');
    }

    if (collapsed) {
        return (
            <div className="w-[28px] flex-none border-r border-slate-900 flex flex-col items-center pt-1">
                <button
                    onClick={onToggleCollapse}
                    className="p-1 text-slate-500 hover:text-slate-300 transition"
                    title="TREE"
                >
                    <ChevronsRight className="w-3.5 h-3.5" />
                </button>
                <span className="mt-2 text-[9px] font-bold tracking-widest text-slate-600 [writing-mode:vertical-rl]">
                    TREE
                </span>
            </div>
        );
    }

    const toggle = <T,>(set: ReadonlySet<T>, key: T): ReadonlySet<T> => {
        const next = new Set(set);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    };

    const tabButton = (id: TreeTab, label: string, count: number) => (
        <button
            onClick={() => setTab(id)}
            className={`h-full flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest border-b-2 transition ${tab === id
                ? 'text-blue-400 border-blue-400'
                : 'text-slate-600 border-transparent hover:text-slate-300'}`}
        >
            {label}
            <span className="font-mono text-[9px] text-slate-600">{count}</span>
        </button>
    );

    // Full width below 900px, where it is the only thing on screen.
    // `min-w-[240px]` against a 360px viewport is what left the diagram 88px:
    // the min-width is a promise about a COLUMN, and on a phone this is not a
    // column.
    return (
        <div className="w-full min-[900px]:w-[38.2%] min-[900px]:min-w-[240px] min-[900px]:max-w-[320px] flex-none border-r border-slate-900 flex flex-col min-h-0">
            <div className="h-[34px] flex-none flex items-center gap-1 px-2 border-b border-slate-900">
                <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder={t(lang, 'search')}
                    className="flex-1 min-w-0 bg-slate-800 rounded px-2 h-[22px] text-[10px] font-mono text-slate-200 placeholder:text-slate-600 outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                    onClick={onToggleCollapse}
                    className="p-1 text-slate-500 hover:text-slate-300 transition shrink-0"
                    title="TREE"
                >
                    <ChevronsLeft className="w-3.5 h-3.5" />
                </button>
            </div>

            <div className="h-[26px] flex-none flex items-center gap-4 px-2 border-b border-slate-900">
                {tabButton('params', t(lang, 'parameters'), graph.params.length)}
                {tabButton('funcs', t(lang, 'functions'), namedFuncs.length)}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto py-1">
                {results ? (
                    <>
                        <div className="px-2 py-1 text-[9px] font-bold tracking-widest text-slate-600">
                            {t(lang, 'results')} · {results.length}
                        </div>
                        {results.map(node => (
                            <NodeRow
                                key={node.id}
                                node={node}
                                indent={0}
                                isLast={false}
                                selected={node.id === selectedId}
                                edited={editedIds.has(node.id)}
                                onSelect={onSelect}
                                scrollTo={false}
                            />
                        ))}
                    </>
                ) : tab === 'params' ? (
                    categories.map(cat => {
                        const open = openCats.has(cat.id);
                        return (
                            <div key={cat.id}>
                                <button
                                    onClick={() => setOpenCats(prev => toggle(prev, cat.id))}
                                    className="w-full flex items-center gap-1.5 px-2 h-[22px] text-left text-[10px] text-slate-300 hover:text-slate-100 transition"
                                >
                                    <span className="text-slate-500 w-2">{open ? '▾' : '▸'}</span>
                                    <span className="flex-1 truncate">{cat.label}</span>
                                    <span className="text-[9px] font-mono text-slate-600">{cat.total}</span>
                                </button>
                                {open && cat.kinds.map(group => {
                                    const key = `${cat.id}:${group.kind}`;
                                    const kindOpen = openKinds.has(key);
                                    return (
                                        <div key={key}>
                                            <button
                                                onClick={() => setOpenKinds(prev => toggle(prev, key))}
                                                className="w-full flex items-center gap-1.5 pl-5 pr-2 h-[20px] text-left text-[9px] font-bold tracking-widest text-slate-500 hover:text-slate-300 transition"
                                            >
                                                <span className="w-2">{kindOpen ? '▾' : '▸'}</span>
                                                <span className="flex-1 truncate">{group.label}</span>
                                                <span className="font-mono text-slate-600">{group.members.length}</span>
                                            </button>
                                            {kindOpen && group.members.map((node, i) => (
                                                <NodeRow
                                                    key={node.id}
                                                    node={node}
                                                    indent={28}
                                                    isLast={i === group.members.length - 1}
                                                    selected={node.id === selectedId}
                                                    edited={editedIds.has(node.id)}
                                                    onSelect={onSelect}
                                                    scrollTo={node.id === selectedId}
                                                />
                                            ))}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })
                ) : (
                    namedFuncs.map(node => (
                        <NodeRow
                            key={node.id}
                            node={node}
                            indent={0}
                            isLast={false}
                            selected={node.id === selectedId}
                            edited={false}
                            onSelect={onSelect}
                            scrollTo={node.id === selectedId}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
