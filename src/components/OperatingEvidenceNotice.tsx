import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import type { LogDataPoint, VEMap } from '@/lib/types';
import type { VeCalcOptions } from '@/lib/ve-calculator/calculator';
import { operatingCalibrationContext } from '@/lib/ve-calculator/operatingPolicy';
import { summarizeAcquisition } from '@/lib/ve-calculator/acquisitionEvidence';
import { useDialogLang } from '@/hooks/useDialogLang';
import { DialogFrame } from './DialogFrame';
import { RfResponseSummary } from './RfResponseSummary';

const labels: Record<string, string> = {
    'purge-active': 'パージ作動', 'purge-unknown': 'パージ不明', 'controller-clamp': 'トリム限界近傍',
    'short-window': '定常時間不足', 'thin-window': 'サンプル不足', 'trim-moving': 'トリム変化',
    'rf-moving': '充填量変化', 'load-moving': 'RO変化', 'rpm-moving': '回転数変化',
    'ltft-unknown': '学習値欠測', 'ltft-moving': '学習値変化', 'correction-settling': '補正応答待ち',
    'correction-transition': '補正切替', 'correction-state-unknown': '補正状態不明',
    'controller-limits-unknown': 'BINしきい値不明', 'cold-engine': '暖機不足', 'fuel-cut': '燃料カット',
    'full-load': '全負荷', 'cat-protect': '触媒保護', 'sample-gap': '通信間隔',
    'excluded': '指定除外区間', 'pending': '未判定',
    'invalid-config': '判定設定不正', 'invalid-time': '時刻不正', 'non-monotonic-time': '時刻の逆行',
    'operating-point-unknown': '運転状態欠測', 'trim-unknown': 'トリム欠測', 'lambda-state-unknown': '燃調状態欠測',
};

