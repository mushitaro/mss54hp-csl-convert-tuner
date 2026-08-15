import React, { useMemo } from 'react';
import { Gauge, AlertTriangle, CheckCircle2, CircleSlash } from 'lucide-react';
import type { EgasMeasurement } from '@/lib/dme-link/types';
import type { InertiaEstimate } from '@/lib/inertia/types';
import type { CorrectionPlan, Proposal } from '@/lib/inertia/corrections';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * The same bands MapEditor tints VE coverage with, imported rather than restated so that
 * "enough samples" means one thing across the app.
 *
 * They were duplicated as literals here and drifted the moment the VE bands were raised from 10/30
 * to 30/100 — the inertia panel would have gone on calling 30 hits "well covered" while the map
 * beside it called the same number thin.
 *
 * Not configurable here, unlike the VE map's. This pipeline bins rpm sweeps rather than a log's
 * (rpm, load) plane, so the session's filter config does not describe it; the shared default is the
 * honest thing to follow and the wrong thing to let a VE-shaped setting override.
 */
import { COVERAGE_THIN_DEFAULT as COVERAGE_THIN, COVERAGE_OK_DEFAULT as COVERAGE_OK } from './MapEditor';

const TEXT = {
    ja: {
        title: '慣性測定',
        idle: '停車・ニュートラルで、ペダル 15 / 25 / 35 % のスイープを各 2 回。'
            + '最後に 5000 rpm から燃料カットで惰性降下を 1 回。',
        run: '測定開始',
        stop: '停止',
        samples: 'サンプル',
        rate: 'レート',
        coverage: '回転ビンごとの採用数',
        estimate: '推定',
        notAcceptable: 'この測定は採用できません',
        acceptable: '採用可',
        mLoss: '損失トルク',
        crosscheck: '自由降下の検算',
        rejects: '棄却の内訳',
        proposals: '提案',
        noPlan: '採用可能な測定が無いので提案はありません。',
        blocked: '提案できなかったもの',
        col: {
            group: '群', klass: 'ク', symbol: 'パラメータ', at: '箇所', addr: 'XDF',
            current: '現在値', proposed: '書ける値', step: '刻み', why: '理由', evidence: '根拠',
        },
        notWritable: '目標値は表現不能。最近傍を表示',
        wholeImage: 'どの群も 64 KB 全体の消去＋再書き込み 1 回。群は自動で連鎖しません。',
    },
    en: {
        title: 'Inertia measurement',
        idle: 'Stationary, in neutral: two pedal sweeps each at 15 / 25 / 35 %. '
            + 'Finish with one coast-down from 5000 rpm on a shut throttle.',
        run: 'Start',
        stop: 'Stop',
        samples: 'Samples',
        rate: 'Rate',
        coverage: 'Accepted samples per rpm bin',
        estimate: 'Estimate',
        notAcceptable: 'This measurement is not usable',
        acceptable: 'Usable',
        mLoss: 'Loss torque',
        crosscheck: 'Coast-down cross-check',
        rejects: 'Rejected samples',
        proposals: 'Proposals',
        noPlan: 'No usable measurement, so there is nothing to propose.',
        blocked: 'Not proposed',
        col: {
            group: 'Grp', klass: 'Cl', symbol: 'Parameter', at: 'At', addr: 'XDF',
            current: 'Current', proposed: 'Writable', step: 'Step', why: 'Why', evidence: 'Evidence',
        },
        notWritable: 'Target is not representable; nearest writable shown',
        wholeImage: 'Every group is one full 65536-byte erase and rewrite. Groups never chain automatically.',
    },
};

interface Props {
    samples: readonly EgasMeasurement[];
    estimate: InertiaEstimate | null;
    plan: CorrectionPlan | null;
    running: boolean;
    onStart: () => void;
    onStop: () => void;
    /** True J, when running against the offline bench. Lets PRACTICE say whether the estimate is
     *  RIGHT rather than merely plausible — the one thing a real car can never tell you. */
    benchTrueJ?: number;
}

const CLASS_HINT: Record<Proposal['klass'], string> = {
    A: 'engine alone',
    B: 'engine + car (per gear)',
    C: 'J is the divisor',
    D: 'not an inertia effect',
};

