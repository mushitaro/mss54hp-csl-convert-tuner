'use client';

import React, { useEffect, useState } from 'react';
import { CloudUpload, X } from 'lucide-react';
import {
    EMPTY_SETTINGS, StoredRun, UploadSettings, canUpload, listRuns,
    loadUploadSettings, saveUploadSettings,
} from '@/lib/run-upload/client';
import { useDialogLang } from '@/hooks/useDialogLang';

const TEXT = {
    ja: {
        title: 'RUN STORE',
        intro: '実機で取ったログを、この配信環境の保管庫に送ります。ローカルの保存は消えません — 保管庫は控えであって、正本ではありません。',
        base: 'API のベース URL',
        baseHint: '空欄ならこのページと同じオリジン。デプロイ済みのアプリから使うときは空でかまいません。ポートを分けたローカル検証のときだけ入れます。',
        token: 'アップロードトークン',
        tokenHint: 'この端末にだけ保存され、送信先は API のみです。値は `wrangler pages secret put UPLOAD_TOKEN` で設定したもの。',
        save: '保存',
        saved: '保存しました',
        refresh: '一覧を取得',
        none: 'まだ 1 件もありません。',
        needToken: 'トークンを入れると、セッション一覧の各行にアップロードボタンが出ます。',
        loading: '取得中…',
        cols: { at: '日時', label: '名前', pts: '点数', ch: 'ch', size: 'サイズ' },
    },
    en: {
        title: 'RUN STORE',
        intro: 'Sends a log recorded on the car to this deployment\'s store. The local copy is not removed — the store is a second copy, not the original.',
        base: 'API base URL',
        baseHint: 'Empty means the same origin as this page, which is what the deployed app wants. Only needed for a local rig where the app and the functions are on different ports.',
        token: 'Upload token',
        tokenHint: 'Kept on this device and sent only to the API. The value is whatever `wrangler pages secret put UPLOAD_TOKEN` was given.',
        save: 'Save',
        saved: 'Saved',
        refresh: 'Refresh list',
        none: 'Nothing stored yet.',
        needToken: 'Enter a token and an upload button appears on every session row.',
        loading: 'Loading…',
        cols: { at: 'When', label: 'Label', pts: 'Points', ch: 'ch', size: 'Size' },
    },
};

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

/**
 * Configuration for the run store, and a view of what is in it.
 *
 * A popover in the footer like every other panel, rather than a page: this is set once per device
 * and then not thought about again, and the thing it configures — the upload button on each session
 * row — is where the actual work happens.
 */
export const RunStorePanel: React.FC<{
    openUp?: boolean;
    onSettingsChange: (settings: UploadSettings) => void;
}> = ({ openUp, onSettingsChange }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [settings, setSettings] = useState<UploadSettings>(EMPTY_SETTINGS);
    const [savedFlash, setSavedFlash] = useState(false);
    const [runs, setRuns] = useState<StoredRun[] | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const t = TEXT[useDialogLang()];

    // localStorage is not available during the static prerender, so the real value can only be
    // read after mount. Seeding state with it directly would bake an empty form into the export.
    useEffect(() => {
        const loaded = loadUploadSettings();
        setSettings(loaded);
        onSettingsChange(loaded);
        // Deliberately once. `onSettingsChange` is a fresh closure every render, and depending on
        // it would re-publish the settings on every parent render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const save = () => {
        saveUploadSettings(settings);
        onSettingsChange(settings);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
    };

    const refresh = async () => {
        setLoading(true);
        setListError(null);
        try {
            setRuns(await listRuns(settings));
        } catch (e) {
            setListError((e as Error).message);
            setRuns(null);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(v => !v)}
                title={t.title}
                className={`p-2 rounded transition-colors ${canUpload(settings)
                    ? 'text-slate-400 hover:text-blue-400 hover:bg-slate-800'
                    : 'text-slate-700 hover:text-slate-500 hover:bg-slate-800'}`}
            >
                <CloudUpload className="w-4 h-4" />
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

                        <label className="block space-y-1">
                            <span className="text-[10px] text-slate-500 uppercase tracking-wider">{t.token}</span>
                            <input
                                type="password"
                                autoComplete="off"
                                value={settings.token}
                                onChange={e => setSettings(s => ({ ...s, token: e.target.value }))}
                                className="w-full min-h-10 bg-slate-800 border border-slate-700 rounded px-2 text-xs font-mono text-slate-200"
                            />
                            <span className="block text-[9px] text-slate-600">{t.tokenHint}</span>
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
                                disabled={!canUpload(settings) || loading}
                                className="flex-1 min-h-10 text-[10px] font-bold tracking-wider bg-slate-800 hover:bg-slate-700 text-slate-300 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {loading ? t.loading : t.refresh}
                            </button>
                        </div>

                        {!canUpload(settings) && <p className="text-[9px] text-amber-500/80">{t.needToken}</p>}
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
                                        </tr>
                                    </thead>
                                    <tbody className="text-slate-400">
                                        {runs.map(r => (
                                            <tr key={r.id} className="border-t border-slate-800">
                                                <td className="py-1 text-slate-500 whitespace-nowrap">
                                                    {new Date(r.created_at).toLocaleString(undefined,
                                                        { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                                </td>
                                                <td className="py-1 truncate max-w-[7rem]" title={r.label}>{r.label}</td>
                                                <td className="py-1 text-right">{r.point_count.toLocaleString()}</td>
                                                {/* The two channels the EGT work depends on. First
                                                    question asked of any stored run, so it is a column
                                                    rather than something to open the run to discover. */}
                                                <td className="py-1 text-center">
                                                    <span className={r.has_rf ? 'text-blue-300' : 'text-slate-700'}>RF</span>
                                                    {' '}
                                                    <span className={r.has_egt ? 'text-red-300' : 'text-slate-700'}>EGT</span>
                                                </td>
                                                <td className="py-1 text-right text-slate-500">{kb(r.gz_bytes)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            ))}
                    </div>
                </div>
            )}
        </div>
    );
};
