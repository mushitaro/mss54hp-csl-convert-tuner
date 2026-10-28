'use client';

import React from 'react';
import { useDialogLang } from '@/hooks/useDialogLang';
import type { BridgeStatus } from '@/lib/bridge/bridgeClient';

/**
 * ASSISTANT, inside the SYNC panel: what the connection is doing, and what goes with it — this
 * device's name and "switch here". Not the switch: that is AI in the header, right of the build
 * badge, the same in every M app (operator, 2026-10-28) — one door to one control, and the one part
 * of the header the head unit always shows. Built once by the page and mounted twice (session list,
 * menu sheet), so the two can never disagree. The state line says what is true now — live, trying
 * again and why, or stopped and what to do — because on a head unit the network comes and goes with
 * the car, and "it says ON" is not the same fact as "the assistant can hear this tab".
 */
const TEXT = {
    ja: {
        title: 'ASSISTANT',
        intro: 'オンにすると、あなたが接続した AI アシスタント（claude.ai など）が、このタブの状態と記録済みのデータログを読み、ログの開始・停止、表示の切り替え、セッションの作成・切り替え・保存、キャリブレーションの変更、クラウドとの同期、観察（OBSERVE）の計画と印付け、前に選んだケーブルへのつなぎ直しと切断、MONITORING への切り替えを行えるようになります。車への書き込み・フラッシュと、新しいケーブルを選ぶことはできません。',
        where: 'オンとオフは、画面上の WORKS の右にある AI で切り替えます。',
        state: {
            off: 'オフ', connecting: '接続中…', live: '接続済み — アシスタントからこのタブに届きます',
            retrying: '再接続待ち', held: '別の端末がつながっています', stopped: '停止',
        } as Record<BridgeStatus['state'], string>,
        held: (holder: string | null | undefined) => holder
            ? `「${holder}」がアシスタントにつながっています。あちらが眠ると、ここが引き継ぎます。`
            : '別の端末がアシスタントにつながっています。あちらが眠ると、ここが引き継ぎます。',
        takeover: 'こちらに切り替える',
        device: 'この端末の名前',
        devicePlaceholder: '例：ナビ',
        deviceHelp: 'アシスタントは、どの端末が答えているかをこの名前で言います。',
        calls: (n: number) => `応答 ${n} 件`,
        setup: 'アシスタント側では、コネクタ（リモート MCP）の追加が必要です。',
    },
    en: {
        title: 'ASSISTANT',
        intro: 'When on, the AI assistant you connected (claude.ai and others) can read this tab\'s state and the data log it has recorded, start and stop a log, change the view, start, switch and save sessions, change calibration values, sync with your cloud, set an observation (OBSERVE) plan and marks, reconnect the cable chosen here before and release it, and switch to MONITORING. It cannot write to or flash the car, or choose a new cable.',
        where: 'Switch it on and off with AI at the top, right of WORKS.',
        state: {
            off: 'Off', connecting: 'Connecting…', live: 'Connected — your assistant can reach this tab',
            retrying: 'Waiting to reconnect', held: 'Another device is connected', stopped: 'Stopped',
        } as Record<BridgeStatus['state'], string>,
        held: (holder: string | null | undefined) => holder
            ? `"${holder}" has the assistant. This device takes over when that one sleeps.`
            : 'Another device has the assistant. This device takes over when that one sleeps.',
        takeover: 'Switch here',
        device: 'This device\'s name',
        devicePlaceholder: 'e.g. Head unit',
        deviceHelp: 'Your assistant says which device is answering by this name.',
        calls: (n: number) => `${n} answered`,
        setup: 'On the assistant\'s side, add the connector (remote MCP) once.',
    },
};

export const AssistantSection: React.FC<{
    on: boolean;
    status: BridgeStatus;
    /** "Switch here": take the assistant from the device that has it. */
    onTakeover: () => void;
    device: string | null;
    onDevice: (name: string) => void;
}> = ({ on, status, onTakeover, device, onDevice }) => {
    const t = TEXT[useDialogLang()];
    const tone = status.state === 'live' ? 'text-sky-300'
        : status.state === 'stopped' || status.state === 'held' ? 'text-amber-500/80'
            : status.state === 'off' ? 'text-slate-500' : 'text-slate-400';
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold tracking-wider text-slate-400">{t.title}</span>
                <span className={`text-[10px] font-bold tracking-widest ${on ? 'text-sky-300' : 'text-slate-500'}`}>{t.state[on ? status.state : 'off']}</span>
            </div>
            <p className="text-[9px] text-slate-500">{t.where}</p>
            {on && (
                <p className={`text-[10px] ${tone}`}>
                    {t.state[status.state]}
                    {status.calls > 0 && <span className="text-slate-500"> · {t.calls(status.calls)}</span>}
                    {status.state === 'held'
                        ? <span className="block text-[9px] text-slate-500 mt-0.5">{t.held(status.holder)}</span>
                        : status.detail && <span className="block text-[9px] text-slate-500 mt-0.5">{status.detail}</span>}
                </p>
            )}
            {on && status.state === 'held' && (
                <button
                    type="button"
                    onClick={onTakeover}
                    className="min-h-8 px-3 rounded border border-sky-500/50 text-sky-300 text-[10px] font-bold tracking-widest hover:bg-sky-500/10"
                >
                    {t.takeover}
                </button>
            )}
            {on && (
                <label className="block space-y-1">
                    <span className="text-[9px] text-slate-500">{t.device}</span>
                    <input
                        type="text"
                        maxLength={24}
                        defaultValue={device ?? ''}
                        placeholder={t.devicePlaceholder}
                        onBlur={e => onDevice(e.currentTarget.value)}
                        className="w-full min-h-8 px-2 rounded bg-slate-900 border border-slate-700 text-[11px] text-slate-200 placeholder:text-slate-600"
                    />
                    <span className="block text-[9px] text-slate-600">{t.deviceHelp}</span>
                </label>
            )}
            <p className="text-[9px] text-slate-600">{t.intro}</p>
            <p className="text-[9px] text-slate-600">{t.setup}</p>
        </div>
    );
};
