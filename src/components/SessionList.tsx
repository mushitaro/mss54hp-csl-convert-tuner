import React, { useCallback, useMemo, useState } from 'react';
import { Trash2, Database, Plus, Upload, Cable, GitBranch, AlertTriangle, Check, Pencil, Play, Eye, Download, UploadCloud, Info } from 'lucide-react';
import { TuningSession, FlashRecord } from '@/lib/db/schema';
import { flashCounts, isRoadState, isTuneOnTheRoad, armedPatchesFromHistory, patchOnFlash, wroteTune } from '@/lib/db/flashState';
import { DropZone, ACCEPT_CSV } from '@/components/DropZone';
import type { LogicPatches } from '@/lib/binary-engine/patcher';
import { dialogText } from '@/lib/dialog-text';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * The ACTIONS sheet's explanations, in the reader's language.
 *
 * The LABELS are not in here and must not be: From TUNED, From BASE, Finalize, Download BASE,
 * Delete session are the instrument's vocabulary — the same words in both languages, and the
 * chain a label-is-a-promise depends on. What follows a label is an explanation, which is the
 * class of text that follows the reader (house rule; the app resolves it from navigator.language
 * in one place).
 *
 * The download rows have no explanation at all. They were shipped with one — "(what it started
 * from)", "(what WRITE would send)" — and the operator's answer was the correct one: they
 * download a file, and the label already says which (2026-08-25).
 */
const SHEET_TEXT = {
    ja: {
        fromTuned: '（このチューンの続きから）',
        fromBase: '（同じ出発点でやり直す）',
        finalize: '（パッチを外して WRITE へ）',
        empty: 'まだ何も保存されていません',
    },
    en: {
        fromTuned: '(continue from this tune)',
        fromBase: '(retry from the same start)',
        finalize: '(patch off, then WRITE)',
        empty: 'Nothing stored yet',
    },
} as const;

export type NewFromWhich = 'tuned' | 'base';

/** Any of the three logic patches on. The three are one state everywhere they are read — a BIN
 *  with only TANK VENT shut is not stock either. */
const anyPatch = (p: Partial<LogicPatches>): boolean =>
    !!(p.applyPatch || p.applyWotDisable || p.applyTankVentDisable);

interface Props {
    sessions: TuningSession[];
    loading: boolean;
    error?: string | null;
    onOpen: (session: TuningSession) => void;
    onNewSession: () => void;
    /**
     * A control that belongs beside NEW SESSION, to its left.
     *
     * The store's door, and so far only that. It had been living in the wide layout's panel row
     * beside the tabs — a cloud among chart controls, in a bar about the log — where it was neither
     * findable nor about anything else in that row. Everything it opens is about THESE rows: what is
     * on the server, and pulling one back into this list. So it goes where they are, next to NEW
     * SESSION, which is the arrangement the narrow layout's menu sheet already had.
     *
     * Empty on a phone, because the sheet still has it there and one entry per layout is the rule
     * this move exists to keep. A slot rather than a `storePanel` prop, because this list must not
     * know what a sync is: it knows there is one action next to its own, and the page decides what
     * that is per width.
     */
    beforeNew?: React.ReactNode;
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
    /**
     * The BASE with this session's logic patches on, checksum corrected — the bytes that went into
     * the car BEFORE the log run.
     *
     * A third artifact, and it had nowhere to be: a session stores its BASE unpatched and its TUNED
     * fully built, so the image in between existed only live, from the open session's toggles.
     * Rebuilt on demand from the stored BASE and the patches on record.
     */
    onDownloadPatchOn: (session: TuningSession) => void;
    /**
     * What the STORED BASE is carrying, read off its bytes.
     *
     * Asked when a row's sheet opens, not while the list renders: it is a database read per
     * session, and the answer is only needed by the surface that offers the files. Cached by
     * session id for as long as the list is mounted — the stored BASE cannot change under it,
     * `setBase` writes once.
     */
    onInspectBase: (session: TuningSession) => Promise<LogicPatches | null>;
    onDownloadLog: (session: TuningSession) => void;
    /**
     * Loads a Testo CSV into the WORKSPACE, which is why it takes no session: a log is read into
     * the session that is open, and only one is.
     *
     * Offered on the open row and nowhere else. The alternative — accepting a CSV on any row —
     * means switching sessions first, and the map that switch produces is not visible to the
     * handler that would then need it (see handleOpenSession, which passes its own `map` for
     * exactly this reason). A control that loads a log and cannot derive from it is worse than one
     * that waits for CONTINUE.
     *
     * The desk has the same control in the session bar. That bar is `min-[900px]` and up — and it
     * is also `activeTab !== 'startup'`, so on the STARTUP screen this row is the only way in at
     * ANY width.
     *
     * Takes the session, exactly like `onUploadBase`, and that is the fix for the bug this shape
     * replaced. It used to take only the file, so it needed the row to already be the open one and
     * was gated on `isOpen` — which meant that after a reload, when `activeSessionId` is null,
     * the CSV entry was gone from every row while UPLOAD BIN sat right beside it still working,
     * because BIN never needed the session open. One control vanishing and its neighbour surviving
     * on the same row is what "the upload entry disappeared" was. Now the page opens the session
     * first and loads second, the way the BIN path has always done.
     */
    onLoadLogFile?: (session: TuningSession, file: File) => void;
    /** Whether the workspace can take one: nothing loaded yet, and the session is not archived. */
    canLoadLogFile?: boolean;
    /**
     * The way back OUT, and the same story as the control above told in reverse.
     *
     * The session bar is where a loaded log states its name and offers the bin — and that bar is
     * `min-[900px]` and up. So the row was given the way IN and not the way out: on a phone the
     * TESTO CSV control vanished the moment a CSV landed, replaced by nothing, with no way to see
     * which file was loaded and no way to remove it. Reported from the car as "the upload icon
     * disappeared".
     *
     * `loadedLogName` is the WORKSPACE's log, not `session.hasLog` — the same distinction
     * `canLoadLogFile` draws, and these two are exact opposites: precisely one of them renders.
     */
    loadedLogName?: string;
    /** Valid points in it, when they have been counted. Absent renders nothing rather than 0. */
    loadedLogPoints?: number;
    /** Absent on an archived session, which states its log but cannot drop it — mirroring the bar. */
    onClearLog?: (e: React.MouseEvent) => void;
    /** Sends this session's log to the preview deployment's store — NOT the control above. Absent
     *  when no upload token has been configured, which is the normal state on a desktop and on
     *  production. */
    onUploadLog?: (session: TuningSession) => void;
    /** Per-session upload state, keyed by session id. Shown on the same cell as the action, because
     *  "did that land?" is asked about one row, not about the app. */
    uploadState?: Record<string, UploadState>;
    /** Arms this session's stored TUNED for a patch-off flash. Does not write — the hub does. */
    onFinalize: (session: TuningSession) => void;
    /**
     * Which session the rest of the app is currently showing.
     *
     * The list had no way to say it, and it is the one fact a list of sessions most needs to carry:
     * the maps, the log, the toggles and WRITE all act on ONE of these rows, and every other tab
     * shows the consequences without ever naming which. Opening a second session from here changes
     * what WRITE would send — so which one is loaded is not decoration.
     */
    activeSessionId?: string | null;
}

