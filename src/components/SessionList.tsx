import React, { useMemo, useState } from 'react';
import { Trash2, Database, Plus, Upload, Cable, GitBranch, Check, Pencil, Play, Eye, Download } from 'lucide-react';
import { TuningSession, FlashRecord } from '@/lib/db/schema';
import { DropZone } from '@/components/DropZone';

export type NewFromWhich = 'tuned' | 'base';

interface Props {
    sessions: TuningSession[];
    loading: boolean;
    error?: string | null;
    onOpen: (session: TuningSession) => void;
    onNewSession: () => void;
    onNewFrom: (session: TuningSession, which: NewFromWhich) => void;
    onRename: (id: string, label: string) => void;
    onDelete: (id: string) => void;
    /** Sets a base-less draft's BASE from a file. Lives on the row because that is the session it
     *  acts on — as a free-floating input above the list it never said which one it applied to. */
    onUploadBase: (session: TuningSession, file: File) => void;
    /** One download per stored artifact, each on the cell that already names it. A single Download
     *  button could never say whether it gave you the BASE or the TUNED; sitting on the column, each
     *  of these can only mean one thing. */
    onDownloadBase: (session: TuningSession) => void;
    onDownloadTuned: (session: TuningSession) => void;
    onDownloadLog: (session: TuningSession) => void;
    /** Arms this session's stored TUNED for a patch-off flash. Does not write — the hub does. */
    onFinalize: (session: TuningSession) => void;
}

/** The download affordance used in every column, so they read as one control repeated rather than
 *  three lookalikes. */
const DownloadCell: React.FC<{ onClick: () => void; title: string }> = ({ onClick, title }) => (
    <button
        onClick={onClick}
        title={title}
        className="p-0.5 text-slate-700 hover:text-blue-400 transition-colors shrink-0 rounded hover:bg-slate-800"
    >
        <Download className="w-2.5 h-2.5" />
    </button>
);

/** The ✔×N count mixes two kinds of event now that arming the patch is itself a flash — "×2" is a
 *  normal first run (patch, then tune) but reads the same as a tune written twice. The number stays
 *  as it is; the breakdown lives here, on hover.
 *
 *  Every line is a stored fact, not a guess: `tuned` says whether a map went with it, `settings` says
 *  how the patches stood. A record from before `tuned` existed is a tune by construction, since a
 *  flash without a derived map had no way to happen then. */
function describeFlashHistory(history: FlashRecord[]): string {
    if (!history.length) return 'Never written to the DME';
    const lines = history.map((f, i) => {
        const kind = (f.tuned ?? true) ? 'TUNED' : 'PATCH ONLY';
        const patches = [
            f.settings.applyPatch ? 'PATCH ON' : 'PATCH OFF',
            f.settings.applyWotDisable ? 'WOT TH ON' : null,
        ].filter(Boolean).join(' · ');
        const final = !f.settings.applyPatch && !f.settings.applyWotDisable ? '  (FINAL)' : '';
        return `${i + 1}. ${formatDate(f.at)}  ${kind.padEnd(10)} ${patches}${final}`;
    });
    return `Written to the DME ${history.length} time${history.length > 1 ? 's' : ''}:\n${lines.join('\n')}`;
}

function formatDate(epochMs: number): string {
    const d = new Date(epochMs);
    return d.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    });
}

interface TreeNode {
    session: TuningSession;
    depth: number;
    /** One flag per ancestor level: does that ancestor still have siblings below it? Drives the
     *  vertical guides, so a branch stays visually connected across intervening rows. */
    guides: boolean[];
    isLast: boolean;
}

/** Builds the lineage tree from parentSessionId. Sessions whose parent is missing (deleted, or a
 *  non-session origin) become roots — the bytes are self-contained, so a lost parent only costs
 *  the visual link, never the session itself. */
