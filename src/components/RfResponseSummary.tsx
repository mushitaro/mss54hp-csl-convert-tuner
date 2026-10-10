import { useMemo } from 'react';
import type { LogDataPoint } from '@/lib/types';
import type { VeCalcOptions } from '@/lib/ve-calculator/calculator';
import { APP_CONFIG } from '@/config/constants';
import { timeScaleSeconds } from '@/lib/log-engine/filter';
import { downloadBlob, MIME_JSON } from '@/lib/download';
import { readResponseCalibration, summarizeRfResponse } from '@/lib/ve-calculator/rfResponseEvidence';

/** Mounted only in the open, stopped-log dialog. No full-log work on the live poll path. */
export function RfResponseSummary({ raw, base, options, ja }: {
    raw: LogDataPoint[]; base: ArrayBuffer | null; options: VeCalcOptions; ja: boolean;
}) {
    const report = useMemo(() => summarizeRfResponse(raw, {
        calibration: readResponseCalibration(base), secondsPerTimeUnit: timeScaleSeconds(raw),
        correctLoad: !!options.steadyFilterConfig?.enableCorrection,
        loadTable: options.steadyLoadTable ?? APP_CONFIG.MSS54HP.INTERPOLATION_TABLE,
    }), [raw, base, options]);
    const c = report.coverage;
    const fixed = (v: number | null, digits = 0) => v === null ? '—' : v.toFixed(digits);
    const pair = (v: [number | null, number | null]) => v.map(x => fixed(x, 3)).join(' / ');
    return <section data-testid="rf-response-summary" className="space-y-2">
        <p className="font-semibold text-slate-100">{ja ? '通過区間の応答' : 'Response during passes'}</p>
        <p>{ja ? '通常走行で通過した区間を集計します。運転点の保持は必要ありません。'
            : 'Summarizes passes during normal driving. Holding an operating point is not required.'}</p>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1">
            <dt>{ja ? '追加ラムダ読出し' : 'Extended lambda reads'}</dt><dd className="font-mono">{c.wideReads} / {c.total}</dd>
            <dt>{ja ? '必要信号と時刻が揃った点' : 'Complete signals and timing'}</dt><dd className="font-mono">{c.completeRows} / {c.total}</dd>
            <dt>{ja ? '両バンク制御ON' : 'Both controllers enabled'}</dt><dd className="font-mono">{c.activeBoth}</dd>
            <dt>{ja ? 'O₂反転を観測 B1 / B2' : 'Observed O₂ reversals B1 / B2'}</dt><dd className="font-mono">{report.banks[0].reversals} / {report.banks[1].reversals}</dd>
            <dt>{ja ? '加減速補正 ≠ 1' : 'Acceleration factor ≠ 1'}</dt><dd className="font-mono">{c.baChanged}</dd>
            <dt>{ja ? '標本間隔・中央値' : 'Median sample interval'}</dt><dd className="font-mono">{fixed(report.medianSampleMs)} ms</dd>
            <dt>{ja ? '必要読出しの時間幅・最大' : 'Largest acquisition span'}</dt><dd className="font-mono">{fixed(report.maxCaptureSpanMs)} ms</dd>
        </dl>
        {!c.wideReads && <p className="text-slate-300" data-testid="rf-response-missing">{ja
            ? '追加信号は未収録です。旧ログや通常版・代替プロファイルのログでは、O₂応答を検証できません。'
            : 'Extended signals were not recorded. Older, production or fallback logs cannot establish O₂ response.'}</p>}
        {!report.settings.calibration && <p className="text-slate-300">{ja
            ? 'BINのO₂しきい値を確認できないため、リッチ／リーンとトリム限界を判定していません。'
            : 'BIN thresholds are unavailable; rich/lean and trim limits are not classified.'}</p>}
        <p className="text-slate-400">{ja
            ? 'RAMの対応は実車未検証です。O₂電圧は空燃比ではなく、反転回数は読取間隔で見逃すことがあります。時刻は通信の観測範囲です。遅延時間や必要トリムの確定値としてTuneに渡しません。'
            : 'RAM mapping is unverified on car. O₂ voltage is not AFR; sampled reversal counts can miss cycles. Times bound host reads. This report does not provide a validated delay or required trim to Tune.'}</p>
        <details>
            <summary className="cursor-pointer min-h-10 py-2 text-slate-200">{ja
                ? `対象域の通過 ${report.passes.length} 区間（2200–2700 rpm / RO 7.5–10%）`
                : `${report.passes.length} passes: 2200–2700 rpm / RO 7.5–10%`}</summary>
            <div className="space-y-3">
                {report.passes.slice(0, 20).map(p => <div key={p.startIndex} className="border-b border-slate-800 pb-2 font-mono text-[11px]">
                    <p>{fixed(p.startSec, 2)}–{fixed(p.endSec, 2)} s · {p.points} {ja ? '点' : 'rows'} · {ja ? '信号完備' : 'complete'} {p.completeRows}</p>
                    <p>k {fixed(p.kMin, 3)}–{fixed(p.kMax, 3)}</p>
                    <p>STFT B1 / B2: {pair(p.trimStart)} → {pair(p.trimEnd)}</p>
                </div>)}
                {report.passes.length > 20 && <p>{ja ? '全区間は解析JSONに保存します。' : 'Analysis JSON contains every pass.'}</p>}
            </div>
        </details>
        <button type="button" data-testid="rf-response-export"
            onClick={() => downloadBlob(JSON.stringify(report, null, 2), 'rf-response-analysis-v1.json', MIME_JSON)}
            className="min-h-10 px-3 rounded border border-slate-600 text-slate-200">
            {ja ? '解析JSONを保存' : 'Save analysis JSON'}
        </button>
    </section>;
}
