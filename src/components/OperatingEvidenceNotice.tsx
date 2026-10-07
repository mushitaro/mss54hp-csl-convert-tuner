import type { LogDataPoint } from '@/lib/types';
import type { OperatingHold } from '@/lib/ve-calculator/operatingPolicy';
import { useDialogLang } from '@/hooks/useDialogLang';

export function OperatingEvidenceNotice({ points, hold }: {
    points: LogDataPoint[]; hold: OperatingHold | null;
}) {
    const ja = useDialogLang() === 'ja';
    const accepted = points.filter(p => p.veEvidenceEligible).length;
    const counts = new Map<string, number>();
    for (const p of points) {
        const key = p.veEvidenceReason ?? 'pending';
        if (!p.veEvidenceEligible) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const reasons = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const labels: Record<string, string> = {
        'purge-active': 'パージ作動', 'purge-unknown': 'パージ不明', 'controller-clamp': 'トリム限界近傍',
        'short-window': '定常時間不足', 'trim-moving': 'トリム変化', 'rf-moving': '充填量変化',
        'load-moving': 'RO変化', 'rpm-moving': '回転数変化', 'ltft-unknown': '学習値欠測',
        'correction-settling': '補正応答待ち', 'correction-transition': '補正切替',
        'controller-limits-unknown': 'BINしきい値不明', 'pending': '未判定',
    };
    const context = hold === 'air-model-active' ? (ja ? 'MAP/HFM経路が有効' : 'MAP/HFM path active')
        : hold === 'learning-active' ? (ja ? '学習が有効' : 'learning active')
            : hold ? (ja ? '記録時BIN未確認' : 'recording BIN unknown') : '';
    return <details className="shrink-0 border-b border-amber-700/40 bg-amber-950/20 px-4 py-1 text-xs text-amber-200">
        <summary className="cursor-pointer">
            {ja ? '定常比較・書き込み保留' : 'Steady comparison · write held'} — {accepted}/{points.length}
            {ja ? ' サンプルが定常条件を通過' : ' samples pass steady conditions'}
            {context && ` · ${context}`}
        </summary>
        <p className="py-1">{reasons.map(([r, n]) => `${ja ? labels[r] ?? r : r}: ${n}`).join(' / ')}</p>
        <p className="pb-1 text-slate-300">{ja
            ? '既存フィルター通過サンプル内の集計です。定常条件の通過だけでは校正可能とは限りません。現在のRF KORRを維持する比較計算で、ゲートの再評価と別の熱状態での検証が完了するまでVE書き込みを保留します。直接RAM値は実車照合前の観測値です。'
            : 'Counts cover the original filtered stream. Passing steady conditions alone does not authorize calibration. The existing RF KORR is retained for comparison. VE writing is held pending gate and independent thermal-state validation. Direct RAM values are unverified observations.'}</p>
    </details>;
}