function buildTree(sessions: TuningSession[]): TreeNode[] {
    const byId = new Map(sessions.map(s => [s.id, s]));
    const children = new Map<string, TuningSession[]>();
    const roots: TuningSession[] = [];

    for (const s of sessions) {
        const parentId = s.parentSessionId;
        if (parentId && byId.has(parentId)) {
            const list = children.get(parentId) ?? [];
            list.push(s);
            children.set(parentId, list);
        } else {
            roots.push(s);
        }
    }

    const byOldest = (a: TuningSession, b: TuningSession) => a.createdAt - b.createdAt;
    const out: TreeNode[] = [];
    const walk = (s: TuningSession, depth: number, guides: boolean[], isLast: boolean) => {
        out.push({ session: s, depth, guides, isLast });
        const kids = (children.get(s.id) ?? []).sort(byOldest);
        kids.forEach((c, i) => walk(c, depth + 1, [...guides, !isLast], i === kids.length - 1));
    };
    const sortedRoots = roots.sort(byOldest);
    sortedRoots.forEach((r, i) => walk(r, 0, [], i === sortedRoots.length - 1));
    return out;
}

/** The badge answering "where did this tune start from" — the thing a tune can't be judged without.
 *  Exported so the session bar above the map grid can show the same answer without going back here. */
export const OriginBadge: React.FC<{ session: TuningSession; parent?: TuningSession }> = ({ session, parent }) => {
    const o = session.baseOrigin;
    if (!o) return <span className="text-[9px] font-mono text-amber-500/80">BASE NOT SET</span>;

    if (o.kind === 'upload') {
        return (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono text-slate-500" title={o.fileName}>
                <Upload className="w-2.5 h-2.5 shrink-0" />
                <span className="truncate max-w-[180px]">{o.fileName}</span>
            </span>
        );
    }
    if (o.kind === 'dme') {
        const vin = o.vin ? `VIN …${o.vin.slice(-4)}` : 'DME';
        return (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono text-emerald-400/70" title={`${o.vin ?? ''} ${o.aif ?? ''} ${o.softwareVersion ?? ''}`.trim()}>
                <Cable className="w-2.5 h-2.5 shrink-0" /> {vin}
            </span>
        );
    }
    // from another session — prove it really is that session's bytes rather than just claiming it
    const verified = parent && session.baseSha256 && (
        o.which === 'tuned' ? parent.sha256 === session.baseSha256 : parent.baseSha256 === session.baseSha256
    );
    // "#3 · TUNED" rather than a timestamp: which tune this grew out of is the point, and two
    // sessions minutes apart are indistinguishable by date.
    return (
        <span className="inline-flex items-center gap-1 text-[9px] font-mono text-indigo-400/70" title={parent ? parent.label : 'parent deleted'}>
            <GitBranch className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate max-w-[200px]">
                from {parent ? `#${parent.seq ?? '?'}` : '(deleted)'} · {o.which.toUpperCase()}
            </span>
            {verified && <Check className="w-2.5 h-2.5 text-emerald-500/70 shrink-0" />}
        </span>
    );
};

