'use client';

import React from 'react';
import { useDialogLang } from '@/hooks/useDialogLang';
import type { BridgeStatus } from '@/lib/bridge/bridgeClient';

/**
 * ASSISTANT, inside the SYNC panel: the switch that lets the owner's assistant reach this tab, and
 * what the connection is doing.
 *
 * One switch, two words. The panel is mounted twice (session list, menu sheet) and this is built
 * once by the page, so the two can never disagree. The state line says what is true now — live,
 * trying again and why, or stopped and what to do — because on a head unit the network comes and
 * goes with the car, and "it says ON" is not the same fact as "the assistant can hear this tab".
 */
const TEXT = {
    ja: {
        title: 'ASSISTANT',
        intro: 'オンにすると、あなたが接続した AI アシスタント（claude.ai など）が、このタブの状態と記録済みのデータログを読み、ログの開始・停止と表示の切り替えを行えるようになります。車への接続・書き込み・フラッシュはできません。',
        on: 'オン', off: 'オフ',
        state: {
            off: 'オフ', connecting: '接続中…', live: '接続済み — アシスタントからこのタブに届きます',
            retrying: '再接続待ち', stopped: '停止',
        } as Record<BridgeStatus['state'], string>,
        calls: (n: number) => `応答 ${n} 件`,
        setup: 'アシスタント側では、コネクタ（リモート MCP）の追加が必要です。',
    },
    en: {
        title: 'ASSISTANT',
        intro: 'When on, the AI assistant you connected (claude.ai and others) can read this tab\'s state and the data log it has recorded, start and stop a log, and change the view. It cannot connect to, write to or flash the car.',
        on: 'ON', off: 'OFF',
        state: {
            off: 'Off', connecting: 'Connecting…', live: 'Connected — your assistant can reach this tab',
            retrying: 'Waiting to reconnect', stopped: 'Stopped',
        } as Record<BridgeStatus['state'], string>,
        calls: (n: number) => `${n} answered`,
        setup: 'On the assistant\'s side, add the connector (remote MCP) once.',
    },
};

export const AssistantSection: React.FC<{
    on: boolean;
    status: BridgeStatus;
    /** Switching on asks first (the page owns that dialog); switching off does not. */
    onToggle: (next: boolean) => void;
}> = ({ on, status, onToggle }) => {
    const t = TEXT[useDialogLang()];
    const tone = status.state === 'live' ? 'text-sky-300'
        : status.state === 'stopped' ? 'text-amber-500/80'
            : status.state === 'off' ? 'text-slate-500' : 'text-slate-400';
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold tracking-wider text-slate-400">{t.title}</span>
                <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    onClick={() => onToggle(!on)}
                    className={`min-h-8 min-w-14 px-3 rounded border text-[10px] font-bold tracking-widest transition-colors ${on
                        ? 'border-sky-500/50 text-sky-300 bg-sky-500/10 hover:bg-sky-500/20'
                        : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}
                >
                    {on ? t.on : t.off}
                </button>
            </div>
            {on && (
                <p className={`text-[10px] ${tone}`}>
                    {t.state[status.state]}
                    {status.calls > 0 && <span className="text-slate-500"> · {t.calls(status.calls)}</span>}
                    {status.detail && <span className="block text-[9px] text-slate-500 mt-0.5">{status.detail}</span>}
                </p>
            )}
            <p className="text-[9px] text-slate-600">{t.intro}</p>
            <p className="text-[9px] text-slate-600">{t.setup}</p>
        </div>
    );
};
