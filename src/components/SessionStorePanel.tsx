'use client';

import React, { useEffect, useState } from 'react';
import { CloudUpload, X } from 'lucide-react';
import {
    EMPTY_SETTINGS, StoredSession, SyncSettings, canSync, hasBakedToken, isBakedToken,
    listStoredSessions, loadSyncSettings, restoreSession, saveSyncSettings,
} from '@/lib/session-sync/client';
import { StoredDiagnostic, listStoredDiagnostics } from '@/lib/session-sync/diagnostics';
import { useDialogLang } from '@/hooks/useDialogLang';

const TEXT = {
    ja: {
        title: 'SESSION SYNC',
        intro: '保存は 2 段階です。まず SAVE でこの端末の DB に記録し、次に SYNC で「前回送ってから変わったセッションだけ」をこの配信環境へ送ります。送るのはローカル DB が持っているそのままの形 — セッション記録・ログ・BASE/TUNED の BIN。ローカルは消えません。戻すこともできるので、スマホで取って PC で仕上げる、が可能です。',
        base: 'API のベース URL',
        baseHint: '空欄ならこのページと同じオリジン。デプロイ済みのアプリから使うときは空でかまいません。ポートを分けたローカル検証のときだけ入れます。',
        token: '同期トークン（上書き）',
        tokenHint: 'この端末にだけ保存され、送信先は API のみです。値は `wrangler pages secret put UPLOAD_TOKEN` で設定したもの。',
        baked: 'このビルドがトークンを持っているので、入力は不要です。別のデプロイ先を見るときだけ、ここで上書きします。',
        save: '保存',
        saved: '保存しました',
        refresh: '一覧を取得',
        none: 'まだ 1 件もありません。',
        restore: '取り込む',
        restoreConfirm: (l: string) => `「${l}」をサーバーの内容で上書きします。同じ ID のローカルセッションがあれば置き換わります。よろしいですか？`,
        restored: (l: string) => `「${l}」を取り込みました。`,
        needToken: 'トークンを入れると、SYNC が使えるようになります（セッション一覧の各行にも同期ボタンが出ます）。',
        loading: '取得中…',
        cols: { at: '同期', label: '名前', pts: '点数', ch: 'ch', size: 'サイズ' },
        diagTitle: 'リンク診断（READ / WRITE / LOG）',
        diagHint: '読み書きの結果が、成功も失敗もそのまま入ります。失敗した走行こそ価値があるので、エラー文はそのまま保存しています。行をタップすると全文が出ます。',
        diagRefresh: '診断を取得',
        diagNone: 'まだ 1 件もありません。',
        diagCols: { at: '時刻', kind: '種別', n: '交換', baud: 'baud', err: '結果' },
        diagOk: 'OK',
    },
    en: {
        title: 'SESSION SYNC',
        intro: 'Saving happens in two steps. SAVE records a tune into this device’s database; SYNC then sends only the sessions that have changed since they were last sent. What goes up is exactly what the local database holds — the session record, its log, and its BASE/TUNED binaries. The local copy stays, and it can be pulled back, so a session recorded on a phone can be finished at a desk.',
        base: 'API base URL',
        baseHint: 'Empty means the same origin as this page, which is what the deployed app wants. Only needed for a local rig where the app and the functions are on different ports.',
        token: 'Sync token (override)',
        tokenHint: 'Kept on this device and sent only to the API. The value is whatever `wrangler pages secret put UPLOAD_TOKEN` was given.',
        baked: 'This build carries a token, so nothing needs typing. Only fill this in to point at a different deployment.',
        save: 'Save',
        saved: 'Saved',
        refresh: 'Refresh list',
        none: 'Nothing stored yet.',
        restore: 'Pull',
        restoreConfirm: (l: string) => `Overwrite "${l}" with the stored copy? A local session with the same id is replaced.`,
        restored: (l: string) => `Pulled "${l}".`,
        needToken: 'Enter a token to enable SYNC. A sync button also appears on every session row.',
        loading: 'Loading…',
        cols: { at: 'Synced', label: 'Label', pts: 'Points', ch: 'ch', size: 'Size' },
        diagTitle: 'Link diagnostics (READ / WRITE / LOG)',
        diagHint: 'Every read and write lands here, successes and failures alike. A failed run is the '
            + 'valuable kind, so the error is kept verbatim. Tap a row for the whole message.',
        diagRefresh: 'Load diagnostics',
        diagNone: 'Nothing recorded yet.',
        diagCols: { at: 'When', kind: 'Kind', n: 'Exch', baud: 'baud', err: 'Outcome' },
        diagOk: 'OK',
    },
};

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

/**
 * Configuration for the session store, and a view of what is in it.
 *
 * A popover in the footer like every other panel, rather than a page: this is set once per device
 * and then not thought about again, and the thing it configures — the sync button on each session
 * row — is where the actual work happens. Pulling one back is done from here, because that acts on
 * the STORE's list rather than on a local session that may not exist yet.
 *
 * Named SYNC, not STORE. The control is the configuration door for a two-step flow — SAVE writes
 * locally, SYNC sends the diff — and "Store" described neither half while reading as "upload, now,
 * directly". The menu sheet had always called it SYNC; the footer had not.
 */