export type UploadState = 'busy' | 'done' | { error: string };

/**
 * One row of the ACTIONS sheet.
 *
 * `py-4` below 1280 and `py-1.5` above it: on a card this sheet is the only place several of
 * these actions exist - the files, and DELETE - so its rows have to be thumb-sized. Measured at
 * 375: 28px as it was, 37px at py-3, 45px at py-4.
 * On a desk it stays the compact anchored menu it has always been.
 */
const SHEET_ROW = 'block w-full text-left px-3 py-4 min-[1280px]:py-1.5 text-[10px] font-mono '
    + 'text-slate-300 hover:bg-slate-800 whitespace-nowrap';

/**
 * The download affordance used in every column, so they read as one control repeated rather than
 * three lookalikes.
 *
 * A DESK control. It is a 10px glyph in a 14px box, drawn in slate-700 and revealed by hover —
 * which is a pointer's affordance and nothing at all on a phone, where it reads as a row of faint
 * dead icons (operator, 2026-08-25). The same files are reachable on a card from the row's
 * ACTIONS sheet, as full-width labelled rows, which is also the only way to give them a target a
 * thumb can hit. */
const DownloadCell: React.FC<{ onClick: () => void; title: string }> = ({ onClick, title }) => (
    <button
        onClick={onClick}
        title={title}
        className="hidden min-[1280px]:inline-block p-0.5 text-slate-700 hover:text-blue-400 transition-colors shrink-0 rounded hover:bg-slate-800"
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
            className={`hidden min-[1280px]:inline-block p-0.5 transition-colors shrink-0 rounded hover:bg-slate-800 ${failed ? 'text-red-400 hover:text-red-300'
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
        // PRACTICE first and in full caps, because it changes what every other word on the line
        // means: none of these bytes reached an ECU. `undefined` is not `false` here — a record
        // written before the field existed cannot say, and guessing "real" in a tooltip about what
        // is in a car is how a rehearsal got mistaken for a failed write for three days.
        const where = f.practice === true ? 'PRACTICE  '
            : f.practice === undefined ? '(pre-flag) ' : '';
        const final = !f.practice && (f.tuned ?? true) && isRoadState(f) ? '  (FINAL)' : '';
        return `${i + 1}. ${formatDate(f.at)}  ${where}${kind.padEnd(10)} ${patches}${final}`;
    });
    const real = history.filter(f => !f.practice).length;
    const head = real === history.length
        ? `Written to the DME ${real} time${real > 1 ? 's' : ''}:`
        : `Written to the DME ${real} time${real === 1 ? '' : 's'}, plus ${history.length - real} PRACTICE run${history.length - real > 1 ? 's' : ''} that moved no bytes:`;
    return `${head}\n${lines.join('\n')}`;
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
    // From another session — and the question is whether these really ARE that session's bytes.
    //
    // The comparison is only possible when both hashes exist; absent is not a mismatch, and a
    // session whose parent predates `baseSha256` must not be accused of anything.
    const parentHash = o.which === 'tuned' ? parent?.sha256 : parent?.baseSha256;
    const comparable = !!parent && !!session.baseSha256 && !!parentHash;
    const mismatched = comparable && parentHash !== session.baseSha256;
    // "#3 · TUNED" rather than a timestamp: which tune this grew out of is the point, and two
    // sessions minutes apart are indistinguishable by date.
    return (
        <span className="inline-flex items-center gap-1 text-[9px] font-mono text-indigo-400/70" title={parent ? parent.label : 'parent deleted'}>
            <GitBranch className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate max-w-[200px]">
                from {parent ? `#${parent.seq ?? '?'}` : '(deleted)'} · {o.which.toUpperCase()}
            </span>
            {/* Only the exception speaks.
                ────────────────────────────────────────────────────────────────────────────────
                This carried an emerald ✓ when the hashes MATCHED — the normal case, on every
                branched session, right beside the word TUNED. It was read as "a tune was written",
                which is a claim about the ECU that this badge has never made: it is lineage, and
                the ✓ meant only "these bytes really are #3's". A mark that is true every time
                carries nothing and, here, carried something false. Reported by the operator
                2026-08-24, twice, because the first fix went to the wrong indicator.
                A mismatch is worth interrupting for, so that is what shows. */}
            {mismatched && (
                <AlertTriangle
                    className="w-2.5 h-2.5 text-amber-400 shrink-0"
                    aria-label="These bytes do not match that session's"
                />
            )}
        </span>
    );
};

