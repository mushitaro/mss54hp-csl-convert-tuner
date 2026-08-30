'use client';

import React, { useState } from 'react';
import { CloudUpload, X } from 'lucide-react';
import {
    StoredSession, SyncSettings, canSync, listStoredSessions, restoreSession,
} from '@/lib/session-sync/client';
import { StoredDiagnostic, listStoredDiagnostics } from '@/lib/session-sync/diagnostics';
import { useDialogLang } from '@/hooks/useDialogLang';

const TEXT = {
    ja: {
        title: 'SESSION SYNC',
        intro: '保存は 2 段階です。まず SAVE でこの端末の DB に記録し、次に SYNC で「前回送ってから変わったセッションだけ」をこの配信環境へ送ります。送るのはローカル DB が持っているそのままの形 — セッション記録・ログ・BASE/TUNED の BIN。ローカルは消えず、あとで戻せます。',
        refresh: '取得',
        none: 'まだ 1 件もありません。',
        restore: '取り込む',
        restoreConfirm: (l: string) => `「${l}」をサーバーの内容で上書きします。同じ ID のローカルセッションがあれば置き換わります。よろしいですか？`,
        restored: (l: string) => `「${l}」を取り込みました。`,
        unavailable: 'このビルドは同期トークンを持っていないので、送信先がありません。',
        loading: '取得中…',
        storeTitle: 'サーバー上のセッション',
        cols: { at: '同期', label: '名前', pts: '点数', ch: 'ch', size: 'サイズ' },
        diagTitle: 'リンク診断（READ / WRITE / LOG）',
        diagHint: '読み書きの結果が、成功も失敗もそのまま入ります。失敗した走行こそ価値があるので、エラー文はそのまま保存しています。行をタップすると全文が出ます。',
        diagRefresh: '取得',
        diagNone: 'まだ 1 件もありません。',
        diagCols: { at: '時刻', kind: '種別', n: '交換', dur: '所要', baud: 'baud', rty: '再送', err: '結果' },
        diagOk: 'OK',
    },
    en: {
        title: 'SESSION SYNC',
        intro: 'Saving happens in two steps. SAVE records a tune into this device’s database; SYNC then sends only the sessions that have changed since they were last sent. What goes up is exactly what the local database holds — the session record, its log, and its BASE/TUNED binaries. The local copy stays, and it can be pulled back, so a session recorded on a phone can be finished at a desk.',
        refresh: 'Load',
        none: 'Nothing stored yet.',
        restore: 'Pull',
        restoreConfirm: (l: string) => `Overwrite "${l}" with the stored copy? A local session with the same id is replaced.`,
        restored: (l: string) => `Pulled "${l}".`,
        unavailable: 'This build carries no sync token, so there is no store to talk to.',
        loading: 'Loading…',
        storeTitle: 'Sessions in the store',
        cols: { at: 'Synced', label: 'Label', pts: 'Points', ch: 'ch', size: 'Size' },
        diagTitle: 'Link diagnostics (READ / WRITE / LOG)',
        diagHint: 'Every read and write lands here, successes and failures alike. A failed run is the '
            + 'valuable kind, so the error is kept verbatim. Tap a row for the whole message.',
        diagRefresh: 'Load',
        diagNone: 'Nothing recorded yet.',
        diagCols: { at: 'When', kind: 'Kind', n: 'Exch', dur: 'Time', baud: 'baud', rty: 'Rtry', err: 'Outcome' },
        diagOk: 'OK',
    },
};

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

/** The two list buttons, which are the same control twice: a heading with a LOAD beside it. */
const LOAD_BUTTON = 'shrink-0 min-h-8 px-2 text-[10px] font-bold tracking-wider bg-slate-800 '
    + 'hover:bg-slate-700 text-slate-300 rounded disabled:opacity-40 disabled:cursor-not-allowed';