export const SessionStorePanel: React.FC<{
    openUp?: boolean;
    onSettingsChange: (settings: SyncSettings) => void;
    /** Refreshes the local session list after a pull. */
    onRestored?: () => void;
}> = ({ openUp, onSettingsChange, onRestored }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [settings, setSettings] = useState<SyncSettings>(EMPTY_SETTINGS);
    const [savedFlash, setSavedFlash] = useState(false);
    const [runs, setRuns] = useState<StoredSession[] | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [diags, setDiags] = useState<StoredDiagnostic[] | null>(null);
    const [diagLoading, setDiagLoading] = useState(false);
    const t = TEXT[useDialogLang()];

    // localStorage is not available during the static prerender, so the real value can only be
    // read after mount. Seeding state with it directly would bake an empty form into the export.
    useEffect(() => {
        const loaded = loadSyncSettings();
        setSettings(loaded);
        onSettingsChange(loaded);
        // Deliberately once. `onSettingsChange` is a fresh closure every render, and depending on
        // it would re-publish the settings on every parent render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const save = () => {
        saveSyncSettings(settings);
        onSettingsChange(settings);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
    };

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
                className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors ${canSync(settings)
                    ? 'text-slate-500 hover:text-blue-400'
                    : 'text-slate-700 hover:text-slate-500'}`}
            >
                <CloudUpload className="w-3 h-3" /> Sync
            </button>

            {/* The same two shapes FilterConfigPanel and FieldVisibilityPanel use, rather than a
                third one of this panel's own.

                On a phone it is a fixed bottom sheet, not a popover anchored to its trigger — and
                that is the part that matters. An anchored panel capped at a fraction of the
                viewport still hangs off the bottom whenever its anchor sits low: measured here at
                851x393, a landscape phone, the SAVE row landed 3px below the fold, and capping the
                height moved it to 10px below. Only detaching from the anchor fixes it.
                svh, never vh: vh grows when the address bar retracts, so a panel sized to it loses
                its own bottom the moment the bar comes back. */}
            {isOpen && (
                <div className={`${openUp
                    ? 'fixed inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),460px)]'
                    : 'absolute right-0 top-10 w-80 max-w-[calc(100vw-2rem)] max-h-[min(70dvh,460px)]'
                    } flex flex-col overscroll-contain bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50`}>
                    <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 shrink-0">
                        <span className="text-[10px] font-bold tracking-wider text-slate-400">{t.title}</span>
                        <button onClick={() => setIsOpen(false)} className="p-1 text-slate-600 hover:text-slate-300">
                            <X className="w-3 h-3" />
                        </button>
                    </div>

                    <div className="p-3 space-y-3 overflow-y-auto overscroll-contain">
                        <p className="text-[9px] text-slate-600">{t.intro}</p>

                        <label className="block space-y-1">
                            <span className="text-[10px] text-slate-500 uppercase tracking-wider">{t.base}</span>
                            <input
                                type="url"
                                inputMode="url"
                                autoComplete="off"
                                placeholder="(same origin)"
                                value={settings.baseUrl}
                                onChange={e => setSettings(s => ({ ...s, baseUrl: e.target.value }))}
                                className="w-full min-h-10 bg-slate-800 border border-slate-700 rounded px-2 text-xs font-mono text-slate-200"
                            />
                            <span className="block text-[9px] text-slate-600">{t.baseHint}</span>
                        </label>

                        {/* An override now, not a gate. The build ships the token (see
                            scripts/embed-sync-token.mjs), so the ordinary path types nothing —
                            which is the point: the value was generated on a laptop and never shown
                            to anybody, so "enter the token" was an instruction nobody could follow.

                            Deliberately not pre-filled with the baked value. Showing it would put
                            the secret on screen for no gain, and saving it back would pin this
                            device to today's token — a rotation would then never reach it. Empty
                            means "use whatever this build carries", which is what should happen. */}
                        <label className="block space-y-1">
                            <span className="text-[10px] text-slate-500 uppercase tracking-wider">{t.token}</span>
                            <input
                                type="password"
                                autoComplete="off"
                                placeholder={hasBakedToken() ? '(from this build)' : ''}
                                value={isBakedToken(settings.token) ? '' : settings.token}
                                onChange={e => setSettings(s => ({ ...s, token: e.target.value }))}
                                className="w-full min-h-10 bg-slate-800 border border-slate-700 rounded px-2 text-xs font-mono text-slate-200"
                            />
                            <span className="block text-[9px] text-slate-600">
                                {hasBakedToken() ? t.baked : t.tokenHint}
                            </span>
                        </label>

                        <div className="flex gap-2">
                            <button
                                onClick={save}
                                className="flex-1 min-h-10 text-[10px] font-bold tracking-wider bg-blue-600 hover:bg-blue-500 text-white rounded"
                            >
                                {savedFlash ? t.saved : t.save}
                            </button>
                            <button
                                onClick={refresh}
                                disabled={!canSync(settings) || loading}
                                className="flex-1 min-h-10 text-[10px] font-bold tracking-wider bg-slate-800 hover:bg-slate-700 text-slate-300 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {loading ? t.loading : t.refresh}
                            </button>
                        </div>

                        {!canSync(settings) && <p className="text-[9px] text-amber-500/80">{t.needToken}</p>}
                        {listError && <p className="text-[9px] text-red-400 break-words">{listError}</p>}

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
                                    className="shrink-0 min-h-8 px-2 text-[10px] font-bold tracking-wider bg-slate-800 hover:bg-slate-700 text-slate-300 rounded disabled:opacity-40 disabled:cursor-not-allowed"
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
                                                <th className="py-1 font-normal text-right">{t.diagCols.baud}</th>
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
                                                    {/* Asked-for beside ran-at, because a refused switch silently
                                                        falls back and without both every attempt reads as "9600". */}
                                                    <td className="py-1 text-right whitespace-nowrap">
                                                        {d.requested_baud !== null && d.requested_baud !== d.baud
                                                            ? <span className="text-amber-500/80">{d.requested_baud}&rarr;{d.baud}</span>
                                                            : (d.baud ?? '-')}
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