export function OperatingEvidenceNotice({ raw, map, base, options, active, readOnly, logging, onEnable }: {
    raw: LogDataPoint[] | null; map: VEMap | null; base: ArrayBuffer | null;
    options: VeCalcOptions; active: boolean; readOnly: boolean; logging: boolean; onEnable: () => void;
}) {
    const ja = useDialogLang() === 'ja';
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const close = useRef<HTMLButtonElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const context = useMemo(() => operatingCalibrationContext(base), [base]);
    // No second full replay in the closed strip, including during LIVE acquisition.
    const report = useMemo(() => open && !logging && map && raw?.length
        ? summarizeAcquisition(map, raw, options) : null, [open, logging, map, raw, options]);
    useEffect(() => {
        if (!open) return;
        const opener = trigger.current;
        close.current?.focus();
        const key = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
            if (event.key === 'Tab') {
                const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary') ?? [])
                    .filter(element => element.checkVisibility());
                const first = controls[0], last = controls.at(-1);
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        };
        window.addEventListener('keydown', key);
        return () => { window.removeEventListener('keydown', key); opener?.focus(); };
    }, [open]);
    const reasonText = (entries: [string, number][]) => entries.length
        ? entries.map(([r, n]) => `${ja ? labels[r] ?? r : r}: ${n}`).join(' / ')
        : (ja ? '除外なし' : 'No exclusions');
    const held = !context.known || context.airModelActive || context.learningActive;
    const title = ja ? 'RF応答チェック' : 'RF response check';
    return <>
        <button ref={trigger} type="button" onClick={() => setOpen(true)} disabled={logging}
            className="shrink-0 h-10 flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-900 px-4 text-xs text-slate-200"
            aria-haspopup="dialog" data-testid="rf-acquisition-open">
            <span className="flex items-center gap-2"><Activity className="w-4 h-4" />{title}</span>
            <span className="text-amber-300">{active ? (ja ? '観測専用' : 'Observation only') : (ja ? '従来Tune' : 'Legacy Tune')} ›</span>
        </button>
        {open && <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} data-testid="rf-acquisition-dialog">
            <DialogFrame icon={<Activity className="w-3 h-3" />} title={title}
                closeButtonClassName="min-w-10 min-h-10 flex items-center justify-center"
                closeLabel={ja ? '閉じる' : 'Close'} onClose={() => setOpen(false)}>
                <div className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-1 text-xs leading-relaxed">
                    {logging ? <p>{ja ? 'ログ停止後に解析できます。' : 'Analysis is available after logging stops.'}</p>
                        : raw?.length ? <RfResponseSummary raw={raw} base={base} options={options} ja={ja} />
                        : <p>{ja ? 'ログを読み込むと通過区間の応答を集計します。' : 'Load a log to inspect response during passes.'}</p>}
                    <details>
                    <summary className="cursor-pointer min-h-10 py-2 text-slate-200">{ja ? '従来の定常解析・BASE条件' : 'Steady analysis and BASE conditions'}</summary>
                    <section>
                        <p className="font-semibold text-slate-100">{ja ? '1. 記録時BASEの条件' : '1. Recording BASE conditions'}</p>
                        {!context.known ? <p className="text-amber-300">{ja ? 'BASE未確認。校正条件は判定できません。' : 'BASE unknown. Calibration conditions cannot be checked.'}</p> : <dl className="grid grid-cols-2 gap-x-2 gap-y-1 mt-2">
                            <dt>MAP / HFM</dt><dd className={context.airModelActive ? 'text-amber-300' : 'text-slate-200'}>{context.airModelActive ? (ja ? '有効・校正保留' : 'Active · held') : (ja ? '停止' : 'Disabled')}</dd>
                            <dt>{ja ? '学習温度範囲' : 'Learning window'}</dt><dd className={context.learningActive ? 'text-amber-300' : 'text-slate-200'}>{context.learningActive ? `${context.learningWindow.tmotMin}–${context.learningWindow.tmotMax} °C` : (ja ? '停止' : 'Frozen')}</dd>
                            <dt>{ja ? 'パージ制御' : 'Purge control'}</dt><dd className={context.purgeEnabled ? 'text-amber-300' : 'text-slate-200'}>{context.purgeEnabled ? (ja ? '有効・作動中の点は除外' : 'Enabled · active samples excluded') : (ja ? '停止' : 'Disabled')}</dd>
                        </dl>}
                        <p className="mt-2 text-amber-300">{held
                            ? (ja ? 'このBASEでは校正保留です。追加走行の前に計測条件の準備が必要です。パッチの画面設定だけでは、この判定は変わりません。' : 'Calibration held. Prepare the recording conditions before another drive. Patch toggles alone do not change this check.')
                            : (ja ? 'BASEの前提条件を確認しました。学習値・定常性・補正ゲートの検証は別途必要です。' : 'BASE prerequisites checked. Learned values, stability and correction gates still need validation.')}</p>
                    </section>
                    <section>
                        <p className="font-semibold text-slate-100">{ja ? '2. ログ全体の収録状況' : '2. Complete log coverage'}</p>
                        <p className="text-slate-400">{ja ? '2200–2700 rpm・補正後RO。既存フィルターで落ちた点も含みます。' : '2200–2700 rpm, corrected RO. Includes rows rejected by the original filter.'}</p>
                        {!report ? <p className="mt-2">{ja ? 'BASEとログを読み込むと集計します。' : 'Load a BASE and log to see counts.'}</p> : <>
                            {([{ label: 'RO 7.5–10%', band: report.focus }, { label: 'RO 5–<7.5%', band: report.adjacent }]).map(({ label, band }, i) =>
                                <div key={label} className="mt-3" data-testid={i === 0 ? 'rf-focus-counts' : 'rf-adjacent-counts'}>
                                    <p className="font-mono text-slate-100">{label}: {band.total} {ja ? '点' : 'samples'}</p>
                                    <p>{ja ? `定常通過 ${band.steady} / パージ作動 ${band.purge} / 定常かつLTFT両バンク1.000 ${band.neutral}` : `Steady ${band.steady} / purge active ${band.purge} / steady with both LTFTs 1.000 ${band.neutral}`}</p>
                                    <p className="text-slate-400">{band.total ? reasonText(band.reasons) : (ja ? '対象サンプルなし' : 'No samples in this band')}</p>
                                    <details className="mt-1"><summary className="cursor-pointer min-h-10 py-2 text-slate-200">{ja ? 'パージ以外の不足を確認' : 'Inspect other blockers'}</summary>
                                        <p>{ja ? `診断上、パージだけを無視しても定常通過は ${band.withoutPurgeSteady} 点。` : `Ignoring purge for diagnosis only: ${band.withoutPurgeSteady} steady samples.`}</p>
                                        <p className="text-slate-400">{reasonText(band.withoutPurgeReasons)}</p>
                                        <p className="text-amber-300">{ja ? 'この診断でTuneへの採用条件は緩和しません。' : 'This diagnosis does not relax Tune eligibility.'}</p>
                                    </details>
                                </div>)}
                            <p className="mt-3 font-mono">RAM: k {report.direct.korr} / soll {report.direct.soll} / MAP {report.direct.map} · {report.total} {ja ? '総点数' : 'total'}</p>
                            <p className="text-slate-400">{ja ? 'MAPは間引き読取。RAMは未検証の観測値で、Tuneの入力には使いません。' : 'MAP is read less frequently. RAM observations are unverified and are not Tune inputs.'}</p>
                        </>}
                    </section>
                    </details>
                    <section>
                        <p className="font-semibold text-slate-100">{ja ? '計測と保存' : 'Acquisition and storage'}</p>
                        <p>{ja ? '操作は停車中に行い、通常走行で対象域を通過した前後を記録してください。通過応答の収録に5秒間の保持は不要です。Δ30のアンカー成立や必要補正量は、この表示だけでは確定しません。' : 'Operate while parked and log the approach to and exit from ordinary passes. Response capture requires no five-second hold. This display alone does not establish a Δ30 anchor or the required correction.'}</p>
                        <p className="mt-2">{ja ? '観測専用ではSAVEで追加信号・読出し時刻を含む生ログ、解析設定、BASEを保存し、SYNCでクラウドへ送ります。解析は再読込時に再計算し、解析JSONには版番号を付けます。既存TUNEDがある場合は別の記録を作ります。応答解析からTune用BINを生成・書き込みしません。' : 'Observation SAVE keeps raw signals, read windows, settings and BASE; SYNC uploads them. Analysis is recomputed on reload and exported with a version number. Prior TUNED records are preserved. Response analysis cannot generate or write a Tune BIN.'}</p>
                        {!active && <p className="mt-2 text-amber-300">{ja ? '現在は従来Tuneです。このチェックを開くだけでは計算方式は変わりません。観測用のログは下のボタンで切り替えてください。' : 'Legacy Tune is selected. Opening this check does not change the calculation. Select observation mode below for research logs.'}</p>}
                    </section>
                </div>
                <div className="shrink-0 pt-3 flex flex-wrap justify-end gap-2">
                    {!active && <button type="button" disabled={readOnly} onClick={() => { onEnable(); close.current?.focus(); }} data-testid="rf-acquisition-enable"
                        className="min-h-10 rounded px-3 bg-amber-500 text-slate-950 font-semibold text-xs disabled:opacity-50">{ja ? '観測専用に切り替える' : 'Use observation mode'}</button>}
                    <button ref={close} type="button" onClick={() => setOpen(false)} className="min-h-10 rounded border border-slate-600 px-3 text-xs text-slate-200">{ja ? '閉じる' : 'Close'}</button>
                </div>
            </DialogFrame>
        </div>}
    </>;
}