/**
 * What this session HAS, as four words that are either lit or not.
 *
 * It replaces a row of glyphs that each meant something different and none of which said so: a
 * point count that also stood for "there is a log", a ✔ that counted every write including
 * patch-only ones, and a lineage tick beside the word TUNED that was read — twice, by the person
 * who built the car — as "a tune was written". Four nouns, present or absent, and nothing to
 * decode:
 *
 *     BASE    bytes to work from        PATCH   the logic patches are in effect
 *     LOG     a drive was recorded      TUNED   a tune from here went to the ECU
 *
 * Three of them are STATE and one is an ACT, and both halves of that were arrived at by getting
 * them wrong. TUNED was keyed on a tune EXISTING — but a map is derived the moment a log meets a
 * BASE, so it lit on 15 of the 20 sessions in the store, including every one that had only been
 * driven; a mark that is true almost always is not a mark, and what the operator means by having
 * tuned a session is that a tune went to the car. PATCH then followed it to "this session wrote
 * the patches", and a session working on an already-patched car went dark — but whether the
 * patches are in effect is exactly what decides how its log has to be read, and that does not
 * depend on which session did the writing.
 *
 * The check is the remaining exception: that tune is still what the ECU is holding, as opposed to
 * written at some point and since patched over.
 *
 * Lit is the palette's OK/verified step, which globals.css defines as "verified / done / present"
 * — the four words say nothing else, so nothing else would have been a decoration. It replaced
 * slate-300, a light neutral that read as plain white text on a row whose every other neutral is
 * also grey; ice blue at 15.4:1 is no louder and is the one register in this instrument that means
 * "this is here". All four share it: which word is lit is the information, and giving each its own
 * hue would have spent four colours saying one thing. Absent stays slate-700, dark enough to be a
 * ghost of the word rather than a claim about it.
 */
const Token: React.FC<{ on: boolean; children: React.ReactNode; title: string }> = ({ on, children, title }) => (
    <span className={on ? 'text-emerald-400' : 'text-slate-700'} title={title}>{children}</span>
);

const Contents: React.FC<{ session: TuningSession }> = ({ session }) => {
    // PATCH is a state, not an act: the question it answers is whether the logic patches are IN
    // EFFECT for this session — which is what decides how its log has to be read — and that stays
    // true no matter which session did the writing. It was briefly keyed on "this session wrote
    // them", and a session working on a patched car went dark. `tuneSettings` once a tune has been
    // saved, the session's own last real flash otherwise: the two places that know, in the order
    // flashState already trusts them.
    const patches = session.tuneSettings ?? armedPatchesFromHistory(session) ?? {};
    const patched = !!(patches.applyPatch || patches.applyWotDisable || patches.applyTankVentDisable);
    const { practice } = flashCounts(session);
    return (
        <span className="inline-flex items-center gap-1.5 text-[9px] font-mono leading-none whitespace-nowrap">
            <Token on={!!session.baseOrigin} title="BASE bytes are stored for this session">BASE</Token>
            <Token on={patched} title="The logic patches are in effect for this session (PATCH / WOT TH / TEV)">PATCH</Token>
            <Token on={session.hasLog} title="A drive was recorded into this session">LOG</Token>
            <Token on={wroteTune(session)} title="This session wrote a tune to the ECU">TUNED</Token>
            {/* Still in the ECU, as opposed to written at some point and since patched over. The
                exception, so it only speaks when it is true — and TUNED already says the tune went
                out, which is what the word was being read as all along. */}
            {/* One step down the same ramp, which globals.css reserves for check marks — the
                words took -400 when they stopped being grey, and a mark that shares a colour with
                the word beside it stops being a mark. */}
            {isTuneOnTheRoad(session) && (
                <Check className="w-2.5 h-2.5 text-emerald-500 shrink-0"
                    aria-label="That tune is still what the ECU is holding" />
            )}
            {/* Amber, never a tick: PRACTICE moved no bytes. Kept because "I wrote this" is a thing
                people remember doing, and nothing at all beside that memory reads as data loss. */}
            {practice > 0 && (
                <span className="text-amber-500/80" title="PRACTICE writes — no cable, no ECU">
                    P{practice > 1 ? `×${practice}` : ''}
                </span>
            )}
        </span>
    );
};