/**
 * The send, and a view of what is in the store.
 *
 * A popover in the footer like every other panel, rather than a page: the thing it does — send the
 * sessions that have changed — is one button, and the rest is looking at what arrived. Pulling one
 * back is done from here, because that acts on the STORE's list rather than on a local session that
 * may not exist yet.
 *
 * **No destination fields.** This used to carry an API base URL and a token override, and they were
 * asking the wrong person: the store is a development facility, not a feature offered to drivers,
 * and the token is baked into the preview export by `scripts/embed-sync-token.mjs` — generated on a
 * laptop and never shown to anybody, so "enter the token" was an instruction nobody could follow.
 * The destination is therefore always "this deployment", `canSync` is a fact about the build rather
 * than a setting, and a bench rig that genuinely needs another origin edits
 * `localStorage['mss54hp.sessionSync.v1']` — the one place that override still lives.
 *
 * Named SYNC, not STORE. The name covers a two-step flow — SAVE writes locally, SYNC sends the
 * diff — and "Store" described neither half while reading as "upload, now, directly". The menu
 * sheet had always called it SYNC; the footer had not.
 */
export const SessionStorePanel: React.FC<{
    openUp?: boolean;
    /**
     * The device's sync settings, owned by `useSessionSync` and passed down.
     *
     * Read-only here, and passed rather than read from the module, because this panel is rendered
     * TWICE — on the SESSIONS tab and inside the menu sheet. When each instance held its own copy
     * and re-read `localStorage` on mount, the value the uploader actually used was whichever
     * mounted last. There is nothing to edit now, but the single owner stays: two mounts reading
     * one snapshot cannot disagree about which deployment they just listed.
     */
    settings: SyncSettings;
    /** Refreshes the local session list after a pull. */
    onRestored?: () => void;
    /** What the trigger says. Defaults to "Sync", which is what the session list's header wants —
     *  the same shape as NEW SESSION beside it. In the menu sheet it sits directly above a SYNC
     *  button that actually sends, and two rows reading "Sync" would be two rows that look like the
     *  same control, so that instance passes its own. */
    label?: string;
    /** Replaces the trigger's shape, not its tone. The menu sheet gives it the same cell shape the
     *  controls beside it use; a 16px inline button is not a thumb target. */
    triggerClassName?: string;
    /** Overrides the trigger's tone as well as its shape. `canSync` decides it otherwise, which is
     *  right for a door onto a store that may not exist — but once this control IS sync, the tone
     *  has to be sync's. */
    triggerToneClassName?: string;
    /** The icon on the trigger, when the default cloud is not what this door is called. */
    triggerIcon?: React.ReactNode;
    /**
     * The send itself, at the top of the panel.
     *
     * This panel and the SYNC button used to be two controls side by side, and they should not have
     * been: one listed what had arrived, the other put things there. The panel is already titled
     * SESSION SYNC and already explains the two-step flow, so it is the place the send belongs —
     * and merging them frees the cell the second control was taking.
     *
     * A node rather than a handler, because the button's whole state — label, tone, whether it can
     * be pressed — comes from the same `describeSync` the header's twin reads. Building it here
     * would be a second copy of that.
     */
    topAction?: React.ReactNode;
}> = ({
    openUp, settings, onRestored, label = 'Sync', triggerClassName,
    triggerToneClassName, triggerIcon, topAction,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [runs, setRuns] = useState<StoredSession[] | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [diags, setDiags] = useState<StoredDiagnostic[] | null>(null);
    const [diagLoading, setDiagLoading] = useState(false);
    const t = TEXT[useDialogLang()];

    /** Pulls one stored session into the local database, after asking.
     *
     *  Confirmed rather than silent because it overwrites a local session of the same id — and the
     *  id is the same one the phone used, so "restore what I recorded in the car" and "throw away
     *  what I have been doing at the desk" are the same click if nobody asks. */
    const pull = async (row: StoredSession) => {
        if (!confirm(t.restoreConfirm(row.label))) return;
        setBusy(row.id);
        setListError(null);
        try {
            await restoreSession(row.id, settings);
            onRestored?.();
            alert(t.restored(row.label));
        } catch (e) {
            setListError((e as Error).message);
        } finally {
            setBusy(null);
        }
    };

    /**
     * Loads the link diagnostics.
     *
     * Separate button and separate list from the sessions above, deliberately. They answer different
     * questions — "is my work backed up" versus "why did that read die" — and one combined refresh
     * would make the common case pay for the rare one on a phone with two bars of signal.
     *
     * On its own button rather than on open, for the same reason.
     */
    const refreshDiags = async () => {
        setDiagLoading(true);
        setListError(null);
        try {
            setDiags(await listStoredDiagnostics(settings, 25));
        } catch (e) {
            setListError((e as Error).message);
            setDiags(null);
        } finally {
            setDiagLoading(false);
        }
    };

    const refresh = async () => {
        setLoading(true);
        setListError(null);
        try {
            setRuns(await listStoredSessions(settings));
        } catch (e) {
            setListError((e as Error).message);
            setRuns(null);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="relative">
            {/* Named, not just drawn. As a bare cloud in the footer's row of graph controls this
                was reported as "the button I can't identify" — correctly: an icon among icons, in a
                group about charts, opening a dialog about servers. It sits with NEW SESSION now and
                carries a word, which is the whole fix. */}
            <button
                onClick={() => setIsOpen(v => !v)}
                title={t.title}
                className={`${triggerClassName ?? 'inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest'} transition-colors ${triggerToneClassName ?? (canSync(settings)
                    ? 'text-slate-500 hover:text-blue-400'
                    : 'text-slate-700 hover:text-slate-500')}`}
            >
                {triggerIcon ?? <CloudUpload className="w-3 h-3 shrink-0" />} {label}
            </button>

            {/* The same two shapes FilterConfigPanel and FieldVisibilityPanel use, rather than a
                third one of this panel's own.

                On a phone it is a fixed bottom sheet, not a popover anchored to its trigger — and
                that is the part that matters. An anchored panel capped at a fraction of the
                viewport still hangs off the bottom whenever its anchor sits low: measured here at
                851x393, a landscape phone, the SAVE row landed 3px below the fold, and capping the
                height moved it to 10px below. Only detaching from the anchor fixes it.
                svh, never vh: vh grows when the address bar retracts, so a panel sized to it loses
                its own bottom the moment the bar comes back.

                So the sheet is the BASE shape and the anchored popover is the wide-layout override,
                not the other way round. The trigger moved to the session list's header, between
                SESSIONS and NEW SESSION, and a `right-0` popover anchored there measured x=-76 at
                375px: 320px of panel hung off the left edge, and `max-w` cannot fix that because it
                caps the width without moving the box. That instance is `min-[900px]` only now, so
                the base shape is a floor rather than something in use — kept because anchoring to a
                trigger is safe only while the trigger is near an edge, and that is not a property
                this component can know about wherever it is next put.

                `openUp` now means one thing only: this is rendered inside the menu sheet's
                SESSION band. Two consequences, and both are about that parent rather than about
                the panel. `z-[100]` because the sheet is `z-[95]` and its scrim `z-[90]`, so the
                default 50 would put this behind the thing that opened it. `touch-auto` because the
                sheet carries `touch-none` to stop the browser claiming the opening drag as a
                scroll — and touch-action is resolved up the DOM chain even for a fixed element, so
                without this the panel's own list could not be scrolled by finger. */}
            {isOpen && (
                <div className={`fixed inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),460px)] ${openUp
                    ? 'z-[100] touch-auto'
                    : 'z-50 min-[900px]:absolute min-[900px]:left-auto min-[900px]:right-0 '
                    + 'min-[900px]:bottom-auto min-[900px]:top-10 min-[900px]:w-80 '
                    + 'min-[900px]:max-w-[calc(100vw-2rem)] min-[900px]:max-h-[min(70dvh,460px)]'
                    } flex flex-col overscroll-contain bg-slate-900 border border-slate-700 rounded-lg shadow-xl`}>
                    <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 shrink-0">
                        <span className="text-[10px] font-bold tracking-wider text-slate-400">{t.title}</span>
                        <button onClick={() => setIsOpen(false)} className="p-1 text-slate-600 hover:text-slate-300">
                            <X className="w-3 h-3" />
                        </button>
                    </div>

                    <div className="p-3 space-y-3 overflow-y-auto overscroll-contain">
                        {/* First, above the explanation of it. Everything below this line is setup
                            done once per device; this is the thing done after every run. */}
                        {topAction}
                        <p className="text-[9px] text-slate-600">{t.intro}</p>

                        {/* Not "enter a token to enable SYNC" — nobody can. A build either shipped
                            with one or it did not, so this states the fact rather than asking. */}
                        {!canSync(settings) && <p className="text-[9px] text-amber-500/80">{t.unavailable}</p>}
                        {listError && <p className="text-[9px] text-red-400 break-words">{listError}</p>}

                        {/* The two lists below are the same shape on purpose: a heading, a LOAD
                            beside it, and nothing fetched until it is pressed. They used to differ
                            only because this one inherited the settings form's full-width row. */}
                        <div className="pt-2 border-t border-slate-800 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-slate-500 uppercase tracking-wider">{t.storeTitle}</span>
                                <button
                                    onClick={refresh}
                                    disabled={!canSync(settings) || loading}
                                    className={LOAD_BUTTON}
                                >
                                    {loading ? t.loading : t.refresh}
                                </button>
                            </div>

                            {runs && (runs.length === 0
                                ? <p className="text-[9px] text-slate-600">{t.none}</p>
                                : (
                                    <table className="w-full text-[9px] font-mono">
                                        <thead className="text-slate-600">
                                            <tr className="text-left">
                                                <th className="py-1 font-normal">{t.cols.at}</th>
                                                <th className="py-1 font-normal">{t.cols.label}</th>
                                                <th className="py-1 font-normal text-right">{t.cols.pts}</th>
                                                <th className="py-1 font-normal text-center">{t.cols.ch}</th>
                                                <th className="py-1 font-normal text-right">{t.cols.size}</th>
                                                <th className="py-1 font-normal" />
                                            </tr>
                                        </thead>
                                        <tbody className="text-slate-400">
                                            {runs.map(r => (
                                                <tr key={r.id} className="border-t border-slate-800">
                                                    <td className="py-1 text-slate-500 whitespace-nowrap">
                                                        {new Date(r.synced_at).toLocaleString(undefined,
                                                            { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                                    </td>
                                                    <td className="py-1 truncate max-w-[6rem]" title={r.label}>{r.label}</td>
                                                    <td className="py-1 text-right">{r.point_count.toLocaleString()}</td>
                                                    {/* The two channels the EGT work depends on, plus whether
                                                        a tune came with it. These are the first questions
                                                        asked of any stored session, so they are columns
                                                        rather than something to pull it back to discover. */}
                                                    <td className="py-1 text-center whitespace-nowrap">
                                                        <span className={r.has_rf ? 'text-blue-300' : 'text-slate-700'}>RF</span>
                                                        {' '}
                                                        <span className={r.has_egt ? 'text-red-300' : 'text-slate-700'}>EGT</span>
                                                        {' '}
                                                        <span className={r.has_tune ? 'text-emerald-300' : 'text-slate-700'}>T</span>
                                                    </td>
                                                    <td className="py-1 text-right text-slate-500">
                                                        {kb((r.session_bytes ?? 0) + (r.log_bytes ?? 0) + (r.binaries_bytes ?? 0))}
                                                    </td>
                                                    <td className="py-1 pl-2 text-right">
                                                        {/* The payoff. Without this the store is a
                                                            write-only hole and a CSV download would have
                                                            been simpler. */}
                                                        <button
                                                            onClick={() => void pull(r)}
                                                            disabled={busy !== null}
                                                            className="text-blue-400 hover:text-blue-300 disabled:text-slate-700 disabled:cursor-wait"
                                                        >
                                                            {busy === r.id ? '…' : t.restore}
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ))}
                        </div>

                        {/* Link diagnostics.
                            This is the half that was missing. Read and write results have been
                            uploading themselves since the feature shipped — three failed 38400 reads
                            among them — and there was no way to look at any of it without a laptop
                            and `npm run db:diagnostics`. From the car, the data went up and vanished.
                            A store you cannot read from is a write-only hole. */}
                        <div className="pt-2 border-t border-slate-800 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-slate-500 uppercase tracking-wider">{t.diagTitle}</span>
                                <button
                                    onClick={refreshDiags}
                                    disabled={!canSync(settings) || diagLoading}
                                    className={LOAD_BUTTON}
                                >
                                    {diagLoading ? t.loading : t.diagRefresh}
                                </button>
                            </div>
                            <p className="text-[9px] text-slate-600">{t.diagHint}</p>

                            {diags && (diags.length === 0
                                ? <p className="text-[9px] text-slate-600">{t.diagNone}</p>
                                : (
                                    <table className="w-full text-[9px] font-mono">
                                        <thead className="text-slate-600">
                                            <tr className="text-left">
                                                <th className="py-1 font-normal">{t.diagCols.at}</th>
                                                <th className="py-1 font-normal">{t.diagCols.kind}</th>
                                                <th className="py-1 font-normal text-right">{t.diagCols.n}</th>
                                                <th className="py-1 font-normal text-right">{t.diagCols.dur}</th>
                                                <th className="py-1 font-normal text-right">{t.diagCols.baud}</th>
                                                <th className="py-1 font-normal text-right">{t.diagCols.rty}</th>
                                                <th className="py-1 font-normal">{t.diagCols.err}</th>
                                            </tr>
                                        </thead>
                                        <tbody className="text-slate-400">
                                            {diags.map(d => (
                                                <tr key={d.id} className="border-t border-slate-800 align-top">
                                                    <td className="py-1 text-slate-500 whitespace-nowrap">
                                                        {new Date(d.created_at).toLocaleString(undefined,
                                                            { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                                    </td>
                                                    <td className="py-1 uppercase">
                                                        {d.kind}{d.mock ? <span className="text-slate-700"> mock</span> : null}
                                                    </td>
                                                    <td className="py-1 text-right">{d.exchanges.toLocaleString()}</td>
                                                    <td className="py-1 text-right whitespace-nowrap">{(d.elapsed_ms / 1000).toFixed(0)}s</td>
                                                    {/* Asked-for beside ran-at, because a refused switch silently
                                                        falls back and without both every attempt reads as "9600". */}
                                                    <td className="py-1 text-right whitespace-nowrap">
                                                        {d.requested_baud !== null && d.requested_baud !== d.baud
                                                            ? <span className="text-amber-500/80">{d.requested_baud}&rarr;{d.baud}</span>
                                                            : (d.baud ?? '-')}
                                                    </td>
                                                    {/* The number that says whether a fast rate was
                                                        actually fast. One retried chunk carries
                                                        300-1600ms of deliberate settle against a
                                                        ~94ms exchange, so a boosted read can finish
                                                        in 9600's time with nothing else looking
                                                        wrong. Null on rows written before this
                                                        column existed — not zero, which would claim
                                                        a clean run nobody measured. */}
                                                    <td className={`py-1 text-right ${(d.retries ?? 0) > 0 ? 'text-amber-500/80' : 'text-slate-600'}`}>
                                                        {d.retries ?? '-'}
                                                    </td>
                                                    {/* The message in full on tap/hover. Truncating it in the cell and
                                                        nowhere else would hide the latched transport-error name, which
                                                        is the part that separates a receive overrun from a physical
                                                        fault from a DME that simply stopped answering. */}
                                                    <td className="py-1 pl-2 break-words" title={d.error ?? t.diagOk}>
                                                        {d.completed
                                                            ? <span className="text-emerald-300">{t.diagOk}</span>
                                                            : <span className="text-red-400">{d.error ?? 'FAILED'}</span>}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
