import React, { useMemo, useState } from 'react';
import { Trash2, Database, Plus, Upload, Cable, GitBranch, Check, Pencil, Play, Eye, Download, UploadCloud, Info } from 'lucide-react';
import { TuningSession, FlashRecord } from '@/lib/db/schema';
import { isRoadState, isTuneOnTheRoad } from '@/lib/db/flashState';
import { DropZone } from '@/components/DropZone';
import { dialogText } from '@/lib/dialog-text';

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
    /** Sends this session's log to the preview deployment's store. Absent when no upload token has
     *  been configured, which is the normal state on a desktop and on production. */
    onUploadLog?: (session: TuningSession) => void;
    /** Per-session upload state, keyed by session id. Shown on the same cell as the action, because
     *  "did that land?" is asked about one row, not about the app. */
    uploadState?: Record<string, UploadState>;
    /** Arms this session's stored TUNED for a patch-off flash. Does not write — the hub does. */
    onFinalize: (session: TuningSession) => void;
    /** Sits beside NEW SESSION in this list's own header — the session store lives here.
     *
     *  It used to be an unlabelled cloud icon in the footer's cluster of graph controls, next to the
     *  interpolation table and the field-visibility toggles. Nothing about that row said what it
     *  was, because nothing in that row was about sessions: it configures where sessions go and
     *  pulls them back, which is this list's subject and nobody else's. */
    headerExtra?: React.ReactNode;
}

export type UploadState = 'busy' | 'done' | { error: string };

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

/**
 * The upload affordance, deliberately the same size and place as the download beside it.
 *
 * Its whole job is to answer "did that land?" on the row it belongs to. A phone in a garage loses
 * signal mid-upload often enough that a control which only reports "tapped" is not enough — so it
 * has three states and the failed one keeps its message on hover rather than in an alert that has
 * to be dismissed before the driver can retry.
 */