const EVIDENCE_STYLE: Record<Proposal['evidence'], string> = {
    'code-confirmed': 'text-emerald-400',
    'xref-only': 'text-amber-400',
    'funktionsrahmen-only': 'text-amber-500/70',
    'inference': 'text-slate-500',
};

export const InertiaPanel: React.FC<Props> = ({
    samples, estimate, plan, running, onStart, onStop, benchTrueJ,
}) => {
    const lang = useDialogLang();
    const t = TEXT[lang];

    const hz = useMemo(() => {
        const i = estimate?.medianSampleIntervalS;
        return i && i > 0 ? 1 / i : null;
    }, [estimate]);

    const benchError = benchTrueJ && estimate?.j
        ? Math.abs(estimate.j - benchTrueJ) / benchTrueJ
        : null;

    return (
        <div className="space-y-4 text-slate-300">
            <div className="flex justify-between items-center border-b border-slate-800 pb-2">
                <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                    <Gauge className="w-3 h-3" />{t.title}
                </h3>
                <button
                    onClick={running ? onStop : onStart}
                    className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded ${running
                        ? 'bg-red-900/60 text-red-200 hover:bg-red-900'
                        : 'bg-blue-900/60 text-blue-200 hover:bg-blue-900'}`}
                >
                    {running ? t.stop : t.run}
                </button>
            </div>

            <p className="text-[9px] font-mono text-amber-500/80 leading-relaxed">{t.idle}</p>

            <div className="flex gap-6 text-[10px] uppercase tracking-wider text-slate-500">
                <span>{t.samples} <span className="font-mono text-slate-200">{samples.length}</span></span>
                {/* Measured from the sample timestamps, never a figure computed from baud rate. */}
                <span>{t.rate} <span className="font-mono text-slate-200">{hz ? `${hz.toFixed(1)} Hz` : '—'}</span></span>
            </div>

            {estimate && (
                <>
                    <div className={`rounded border p-3 ${estimate.acceptable
                        ? 'border-emerald-900 bg-emerald-950/30' : 'border-amber-900 bg-amber-950/30'}`}>
                        <div className="flex items-center gap-2 mb-2">
                            {estimate.acceptable
                                ? <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                : <AlertTriangle className="w-3 h-3 text-amber-400" />}
                            <span className="text-[10px] uppercase tracking-widest font-bold">
                                {estimate.acceptable ? t.acceptable : t.notAcceptable}
                            </span>
                        </div>
                        <div className="font-mono text-sm text-slate-100">
                            J = {estimate.j !== null ? estimate.j.toFixed(4) : '—'}
                            {estimate.jSpread !== null && ` ± ${estimate.jSpread.toFixed(4)}`} Nms²
                        </div>
                        {benchError !== null && (
                            <div className="mt-1 font-mono text-[10px] text-blue-300">
                                PRACTICE: true J = {benchTrueJ!.toFixed(4)}, error {(100 * benchError).toFixed(1)} %
                            </div>
                        )}
                        <ul className="mt-2 space-y-1">
                            {estimate.notes.map((n, i) => (
                                <li key={i} className="text-[9px] leading-relaxed text-slate-400">— {n}</li>
                            ))}
                        </ul>
                    </div>

                    {/* Per-bin coverage AND per-bin J. The second column is the real verdict: engine
                        inertia cannot depend on engine speed, so bins that disagree mean the
                        measurement is wrong, not noisy. */}
                    <div>
                        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{t.coverage}</div>
                        <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 gap-y-1 text-[10px] font-mono">
                            {estimate.bins.map(b => (
                                <React.Fragment key={b.loRpm}>
                                    <span className="text-slate-500">{b.loRpm}–{b.hiRpm}</span>
                                    <span className={
                                        b.count >= COVERAGE_OK ? 'text-emerald-400'
                                            : b.count >= COVERAGE_THIN ? 'text-amber-400' : 'text-slate-600'}>
                                        {'█'.repeat(Math.min(20, Math.round(b.count / 3))) || '·'}
                                    </span>
                                    <span className="text-slate-400">{b.count}</span>
                                    <span className={b.j !== null ? 'text-slate-200' : 'text-slate-600'}>
                                        {b.j !== null ? b.j.toFixed(4) : (b.rejected ?? '—')}
                                    </span>
                                </React.Fragment>
                            ))}
                        </div>
                    </div>

                    {estimate.mLossCurve.length > 0 && (
                        <div className="text-[10px] font-mono text-slate-400">
                            <span className="uppercase tracking-wider text-slate-500">{t.mLoss}: </span>
                            {estimate.mLossCurve.map(p => `${p.rpm}:${p.mLoss.toFixed(1)}`).join('  ')} Nm
                        </div>
                    )}

                    <div className="text-[10px] font-mono text-slate-400">
                        <span className="uppercase tracking-wider text-slate-500">{t.crosscheck}: </span>
                        {estimate.freeDecel.found
                            ? `${estimate.freeDecel.measuredRpmPerS?.toFixed(0)} vs `
                            + `${estimate.freeDecel.predictedRpmPerS?.toFixed(0)} rpm/s `
                            + `(${estimate.freeDecel.agrees ? 'ok' : 'DISAGREES'})`
                            : '—'}
                    </div>

                    {estimate.rejects.length > 0 && (
                        <div className="text-[9px] font-mono text-slate-500">
                            <span className="uppercase tracking-wider">{t.rejects}: </span>
                            {estimate.rejects.map(r => `${r.reason} ${r.count}`).join(' · ')}
                        </div>
                    )}
                </>
            )}

            <div className="border-t border-slate-800 pt-3">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{t.proposals}</div>
                {!plan ? (
                    <p className="text-[9px] text-slate-600">{t.noPlan}</p>
                ) : (
                    <>
                        <p className="text-[9px] font-mono text-amber-500/80 mb-2 leading-relaxed">{t.wholeImage}</p>
                        <div className="text-[10px] font-mono text-slate-400 mb-2">
                            r = {plan.r.toFixed(4)} ·{' '}
                            {plan.rEff.filter(g => g.gear >= 1 && g.gear <= 6)
                                .map(g => `${g.label} ${g.rEff.toFixed(3)}`).join('  ')}
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-[9px] font-mono">
                                <thead>
                                    <tr className="text-slate-500 uppercase tracking-wider text-left">
                                        <th className="pr-2">{t.col.group}</th>
                                        <th className="pr-2">{t.col.klass}</th>
                                        <th className="pr-2">{t.col.symbol}</th>
                                        <th className="pr-2">{t.col.at}</th>
                                        <th className="pr-2">{t.col.addr}</th>
                                        <th className="pr-2 text-right">{t.col.current}</th>
                                        <th className="pr-2 text-right">{t.col.proposed}</th>
                                        <th className="pr-2 text-right">{t.col.step}</th>
                                        <th className="pr-2">{t.col.evidence}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {plan.proposals.map((p, i) => (
                                        <tr key={i} className="border-t border-slate-900 align-top">
                                            <td className="pr-2 text-slate-300">{p.group}</td>
                                            <td className="pr-2 text-slate-500" title={CLASS_HINT[p.klass]}>{p.klass}</td>
                                            <td className="pr-2 text-slate-200">{p.symbol}</td>
                                            <td className="pr-2 text-slate-500">{p.at ?? ''}</td>
                                            <td className="pr-2 text-slate-500">
                                                0x{p.address.toString(16).toUpperCase()}
                                                <span className="text-slate-700"> {p.bank[0]}</span>
                                            </td>
                                            <td className="pr-2 text-right text-slate-400">{p.current}</td>
                                            <td className="pr-2 text-right text-slate-100">
                                                {p.proposed}
                                                {/* An unrepresentable target is stated, not rounded away in
                                                    silence: the difference between what was asked for and
                                                    what the encoding allows is the operator's to see. */}
                                                {!p.exact && <span className="text-amber-500" title={t.notWritable}> *</span>}
                                            </td>
                                            <td className="pr-2 text-right text-slate-600">{p.step.toPrecision(2)}</td>
                                            <td className={`pr-2 ${EVIDENCE_STYLE[p.evidence]}`}>{p.evidence}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {plan.blocked.length > 0 && (
                            <div className="mt-3">
                                {/* Shown, never omitted. A row that is silently absent reads as
                                    "nothing needed here", which is a different claim from "this
                                    could not be computed". */}
                                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1">
                                    <CircleSlash className="w-3 h-3" />{t.blocked}
                                </div>
                                <ul className="space-y-1">
                                    {plan.blocked.map((b, i) => (
                                        <li key={i} className="text-[9px] text-slate-500 leading-relaxed">
                                            <span className="font-mono text-slate-400">{b.symbol}</span> — {b.why}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