export const SessionList: React.FC<Props> = ({
    sessions, loading, error, onOpen, onNewSession, onNewFrom, onRename, onDelete, onUploadBase,
    onDownloadBase, onDownloadTuned, onDownloadLog, onFinalize,
}) => {
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draftLabel, setDraftLabel] = useState('');
    const [menuFor, setMenuFor] = useState<string | null>(null);

    const tree = useMemo(() => buildTree(sessions), [sessions]);
    const byId = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);

    const commitRename = (id: string) => {
        const next = draftLabel.trim();
        if (next) onRename(id, next);
        setEditingId(null);
    };

    const NewButton = (
        <button
            onClick={onNewSession}
            className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 transition-colors"
        >
            <Plus className="w-3 h-3" /> New Session
        </button>
    );

    if (loading) {
        return (
            <div className="h-full flex items-center justify-center text-slate-700">
                <p className="text-xs font-mono opacity-50">LOADING SESSIONS...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-slate-500 px-6 text-center">
                <Database className="w-6 h-6 text-red-400/60" />
                <p className="text-xs font-mono text-red-400/80">{error}</p>
            </div>
        );
    }

    if (sessions.length === 0) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-slate-700">
                <div className="w-16 h-16 border-2 border-dashed border-slate-800 rounded-full flex items-center justify-center mb-4 opacity-50">
                    <Database className="w-6 h-6 opacity-50" />
                </div>
                <p className="text-xs font-mono opacity-50 mb-4">NO SAVED SESSIONS YET</p>
                {NewButton}
            </div>
        );
    }

    return (
        <div className="h-full w-full flex flex-col min-h-0">
            <div className="flex-none flex items-center justify-between pb-2 px-1">
                <span className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Sessions</span>
                {NewButton}
            </div>

            <div className="flex-1 min-h-0 overflow-auto">
                <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-slate-900/90 backdrop-blur-sm z-10">
                        <tr className="text-[9px] text-slate-500 uppercase tracking-widest border-b border-slate-800">
                            <th className="px-3 py-2 font-bold">Name / Base</th>
                            <th className="px-3 py-2 font-bold">Date</th>
                            <th className="px-3 py-2 font-bold">Log</th>
                            <th className="px-3 py-2 font-bold">Flashed</th>
                            <th className="px-3 py-2 font-bold text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {tree.map(({ session, depth, guides, isLast }) => {
                            const parent = session.parentSessionId ? byId.get(session.parentSessionId) : undefined;
                            const isDraft = session.status === 'draft';
                            const flashes = session.flashHistory.length;
                            // Each branch is offered only where its bytes actually exist. Gating the
                            // menu on sha256 alone meant it always showed both, so "From TUNED" was
                            // offered for a session that had never produced one — and a session with
                            // only a BASE could not be branched from at all, though retrying from the
                            // same start is exactly what it is good for.
                            const canFromTuned = !!session.sha256;
                            const canFromBase = !!session.baseOrigin;
                            // What is in the ECU *now* — the LAST flash, not any of them. Re-flashing
                            // patch-on afterwards must take the badge away again, which is the whole
                            // reason this reads the tail rather than searching the history.
                            // Both patches, matching the definition the PATCH-ON export uses: WOT TH
                            // rewrites DME logic just as PATCH does, so a tune still carrying it has
                            // not been handed back to the road yet.
                            const lastFlash = session.flashHistory.at(-1);
                            const isFinal = !!lastFlash && !lastFlash.settings.applyPatch && !lastFlash.settings.applyWotDisable;
                            // Nothing to finalize without stored TUNED bytes, and nothing to finalize
                            // if the patches are already off in the ECU.
                            const canFinalize = canFromTuned && !isFinal;
                            return (
                                <tr key={session.id} className="text-xs border-b border-slate-900 hover:bg-slate-900/40 transition-colors group align-top">
                                    <td className="px-3 py-2">
                                        <div className="flex flex-col gap-0.5 min-w-0">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                {/* Real tree guides. A lone "└" per row left every branch floating —
                                                    with the verticals you can trace a tune back to its root. */}
                                                {depth > 0 && (
                                                    <span className="font-mono text-slate-700 shrink-0 whitespace-pre leading-none select-none">
                                                        {guides.slice(1).map(more => (more ? '│  ' : '   ')).join('')}
                                                        {isLast ? '└─▸' : '├─▸'}
                                                    </span>
                                                )}
                                                <span className="text-[9px] font-mono font-bold text-slate-600 shrink-0" title="Session number">
                                                    #{session.seq ?? '?'}
                                                </span>
                                                {isDraft && (
                                                    <span className="text-[8px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/30 rounded px-1 py-px shrink-0">
                                                        DRAFT
                                                    </span>
                                                )}
                                                {/* Mutually exclusive with DRAFT by construction — a flash archives the
                                                    session, so nothing that has reached the ECU is still a draft. They can
                                                    share a slot without ever colliding.
                                                    emerald is the OK/verified role in this palette, which is what this says:
                                                    the tune is on the road with the patches off. */}
                                                {isFinal && (
                                                    <span
                                                        className="text-[8px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded px-1 py-px shrink-0"
                                                        title="Last flashed with PATCH and WOT TH off — this tune is in the ECU in its road state."
                                                    >
                                                        FINAL
                                                    </span>
                                                )}
                                                {editingId === session.id ? (
                                                    <input
                                                        autoFocus
                                                        value={draftLabel}
                                                        onChange={e => setDraftLabel(e.target.value)}
                                                        onBlur={() => commitRename(session.id)}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') commitRename(session.id);
                                                            if (e.key === 'Escape') setEditingId(null);
                                                        }}
                                                        className="bg-slate-800 text-slate-200 text-xs px-1 py-0.5 rounded outline-none border border-blue-500/50 min-w-0 flex-1"
                                                    />
                                                ) : (
                                                    <button
                                                        onClick={() => { setEditingId(session.id); setDraftLabel(session.label); }}
                                                        className="inline-flex items-center gap-1 text-slate-300 hover:text-blue-400 transition-colors min-w-0"
                                                        title="Click to rename"
                                                    >
                                                        <span className="truncate max-w-[220px]">{session.label}</span>
                                                        <Pencil className="w-2.5 h-2.5 opacity-0 group-hover:opacity-50 shrink-0" />
                                                    </button>
                                                )}
                                            </div>
                                            <div className="pl-0.5 flex items-center gap-3">
                                                <OriginBadge session={session} parent={parent} />
                                                {/* Keyed on baseOrigin, which is exactly what says the BASE bytes were stored. */}
                                                {session.baseOrigin && (
                                                    <DownloadCell
                                                        onClick={() => onDownloadBase(session)}
                                                        title="Download this session's BASE bytes — what it started from"
                                                    />
                                                )}
                                                {/* A draft with no BASE is unusable until one is picked, so the ways to pick
                                                    one sit right on it: a file here, the DME via the main button, or another
                                                    session via "Use as base" on its row. */}
                                                {isDraft && !session.baseOrigin && (
                                                    <>
                                                        <span className="group/up relative inline-flex items-center gap-1 cursor-pointer text-[9px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300">
                                                            <Upload className="w-2.5 h-2.5" /> Upload BIN
                                                            <DropZone
                                                                label=""
                                                                accept=".bin"
                                                                onFileSelect={file => onUploadBase(session, file)}
                                                                className="!absolute !inset-0 !opacity-0 !border-0 cursor-pointer"
                                                            />
                                                        </span>
                                                        <span className="inline-flex items-center gap-1 text-[9px] font-mono text-slate-600">
                                                            <Cable className="w-2.5 h-2.5" /> or READ from the DME
                                                        </span>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 font-mono text-slate-500 whitespace-nowrap">{formatDate(session.createdAt)}</td>
                                    <td className="px-3 py-2 font-mono text-slate-500 whitespace-nowrap">
                                        <span className="inline-flex items-center gap-1.5">
                                            {session.hasLog
                                                ? <span className="text-emerald-400/80">{session.logPointCount.toLocaleString()}</span>
                                                : <span className="text-slate-700">—</span>}
                                            {/* Sits with the point count rather than in a column of its
                                                own: the rate is a property of this log, and the table is
                                                already five columns inside the 61.8% pane.
                                                Absent for rows saved before averageHz existed, and for a
                                                log too short to measure — nothing renders either way,
                                                which beats showing a confident 0.0. */}
                                            {session.hasLog && session.averageHz !== undefined && (
                                                <span className="text-slate-600" title="Mean sample rate of this log">
                                                    {session.averageHz.toFixed(1)}Hz
                                                </span>
                                            )}
                                            {session.hasLog && (
                                                <DownloadCell
                                                    onClick={() => onDownloadLog(session)}
                                                    title="Download this session's log as a Testo-format CSV"
                                                />
                                            )}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 font-mono whitespace-nowrap" title={describeFlashHistory(session.flashHistory)}>
                                        <span className="inline-flex items-center gap-1.5">
                                            {flashes
                                                ? <span className="text-emerald-400/90">✔{flashes > 1 ? `×${flashes}` : ''}</span>
                                                : <span className="text-slate-700">—</span>}
                                            {/* Keyed on the tune existing (sha256), not on having been flashed: a saved but
                                                never-written tune is still bytes worth inspecting, and the ✔/— beside this
                                                already says which it is. */}
                                            {session.sha256 && (
                                                <DownloadCell
                                                    onClick={() => onDownloadTuned(session)}
                                                    title="Download this session's TUNED bytes — what WRITE sent, or would send"
                                                />
                                            )}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 text-right whitespace-nowrap relative">
                                        {/* One word per outcome. "Open" meant two different things —
                                            resume work on a draft vs look at a locked archive — and a
                                            folder icon said neither. */}
                                        {isDraft ? (
                                            <button
                                                onClick={() => onOpen(session)}
                                                className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded hover:bg-slate-800"
                                                title="Resume tuning this session"
                                            >
                                                <Play className="w-3 h-3" /> Continue
                                            </button>
                                        ) : (
                                            <button
                                                onClick={() => onOpen(session)}
                                                className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-200 transition-colors px-2 py-1 rounded hover:bg-slate-800"
                                                title="Read-only: inspect the maps and log, and flash them. No tuning."
                                            >
                                                <Eye className="w-3 h-3" /> Review
                                            </button>
                                        )}
                                        {/* Was "Use as base ▾", which named only half of what is in here now.
                                            Finalize does NOT start a session — it arms this one's stored TUNED
                                            for a patch-off flash — so leaving it under a trigger that promised
                                            "Start a NEW tuning session" would have been the same kind of lie the
                                            entries themselves are careful to avoid. The group headings carry the
                                            distinction the trigger used to. */}
                                        {(canFromTuned || canFromBase || canFinalize) && (
                                            <button
                                                onClick={() => setMenuFor(menuFor === session.id ? null : session.id)}
                                                className="ml-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-indigo-400 transition-colors px-2 py-1 rounded hover:bg-slate-800"
                                                title="Branch a new session from this one's bytes, or finalize this tune"
                                            >
                                                <GitBranch className="w-3 h-3" /> Actions ▾
                                            </button>
                                        )}
                                        {menuFor === session.id && (
                                            <>
                                                <div className="fixed inset-0 z-40" onClick={() => setMenuFor(null)} />
                                                <div className="absolute right-8 top-9 z-50 bg-slate-900 border border-slate-700 rounded shadow-xl py-1 text-left">
                                                    {(canFromTuned || canFromBase) && (
                                                        <div className="px-3 pt-1 pb-0.5 text-[8px] font-bold uppercase tracking-widest text-slate-600">
                                                            New session
                                                        </div>
                                                    )}
                                                    {canFromTuned && (
                                                        <button
                                                            onClick={() => { setMenuFor(null); onNewFrom(session, 'tuned'); }}
                                                            className="block w-full text-left px-3 py-1.5 text-[10px] font-mono text-slate-300 hover:bg-slate-800 whitespace-nowrap"
                                                        >
                                                            From TUNED <span className="text-slate-600">(continue from this tune)</span>
                                                        </button>
                                                    )}
                                                    {canFromBase && (
                                                        <button
                                                            onClick={() => { setMenuFor(null); onNewFrom(session, 'base'); }}
                                                            className="block w-full text-left px-3 py-1.5 text-[10px] font-mono text-slate-300 hover:bg-slate-800 whitespace-nowrap"
                                                        >
                                                            From BASE <span className="text-slate-600">(retry from the same start)</span>
                                                        </button>
                                                    )}
                                                    {canFinalize && (
                                                        <>
                                                            {(canFromTuned || canFromBase) && <div className="my-1 border-t border-slate-800" />}
                                                            <div className="px-3 pt-1 pb-0.5 text-[8px] font-bold uppercase tracking-widest text-slate-600">
                                                                This session
                                                            </div>
                                                            <button
                                                                onClick={() => { setMenuFor(null); onFinalize(session); }}
                                                                className="block w-full text-left px-3 py-1.5 text-[10px] font-mono text-slate-300 hover:bg-slate-800 whitespace-nowrap"
                                                                title="Loads this tune with PATCH and WOT TH off, ready for the hub to write. Nothing is sent until you press WRITE."
                                                            >
                                                                Finalize <span className="text-slate-600">(patch off, then WRITE)</span>
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                        <button
                                            onClick={() => { if (confirm(`Delete "${session.label}"? This cannot be undone.`)) onDelete(session.id); }}
                                            className="ml-1 p-1.5 text-slate-600 hover:text-red-400 transition-colors rounded hover:bg-slate-800"
                                            title="Delete session"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
};
