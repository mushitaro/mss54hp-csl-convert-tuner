import React, { useCallback, useEffect, useState } from 'react';
import { Eraser, Loader2, X, AlertTriangle } from 'lucide-react';
import { AdaptationSnapshot, AdaptationReading } from '@/lib/dme-link/adaptationBlocks';

interface Props {
    /** dmeLink.readAdaptations — resolves null on failure (the reason lands in `error`). */
    onRead: () => Promise<AdaptationSnapshot | null>;
    /** dmeLink.resetAdaptations — clears, settles, re-reads. Null on failure. */
    onReset: () => Promise<AdaptationSnapshot | null>;
    onClose: () => void;
    /** Fired once, only after a clear and its verifying re-read have both succeeded. */
    onResetComplete: (before: AdaptationSnapshot, after: AdaptationSnapshot) => void;
    error: string | null;
}

/**
 * 'clearing' deliberately spans the 0x43, the DME's settle wait and the re-read as one step: once
 * the DME acknowledges, the values are gone, so there is no honest way to cancel partway. That phase
 * therefore renders no cancel affordance at all — no X, no backdrop dismiss.
 */
type Phase = 'reading' | 'viewing' | 'confirming' | 'clearing' | 'result' | 'failed';

/** Mirrors the reference's DmeAdaptationDecoder.FormatNumber: integers plain, everything else to at
 *  most 5 decimals with trailing zeros dropped. */
function formatValue(value: number | null): string {
    if (value === null) return '—'; // the DME's response was too short for this field — not a zero
    if (Math.abs(value - Math.round(value)) < 1e-7) return String(Math.round(value));
    return String(Number(value.toFixed(5)));
}

function groupReadings(readings: AdaptationReading[]): { name: string; rows: AdaptationReading[] }[] {
    const groups: { name: string; rows: AdaptationReading[] }[] = [];
    for (const reading of readings) {
        let group = groups.find(g => g.name === reading.group);
        if (!group) { group = { name: reading.group, rows: [] }; groups.push(group); }
        group.rows.push(reading);
    }
    return groups;
}