export const SessionList: React.FC<Props> = ({
    sessions, loading, error, onOpen, onNewSession, onNewFrom, onRename, onDelete, onUploadBase,
    onDownloadBase, onDownloadTuned, onDownloadPatchOn, onInspectBase,
    onDownloadLog, onLoadLogFile, canLoadLogFile = false, loadedLogName, loadedLogPoints, onClearLog,
    onUploadLog, uploadState, onFinalize,
    activeSessionId, beforeNew,
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

    /**
     * Open at the bottom, which is where the newest session is.
     *
     * The tree is sorted oldest-first — a parent has to be on screen before the branch that came
     * out of it means anything — so the row you almost certainly came here for is the last one,
     * and past about a dozen sessions it was below the fold every time. STARTUP opened on the
     * oldest session in the store: the one nobody is working on.
     *
     * A callback ref rather than an effect, because the list is not always what mounts. `loading`
     * and the empty case return different trees entirely, so the scroll container appears when the
     * rows do, whichever render that turns out to be — and this fires exactly then, in the commit
     * before paint, so nothing is ever seen scrolling. The identity is stable, so it does not fire
     * again on re-render: adding a session or opening an ⓘ leaves the scroll where the reader put
     * it. Below the fold is the only case that does anything — the assignment is a no-op when
     * everything already fits.
     */
    const landOnNewest = useCallback((el: HTMLDivElement | null) => {
        if (el) el.scrollTop = el.scrollHeight;
    }, []);

    const st = SHEET_TEXT[useDialogLang()];
    /**
     * What each session's stored BASE is carrying. `undefined` = not asked yet, `null` = no bytes.
     *
     * Filled when a sheet opens rather than for every row on mount: twenty sessions is twenty
     * database reads of 64 KB each, to answer a question only the open sheet asks.
     */
    const [baseState, setBaseState] = useState<Record<string, LogicPatches | null>>({});
    const openMenu = (session: TuningSession) => {
        setMenuFor(prev => (prev === session.id ? null : session.id));
        if (!(session.id in baseState) && session.baseOrigin) {
            void onInspectBase(session)
                .then(p => setBaseState(prev => ({ ...prev, [session.id]: p })))
                .catch(() => setBaseState(prev => ({ ...prev, [session.id]: null })));
        }
    };
    const tree = useMemo(() => buildTree(sessions), [sessions]);
    const byId = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);

    const commitRename = (id: string) => {
        const next = draftLabel.trim();
        if (next) onRename(id, next);
        setEditingId(null);
    };

    /** The list's own actions, as one group: the door on the left, the action on the right.
     *
     *  Same order and same gap in both places this appears, so the empty list and the full one do
     *  not put the same two controls in two arrangements. NEW SESSION keeps blue — it is the
     *  primary thing to do here — and the door beside it stays neutral until hovered. */
    const NewRow = (
        <div className="flex items-center gap-3">
            {beforeNew}
            <button
                onClick={onNewSession}
                className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 transition-colors"
            >
                <Plus className="w-3 h-3" /> New Session
            </button>
        </div>
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
        // SYNC stands beside it again on a desk, and the original argument was right: a machine
        // that has never opened this app wants to pull a session back before it can do anything
        // else, and this is the screen it is looking at. The intervening home — the panel row
        // beside the tabs — put it where nothing else was about sessions.
        return (
            <div className="h-full flex items-center justify-center">
                {NewRow}
            </div>
        );
    }

    return (
        <div className="h-full w-full flex flex-col min-h-0">
            <div className="flex-none flex items-center justify-between pb-2 px-1">
                <span className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Sessions</span>
                {NewRow}
            </div>

            {/* Five columns need about 730px, and this list sits in a pane that is roughly 0.6 of
                the viewport — so the table only fits without sideways scrolling from about 1280px
                up. Below that it becomes one card per session, because on a phone the columns put
                CONTINUE 550px off the right edge: the whole list was reachable and none of its
                actions were.

                Same DOM either way, switched by display. Two renderings of a row would be two
                places to add the next thing to it, and the one nobody opens on a desk is the one
                that would rot. */}
            <div ref={landOnNewest} className="flex-1 min-h-0 overflow-auto">
                <table className="w-full text-left border-collapse block min-[1280px]:table">
                    <thead className="hidden min-[1280px]:table-header-group sticky top-0 bg-slate-900/90 backdrop-blur-sm z-10">
                        <tr className="text-[9px] text-slate-500 uppercase tracking-widest border-b border-slate-800">
                            <th className="px-3 py-2 font-bold">Name / Base</th>
                            <th className="px-3 py-2 font-bold">Date</th>
                            <th className="px-3 py-2 font-bold">Log</th>
                            <th className="px-3 py-2 font-bold">Has</th>
                            <th className="px-3 py-2 font-bold text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="block min-[1280px]:table-row-group">
                        {tree.map(({ session, depth, guides, isLast }) => {
                            const parent = session.parentSessionId ? byId.get(session.parentSessionId) : undefined;
                            const isDraft = session.status === 'draft';
                            // Per ROW, unlike `canLoadLogFile`, which is one boolean about the
                            // WORKSPACE. A row that is not the open one is asking to become it, so
                            // the workspace's current contents do not gate it — opening clears them.
                            const isArchivedRow = session.status === 'archived';
                            // Real writes and rehearsals counted apart — see flashState.ts. A ✔ is a
                            // claim about the car, so only a real flash may put one there.
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
                            /** The PATCH-ON image this session actually wrote, if it wrote one. From the
                             *  flash history rather than `tuneSettings` — see patchOnFlash. */
                            const wrotePatchOn = patchOnFlash(session);
                            /** What its stored BASE is carrying. Undefined until the sheet has asked. */
                            const basePatches = baseState[session.id];
                            const infoOpen = infoFor.has(session.id);
                            const isOpen = session.id === activeSessionId;
                            /**
                             * Whether THIS row has room for a log, and the two halves answer to
                             * different owners.
                             *
                             * Open row: the WORKSPACE decides. `loadRawLog` publishes a File for a
                             * restored log just as `parseAndSetLog` does for a picked one, so
                             * `canLoadLogFile` is already false whenever one is loaded — and
                             * binning it brings this control straight back, which is the replace
                             * path.
                             *
                             * Any other row: the SESSION decides. It was `true` here, which
                             * offered TESTO CSV on rows that already hold a log — the entry was
                             * back before it had anywhere to go, and dropping a file on it would
                             * have replaced a stored log from a row that is not even open. There
                             * is no bin on a closed row and there should not be one: open it, and
                             * the name, the count and the bin are all there.
                             */
                            const rowCanTakeLog = isOpen ? canLoadLogFile : !session.hasLog;
                            return (
                                // `order` is what puts the actions under the name on a card: the
                                // cells stay in the order the table header promises, and only the
                                // narrow layout re-sequences them to name → actions → facts.
                                // The open one is tinted rather than badged alone, because the thing
                                // being answered is "which row is the rest of the app about" — a
                                // question the eye asks of the whole list at once, and a badge has
                                // to be found before it can be read. The OPEN chip beside it says
                                // in words what the colour says at a glance; neither is enough by
                                // itself, and blue is already this palette's "you are here" (the
                                // active tab, the current pane).
                                <tr key={session.id} className={`text-xs group align-top transition-colors flex flex-wrap items-center gap-x-3 px-3 py-1.5 border-b min-[1280px]:table-row ${isOpen
                                    ? 'bg-blue-500/10 hover:bg-blue-500/15 border-blue-500/20 min-[1280px]:border-blue-500/20'
                                    : 'hover:bg-slate-900/40 border-slate-800 min-[1280px]:border-slate-900'}`}>
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
                                                <span className={`text-[9px] font-mono font-bold shrink-0 ${isOpen ? 'text-blue-400' : 'text-slate-600'}`} title="Session number">
                                                    #{session.seq ?? '?'}
                                                </span>
                                                {/* Shares the badge slot with DRAFT and FINAL, and
                                                    can legitimately sit beside either: those say
                                                    what the session IS, this says where the app is
                                                    pointed. */}
                                                {isOpen && (
                                                    <span
                                                        className="text-[8px] font-bold text-blue-300 bg-blue-500/15 border border-blue-500/40 rounded px-1 py-px shrink-0"
                                                        title="This is the session the maps, the log and WRITE are currently acting on."
                                                    >
                                                        OPEN
                                                    </span>
                                                )}
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
                                                {/* The card's disclosure, at the card's corner.
                                                    ──────────────────────────────────────────────────
                                                    These two floated at the right of the ACTION row
                                                    until the four words moved there. Measured at 375:
                                                    strip 110 + the two buttons 195 + this 28 is 333 in
                                                    a 319px cell — and a float inside a flex row is
                                                    ignored anyway, so it came to rest on a line of its
                                                    own. Here ⓘ holds the corner of the whole card
                                                    instead of one row inside it, which is where a "show
                                                    me the rest of this" control is looked for, and the
                                                    label truncates before it so nothing can push it off.

                                                    Delete travels with it because that is what the ⓘ
                                                    promises: date, log size, flash history — and
                                                    delete. Two nodes for one action, split by
                                                    breakpoint, the same way the four words are. */}
                                                <span className="ml-auto flex items-center shrink-0 min-[1280px]:hidden">
                                                    {/* Delete used to sit here, 24px wide and touching
                                                        this button. Two 24px targets side by side at
                                                        the right edge of a phone means the tap that
                                                        misses DELETE lands on ⓘ — which closes the
                                                        panel that was showing DELETE, so the session
                                                        stays and nothing explains why. It is a row in
                                                        the ACTIONS sheet now, full width, where a
                                                        destructive action belongs anyway.

                                                        `p-3 -m-1.5` grows this one to 36px without
                                                        moving anything: the padding is cancelled by
                                                        the margin, and with DELETE gone there is no
                                                        neighbour for the bigger box to overlap. */}
                                                    <button
                                                        onClick={() => toggleInfo(session.id)}
                                                        aria-expanded={infoOpen}
                                                        className={`p-3 -m-1.5 rounded transition-colors hover:bg-slate-800 ${infoOpen ? 'text-blue-400' : 'text-slate-600 hover:text-slate-400'}`}
                                                        title="Date, log size and flash history"
                                                    >
                                                        <Info className="w-3 h-3" />
                                                    </button>
                                                </span>
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
                                                {/* Replace the bytes this session started from.
                                                    Only while nothing has been DERIVED from them:
                                                    with a stored tune, swapping the BASE would
                                                    leave a record whose tune came from bytes the
                                                    session no longer names. Branch instead —
                                                    Actions -> From BASE. A log survives the swap
                                                    and re-derives, so it does not gate this. */}
                                                {isDraft && session.baseOrigin && !session.sha256 && (
                                                    <span className="group/re relative inline-flex items-center gap-1 cursor-pointer text-[9px] font-bold uppercase tracking-widest text-slate-600 hover:text-blue-400">
                                                        <Upload className="w-2.5 h-2.5" /> Replace BIN
                                                        <DropZone
                                                            label=""
                                                            accept=".bin"
                                                            onFileSelect={file => onUploadBase(session, file)}
                                                            className="!absolute !inset-0 !opacity-0 !border-0 cursor-pointer"
                                                        />
                                                    </span>
                                                )}
                                                {/* The log's way in, on a phone. Same control and
                                                    the same green as the session bar's, which is
                                                    the desk's copy of it - one word, because the
                                                    row is already carrying a name, a badge and an
                                                    origin. */}
                                                {onLoadLogFile && !isArchivedRow && rowCanTakeLog && (
                                                    <span className="group/log relative inline-flex items-center gap-1 cursor-pointer text-[9px] font-bold uppercase tracking-widest text-green-500/80 hover:text-green-400">
                                                        <Upload className="w-2.5 h-2.5" /> Testo CSV
                                                        <DropZone
                                                            label=""
                                                            accept={ACCEPT_CSV}
                                                            onFileSelect={file => onLoadLogFile(session, file)}
                                                            className="!absolute !inset-0 !opacity-0 !border-0 cursor-pointer"
                                                        />
                                                    </span>
                                                )}
                                                {/* And what replaces it once one is loaded — the
                                                    session bar's other half, which is `min-[900px]`
                                                    and so did not exist on a phone. Same three
                                                    pieces in the same order as the bar: the name,
                                                    the count, the bin. Without this the control did
                                                    not "disappear" into a state you could read, it
                                                    disappeared into nothing. */}
                                                {isOpen && loadedLogName && (
                                                    <span className="inline-flex items-center gap-1.5 min-w-0">
                                                        <span className="text-[9px] font-mono text-slate-400 truncate max-w-[140px]" title={loadedLogName}>{loadedLogName}</span>
                                                        {loadedLogPoints !== undefined && (
                                                            <span className="text-[9px] font-mono text-slate-600 shrink-0">{loadedLogPoints}pts</span>
                                                        )}
                                                        {onClearLog && (
                                                            <button
                                                                onClick={onClearLog}
                                                                /* p-1.5, not the bar copy's p-0.5: that renders 14x14 here, against the
                                                                   24px the TESTO CSV and UPLOAD BIN controls beside it measure on a
                                                                   375px phone. 10px icon + 12px padding = 22px, and -my-1 keeps the
                                                                   row the height it was. The desk keeps p-0.5 because a mouse has a
                                                                   pixel and a thumb does not. */
                                                                className="p-1.5 -my-1 text-slate-600 hover:text-red-400 transition-colors shrink-0"
                                                                title="Remove this log"
                                                            >
                                                                <Trash2 className="w-2.5 h-2.5" />
                                                            </button>
                                                        )}
                                                    </span>
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
                                            {/* On a card this cell is only the TUNED download, because
                                                the four words are already on the row above it and
                                                saying them twice is how a reader learns to skip both.
                                                On a desk it IS the column — same component, same
                                                vocabulary, so the two layouts answer "what does this
                                                session have" identically. */}
                                            {/* Only when there is something for it to label. A lone
                                                "Tuned" with nothing after it says less than nothing:
                                                the strip above has already answered whether a tune
                                                exists, and this cell is the download for it. */}
                                            {session.sha256 && (
                                                <span className="text-[8px] uppercase tracking-widest text-slate-700 min-[1280px]:hidden">Tuned</span>
                                            )}
                                            <span className="hidden min-[1280px]:inline-flex">
                                                <Contents session={session} />
                                            </span>
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
                                    <td className="flex w-full order-2 flex-wrap items-center gap-y-1 whitespace-nowrap relative text-left min-[1280px]:table-cell min-[1280px]:w-auto min-[1280px]:px-3 min-[1280px]:py-2 min-[1280px]:text-right">
                                        {/* What this session HAS, on the same line as what you can DO
                                            with it — reading the first is how you choose the second.
                                            Under the name it was a caption on the label instead: a line
                                            you passed on the way down to the buttons.

                                            Measured at 375: the strip is 110px and the two buttons are
                                            195px in a 319px cell, so an ordinary row fits on one line
                                            with 6px to spare. The two things that can push past it are
                                            both rare and both additions to the strip — the ✓ for a tune
                                            that is in the ECU (whose row says Review, which is shorter
                                            than Continue, so it still fits) and a P for practice writes.
                                            `flex-wrap` is what happens then: the buttons drop to their
                                            own line rather than off the right edge. Above 1280 this is
                                            the Actions column again and the strip is hidden — the Has
                                            column already carries it, one column to the left. */}
                                        <span className="mr-2 min-[1280px]:hidden">
                                            <Contents session={session} />
                                        </span>
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
                                        {/* Always on a card, because the sheet now holds the files
                                            and DELETE there whatever else this session can do. On a
                                            desk it appears only when there is a branch or a finalize
                                            to offer — the columns and the trash carry the rest. */}
                                        <div className={(canFromTuned || canFromBase || canFinalize) ? 'contents' : 'contents min-[1280px]:hidden'}>
                                            <button
                                                onClick={() => openMenu(session)}
                                                className="ml-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-indigo-400 transition-colors px-2 py-1 rounded hover:bg-slate-800"
                                                title="This session's files, a branch from its bytes, and delete"
                                            >
                                                <GitBranch className="w-3 h-3" /> Actions ▾
                                            </button>
                                        </div>
                                        {menuFor === session.id && (
                                            <>
                                                {/* Tinted on a card, and closed by pointerDOWN. This scrim used
                                                    to be invisible while the menu itself — an absolute popover
                                                    inside the list's scroll container — was CLIPPED for any row
                                                    near the bottom edge: the screen looked untouched, every
                                                    touch fed a scrim nobody could see, and "scrolling stopped
                                                    working" was the only symptom. The tint says something is
                                                    open; pointerdown means the very swipe that tries to scroll
                                                    closes it first. No backdrop-blur — measured elsewhere in
                                                    this app at ~1 s of paint on the phone for zero content. */}
                                                <div
                                                    className="fixed inset-0 z-40 bg-slate-950/60 min-[1280px]:bg-transparent"
                                                    onPointerDown={() => setMenuFor(null)}
                                                />
                                                {/* A viewport-pinned sheet on a card — the mobile rule: a
                                                    popover that cannot fit beside its trigger is pinned to the
                                                    viewport, not hung off a control narrower than itself, and
                                                    a scroll container cannot clip what it does not contain.
                                                    On a desk it stays the anchored menu it always was. */}
                                                <div className="fixed z-50 inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),280px)] overflow-y-auto bg-slate-900 border border-slate-700 rounded shadow-xl py-1 text-left min-[1280px]:absolute min-[1280px]:inset-x-auto min-[1280px]:bottom-auto min-[1280px]:right-8 min-[1280px]:top-9 min-[1280px]:max-h-none min-[1280px]:overflow-visible">
                                                    {/* The sheet is no longer beside its row, so it has to say
                                                        which session it acts on. Redundant on a desk, where it
                                                        still hangs off the row itself. */}
                                                    <div className="px-3 pt-1.5 pb-1 mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400 border-b border-slate-800 min-[1280px]:hidden">
                                                        {session.label}
                                                    </div>
                                                    {(canFromTuned || canFromBase) && (
                                                        <div className="px-3 pt-1 pb-0.5 text-[8px] font-bold uppercase tracking-widest text-slate-600">
                                                            New session
                                                        </div>
                                                    )}
                                                    {canFromTuned && (
                                                        <button
                                                            onClick={() => { setMenuFor(null); onNewFrom(session, 'tuned'); }}
                                                            className={SHEET_ROW}
                                                        >
                                                            From TUNED <span className="text-slate-600">{st.fromTuned}</span>
                                                        </button>
                                                    )}
                                                    {canFromBase && (
                                                        <button
                                                            onClick={() => { setMenuFor(null); onNewFrom(session, 'base'); }}
                                                            className={SHEET_ROW}
                                                        >
                                                            From BASE <span className="text-slate-600">{st.fromBase}</span>
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
                                                                className={SHEET_ROW}
                                                                title="Loads this tune with PATCH and WOT TH off, ready for the hub to write. Nothing is sent until you press WRITE."
                                                            >
                                                                Finalize <span className="text-slate-600">{st.finalize}</span>
                                                            </button>
                                                        </>
                                                    )}

                                                    {/* The card's copy of the download cells in the
                                                        columns to the right — those are 14px targets
                                                        revealed by hover, so on a phone they are neither
                                                        hittable nor visible. Three rows, in the order a
                                                        session produces them.

                                                        SEND TO STORE is deliberately NOT here. It was,
                                                        for one build, because this was written as "move
                                                        every icon off the row" rather than "which of
                                                        these belongs on a phone at all". The store is a
                                                        development fixture — it exists only in a preview
                                                        build carrying a sync token — and production and
                                                        development are kept apart by not opening extra
                                                        windows onto it (operator, 2026-08-25). It stays
                                                        on the desk's row, which is where development
                                                        happens. */}
                                                    <div className="min-[1280px]:hidden">
                                                        <div className="my-1 border-t border-slate-800" />
                                                        <div className="px-3 pt-1 pb-0.5 text-[8px] font-bold uppercase tracking-widest text-slate-600">
                                                            Files
                                                        </div>
                                                        {session.baseOrigin && (
                                                            <button
                                                                onClick={() => { setMenuFor(null); onDownloadBase(session); }}
                                                                className={SHEET_ROW}
                                                            >
                                                                Download BASE
                                                                {/* What these particular bytes are carrying, read
                                                                    back out of them. Machine state, so it keeps the
                                                                    app's own words in both languages — the same
                                                                    PATCH ON / PATCH OFF the flash history uses.
                                                                    Silent until the read lands: a row that guessed
                                                                    and corrected itself would be worse than one
                                                                    that waits half a frame. */}
                                                                {basePatches && (
                                                                    <span className={`ml-2 ${anyPatch(basePatches) ? 'text-amber-400' : 'text-slate-600'}`}>
                                                                        {anyPatch(basePatches) ? 'PATCH ON' : 'PATCH OFF'}
                                                                    </span>
                                                                )}
                                                            </button>
                                                        )}
                                                        {/* The image between the two, offered only when it is a
                                                            DIFFERENT file from the BASE above: this session put
                                                            patches in the car, and the bytes it started from did
                                                            not have them. With a BASE that was already patched
                                                            the two downloads would be the same bytes under two
                                                            names, which is how a file gets flashed by mistake. */}
                                                        {session.baseOrigin && basePatches && !anyPatch(basePatches)
                                                            && wrotePatchOn && (
                                                            <button
                                                                onClick={() => { setMenuFor(null); onDownloadPatchOn(session); }}
                                                                className={SHEET_ROW}
                                                            >
                                                                Download PATCH-ON
                                                                <span className="ml-2 text-amber-400">
                                                                    {[
                                                                        wrotePatchOn.applyPatch ? 'PATCH' : null,
                                                                        wrotePatchOn.applyWotDisable ? 'WOT TH' : null,
                                                                        wrotePatchOn.applyTankVentDisable ? 'TEV' : null,
                                                                    ].filter(Boolean).join(' · ')}
                                                                </span>
                                                            </button>
                                                        )}
                                                        {session.sha256 && (
                                                            <button
                                                                onClick={() => { setMenuFor(null); onDownloadTuned(session); }}
                                                                className={SHEET_ROW}
                                                            >
                                                                Download TUNED
                                                            </button>
                                                        )}
                                                        {session.hasLog && (
                                                            <button
                                                                onClick={() => { setMenuFor(null); onDownloadLog(session); }}
                                                                className={SHEET_ROW}
                                                            >
                                                                Download LOG CSV
                                                            </button>
                                                        )}
                                                        {!session.baseOrigin && !session.sha256 && !session.hasLog && (
                                                            <p className="px-3 py-1.5 text-[10px] font-mono text-slate-700">
                                                                {st.empty}
                                                            </p>
                                                        )}

                                                        {/* Last, under its own rule, and the only red
                                                            thing in here. */}
                                                        <div className="my-1 border-t border-slate-800" />
                                                        <button
                                                            onClick={() => {
                                                                setMenuFor(null);
                                                                if (confirm(dialogText().deleteSession(session.label))) onDelete(session.id);
                                                            }}
                                                            className={`${SHEET_ROW} !text-red-400`}
                                                        >
                                                            Delete session
                                                        </button>
                                                    </div>
                                                </div>
                                            </>
                                        )}
                                        {/* The desk's delete, and only the desk's: this column has a
                                            whole row to itself there. On a card it travels with the ⓘ
                                            up to the name row — see the note beside them. */}
                                        <button
                                            onClick={() => { if (confirm(dialogText().deleteSession(session.label))) onDelete(session.id); }}
                                            className="hidden ml-1 p-1.5 text-slate-600 hover:text-red-400 transition-colors rounded hover:bg-slate-800 min-[1280px]:inline-block"
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