const UploadCell: React.FC<{ onClick: () => void; state?: UploadState }> = ({ onClick, state }) => {
    const failed = state && typeof state === 'object';
    return (
        <button
            onClick={onClick}
            disabled={state === 'busy'}
            title={failed ? `Upload failed — ${state.error}`
                : state === 'done' ? 'Uploaded. Tap again to replace the stored copy.'
                    : state === 'busy' ? 'Uploading…'
                        : 'Upload this log to the run store'}
            className={`p-0.5 transition-colors shrink-0 rounded hover:bg-slate-800 ${failed ? 'text-red-400 hover:text-red-300'
                : state === 'done' ? 'text-emerald-400/80'
                    : state === 'busy' ? 'text-slate-500 animate-pulse cursor-wait'
                        : 'text-slate-700 hover:text-blue-400'}`}
        >
            <UploadCloud className="w-2.5 h-2.5" />
        </button>
    );
};

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
            f.settings.applyTankVentDisable ? 'TANK VENT SHUT' : null,
        ].filter(Boolean).join(' · ');
        const final = (f.tuned ?? true) && isRoadState(f) ? '  (FINAL)' : '';   // same rule as the badge
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
    onDownloadBase, onDownloadTuned, onDownloadLog, onUploadLog, uploadState, onFinalize, headerExtra,
}) => {
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draftLabel, setDraftLabel] = useState('');
    const [menuFor, setMenuFor] = useState<string | null>(null);
    /** Which cards have their detail line open, on the narrow layout only.
     *
     *  A Set rather than one id at a time, unlike `menuFor`: these are facts you read against each
     *  other — which run was longer, which one was written — and a list that shuts the last card
     *  every time you open the next can't be compared at all. The menu is a menu, so it closes. */
    const [infoFor, setInfoFor] = useState<ReadonlySet<string>>(() => new Set());
    const toggleInfo = (id: string) => setInfoFor(prev => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
    });

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
        // Just the action. The dashed circle, its icon and "NO SAVED SESSIONS YET" said nothing the
        // absence of rows did not already say, and at opacity-50 they read as a disabled control
        // rather than as decoration — a ghost of something you might be able to press.
        //
        // The store belongs in the empty state above all others: a desk that has never opened this
        // app has exactly zero sessions, and pulling one back off the phone is the first thing it
        // wants to do. Hiding the way in until a local session exists would put the recovery route
        // behind the thing it recovers.
        return (
            <div className="h-full flex items-center justify-center gap-2">
                {NewButton}
                {headerExtra}
            </div>
        );
    }

    return (
        <div className="h-full w-full flex flex-col min-h-0">
            <div className="flex-none flex items-center justify-between pb-2 px-1">
                <span className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Sessions</span>
                <span className="flex items-center gap-2">
                    {NewButton}
                    {headerExtra}
                </span>
            </div>

            {/* Five columns need about 730px, and this list sits in a pane that is roughly 0.6 of
                the viewport — so the table only fits without sideways scrolling from about 1280px
                up. Below that it becomes one card per session, because on a phone the columns put
                CONTINUE 550px off the right edge: the whole list was reachable and none of its
                actions were.

                Same DOM either way, switched by display. Two renderings of a row would be two
                places to add the next thing to it, and the one nobody opens on a desk is the one
                that would rot. */}
            <div className="flex-1 min-h-0 overflow-auto">
                <table className="w-full text-left border-collapse block min-[1280px]:table">
                    <thead className="hidden min-[1280px]:table-header-group sticky top-0 bg-slate-900/90 backdrop-blur-sm z-10">
                        <tr className="text-[9px] text-slate-500 uppercase tracking-widest border-b border-slate-800">
                            <th className="px-3 py-2 font-bold">Name / Base</th>
                            <th className="px-3 py-2 font-bold">Date</th>
                            <th className="px-3 py-2 font-bold">Log</th>
                            <th className="px-3 py-2 font-bold">Flashed</th>
                            <th className="px-3 py-2 font-bold text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="block min-[1280px]:table-row-group">
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
                            // What is in the ECU *now* — see flashState.ts, which owns the rule and
                            // is where the harness asks it questions.
                            const isFinal = isTuneOnTheRoad(session);
                            // Nothing to finalize without stored TUNED bytes, and nothing to finalize
                            // if that tune is already in the ECU with the patches off.
                            const canFinalize = canFromTuned && !isFinal;
                            const infoOpen = infoFor.has(session.id);
                            return (
                                // `order` is what puts the actions under the name on a card: the
                                // cells stay in the order the table header promises, and only the
                                // narrow layout re-sequences them to name → actions → facts.
                                <tr key={session.id} className="text-xs group align-top transition-colors hover:bg-slate-900/40 flex flex-wrap items-center gap-x-3 px-3 py-1.5 border-b border-slate-800 min-[1280px]:table-row min-[1280px]:border-slate-900">
                                    <td className="block w-full order-1 py-1 min-[1280px]:table-cell min-[1280px]:w-auto min-[1280px]:px-3 min-[1280px]:py-2">
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
                                                {/* Mutually exclusive with DRAFT by construction, still: FINAL needs a flash
                                                    that carried the tune, and both routes to one (the tuned branch, and a
                                                    finalize on an already-archived session) end with the session archived.
                                                    Saving no longer archives, so a DRAFT can now hold a stored TUNED — but
                                                    not a flashed one. They share a slot without ever colliding.
                                                    emerald is the OK/verified role in this palette, which is what this says:
                                                    the tune is on the road with the patches off. */}
                                                {isFinal && (
                                                    <span
                                                        className="text-[8px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded px-1 py-px shrink-0"
                                                        title="This session's tune was flashed with PATCH, WOT TH and TANK VENT all off — it is in the ECU in its road state."
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
                                                        {/* Kept visible where there is no hover to reveal it — on a phone
                                                            the row simply looked unrenameable. */}
                                                        <Pencil className="w-2.5 h-2.5 shrink-0 opacity-50 min-[1280px]:opacity-0 min-[1280px]:group-hover:opacity-50" />
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
                                    {/* The three readouts, folded away behind ⓘ on a card. They are what
                                        you check about a session, not what you do with it, and at four
                                        lines a card the list only fitted seven of them on a phone. */}
                                    <td className={`${infoOpen ? 'block' : 'hidden'} order-3 font-mono text-slate-500 whitespace-nowrap min-[1280px]:table-cell min-[1280px]:px-3 min-[1280px]:py-2`}>{formatDate(session.createdAt)}</td>
                                    <td className={`${infoOpen ? 'block' : 'hidden'} order-4 font-mono text-slate-500 whitespace-nowrap min-[1280px]:table-cell min-[1280px]:px-3 min-[1280px]:py-2`}>
                                        <span className="inline-flex items-center gap-1.5">
                                            {/* The header carries this on a desk; a card has no header, and
                                                "—" beside another "—" says nothing about which is which. */}
                                            <span className="text-[8px] uppercase tracking-widest text-slate-700 min-[1280px]:hidden">Log</span>
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
                                            {/* Next to the download rather than in the row menu: on a
                                                phone the menu is a sheet, and this is the one action a
                                                driver takes the moment a run ends, standing next to the
                                                car. Only appears once an upload token is configured. */}
                                            {session.hasLog && onUploadLog && (
                                                <UploadCell
                                                    onClick={() => onUploadLog(session)}
                                                    state={uploadState?.[session.id]}
                                                />
                                            )}
                                        </span>
                                    </td>
                                    <td className={`${infoOpen ? 'block' : 'hidden'} order-5 font-mono whitespace-nowrap min-[1280px]:table-cell min-[1280px]:px-3 min-[1280px]:py-2`} title={describeFlashHistory(session.flashHistory)}>
                                        <span className="inline-flex items-center gap-1.5">
                                            <span className="text-[8px] uppercase tracking-widest text-slate-700 min-[1280px]:hidden">Flash</span>
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
                                    <td className="block w-full order-2 whitespace-nowrap relative text-left min-[1280px]:table-cell min-[1280px]:w-auto min-[1280px]:px-3 min-[1280px]:py-2 min-[1280px]:text-right">
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
                                                {/* Hangs off the left on a card, where the trigger is; off the
                                                    right on a desk, where the column is. */}
                                                <div className="absolute z-50 bg-slate-900 border border-slate-700 rounded shadow-xl py-1 text-left left-0 top-8 min-[1280px]:left-auto min-[1280px]:right-8 min-[1280px]:top-9">
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
                                        {/* First of the two floats, so it lands furthest right and holds that
                                            corner whether or not the card is open. Narrow layout only — the
                                            columns it unfolds are all on screen at once on a desk. */}
                                        <button
                                            onClick={() => toggleInfo(session.id)}
                                            aria-expanded={infoOpen}
                                            className={`float-right ml-1 p-1.5 rounded transition-colors hover:bg-slate-800 min-[1280px]:hidden ${infoOpen ? 'text-blue-400' : 'text-slate-600 hover:text-slate-400'}`}
                                            title="Date, log size, flash history — and delete"
                                        >
                                            <Info className="w-3 h-3" />
                                        </button>
                                        <button
                                            onClick={() => { if (confirm(dialogText().deleteSession(session.label))) onDelete(session.id); }}
                                            /* Folded in with the readouts on a card: it was 8px from CONTINUE
                                               under a thumb, and now it takes a deliberate ⓘ first. Left exactly
                                               where it is on a desk, where a pointer does not miss. */
                                            className={`ml-1 mr-3 p-1.5 text-slate-600 hover:text-red-400 transition-colors rounded hover:bg-slate-800 float-right ${infoOpen ? '' : 'hidden'} min-[1280px]:inline-block min-[1280px]:float-none min-[1280px]:mr-0`}
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