export const AdaptationResetDialog: React.FC<Props> = ({ onRead, onReset, onClose, onResetComplete, error }) => {
    const [phase, setPhase] = useState<Phase>('reading');
    const [before, setBefore] = useState<AdaptationSnapshot | null>(null);
    const [after, setAfter] = useState<AdaptationSnapshot | null>(null);

    // No setState before the first await: `phase` already starts at 'reading', so the mount effect
    // has nothing to synchronise, and retry() sets it back itself.
    const load = useCallback(async () => {
        const snapshot = await onRead();
        if (!snapshot) { setPhase('failed'); return; }
        setBefore(snapshot);
        setPhase('viewing');
    }, [onRead]);

    useEffect(() => { void load(); }, [load]);

    /** Retry always re-reads, never re-clears — a failed clear leaves a stale `before` on screen,
     *  and the honest next step is to go look at the DME again and decide from what it says now. */
    const retry = () => {
        setBefore(null);
        setAfter(null);
        setPhase('reading');
        void load();
    };

    const handleReset = async () => {
        if (!before) return;
        setPhase('clearing');
        const snapshot = await onReset();
        if (!snapshot) { setPhase('failed'); return; }
        setAfter(snapshot);
        setPhase('result');
        onResetComplete(before, snapshot);
    };

    const busy = phase === 'reading' || phase === 'clearing';
    const dismissable = !busy;
    /** Which snapshot supplies the row set. Null only while the first read is still in flight —
     *  every phase that renders the table has one — so the spinner branch below doubles as the
     *  null check, and the table branch gets a non-null `shown` from narrowing rather than an
     *  assertion. Should that invariant ever break, the cost is a stuck spinner over a modal, not
     *  a crash. */
    const shown = after ?? before;
    const afterBySymbol = new Map((after?.readings ?? []).map(r => [r.symbol, r.value]));

    return (
        <>
            <div
                className="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-sm"
                onClick={dismissable ? onClose : undefined}
            />
            <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] max-h-[80vh] flex flex-col bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 p-4 animate-in fade-in zoom-in-95 duration-200">
                <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-2 shrink-0">
                    <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                        <Eraser className="w-3 h-3" />
                        RESET ADAPT — DME学習値
                    </h3>
                    {dismissable && (
                        <button onClick={onClose} aria-label="閉じる" className="text-slate-500 hover:text-slate-300">
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>

                {phase === 'failed' ? (
                    <div className="space-y-4">
                        <p className="text-[10px] font-mono text-red-400 leading-relaxed">
                            {error ?? '学習値の読み出し/リセットに失敗しました。'}
                        </p>
                        <p className="text-[9px] font-mono text-slate-500 leading-relaxed">
                            リセットは何度実行しても同じ結果になります。接続を確認して、そのまま再試行できます。
                        </p>
                        <div className="flex justify-end gap-4 pt-1">
                            <button onClick={onClose} className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                閉じる
                            </button>
                            <button onClick={retry} className="text-[10px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 transition-colors">
                                再試行
                            </button>
                        </div>
                    </div>
                ) : !shown ? (
                    <div className="flex items-center gap-2 py-8 justify-center text-[10px] font-mono text-slate-500">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        現在の学習値を読み込み中…
                    </div>
                ) : (
                    <>
                        <div className="flex-1 overflow-y-auto -mx-1 px-1">
                            <div className="flex items-center gap-3 text-[9px] font-bold uppercase tracking-widest text-slate-600 pb-1.5 border-b border-slate-800/60">
                                <span className="flex-1">項目</span>
                                <span className="w-[72px] text-right">{after ? 'BEFORE' : '現在値'}</span>
                                {after && <span className="w-[72px] text-right">AFTER</span>}
                                <span className="w-[64px] text-right">期待値</span>
                            </div>

                            {groupReadings(shown.readings).map(group => (
                                <div key={group.name} className="mt-3">
                                    <div className="text-[9px] uppercase tracking-widest text-slate-600 mb-1">{group.name}</div>
                                    {group.rows.map(row => {
                                        const beforeValue = before?.readings.find(r => r.symbol === row.symbol)?.value ?? null;
                                        return (
                                            <div key={row.symbol} className="flex items-center gap-3 text-[10px] font-mono py-[3px]">
                                                <span className="flex-1 text-slate-500 truncate" title={row.symbol}>
                                                    {row.label}{row.unit && <span className="text-slate-600"> ({row.unit})</span>}
                                                </span>
                                                <span className={`w-[72px] text-right ${beforeValue === null ? 'text-slate-600' : 'text-slate-300'}`}>
                                                    {formatValue(beforeValue)}
                                                </span>
                                                {after && (
                                                    <span className={`w-[72px] text-right ${afterBySymbol.get(row.symbol) == null ? 'text-slate-600' : 'text-slate-300'}`}>
                                                        {formatValue(afterBySymbol.get(row.symbol) ?? null)}
                                                    </span>
                                                )}
                                                <span className="w-[64px] text-right text-slate-600">{formatValue(row.cleared)}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}

                            {/* Why the two factors clear to 1 and not 0, said once rather than per row. Stated as
                                information, not as a verdict: nothing here checks the values against it. */}
                            <p className="mt-4 pt-2 border-t border-slate-800/60 text-[9px] font-mono text-slate-600 leading-relaxed">
                                期待値: ラムダ学習係数は<span className="text-slate-500">乗算</span>のため中立は 1(0ではありません)。他は加算のため 0。
                            </p>
                        </div>

                        <div className="shrink-0 pt-3 mt-3 border-t border-slate-800">
                            {phase === 'viewing' && (
                                <div className="flex justify-between items-center">
                                    <span className="text-[10px] font-mono text-slate-500">リセットしていいですか？</span>
                                    <div className="flex gap-4">
                                        <button onClick={onClose} className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                            閉じる
                                        </button>
                                        <button onClick={() => setPhase('confirming')} className="text-[10px] font-bold uppercase tracking-widest text-red-400 hover:text-red-300 transition-colors">
                                            リセット
                                        </button>
                                    </div>
                                </div>
                            )}

                            {phase === 'confirming' && (
                                <div className="space-y-2.5">
                                    <p className="flex items-start gap-2 text-[10px] font-mono text-amber-400/90 leading-relaxed">
                                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                        <span>
                                            上の12項目をDMEから消去します。取り消せません。
                                            <span className="text-slate-500">
                                                {' '}スロットル/ペダル・SMGクラッチ・検出装備の学習値は消えません。
                                            </span>
                                        </span>
                                    </p>
                                    <div className="flex justify-end gap-4">
                                        <button onClick={() => setPhase('viewing')} className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                            やめる
                                        </button>
                                        <button onClick={() => void handleReset()} className="text-[10px] font-bold uppercase tracking-widest text-red-400 hover:text-red-300 transition-colors">
                                            リセット実行
                                        </button>
                                    </div>
                                </div>
                            )}

                            {phase === 'clearing' && (
                                <div className="flex items-center gap-2 text-[10px] font-mono text-amber-400">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    学習値をクリア中… DMEの反映を待っています(約2秒)
                                </div>
                            )}

                            {phase === 'result' && (
                                <div className="flex justify-between items-center">
                                    <span className="text-[10px] font-mono text-emerald-400">✅ リセット完了。このまま START TUNE できます。</span>
                                    <button onClick={onClose} className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                        閉じる
                                    </button>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </>
    );
};
