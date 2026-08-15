'use client';

import React from 'react';
import { RfKorrSource } from '@/lib/types';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * Where the rf_korr that the VE derivation divides out comes from.
 *
 * ## Why dividing it out is not one of the options
 *
 * The DME meters fuel from `RF = (rf_soll × rf_korr) >> 10` (rf_calc, master 0x0218D0), and
 * rf_korr is applied on all three RF paths whether the PATCH is on or off. So the trim the closed
 * loop learned is an error on the CORRECTED value, and `VE′ = VE × STFT × rf_korr` is what leaves a
 * table the DME can then re-correct at runtime. Not dividing it out was offered as a third option
 * once; it is exact only if the table's claim matches this engine exactly, and its failure mode is
 * LEAN — measured at −6 % on a mixed drive and −13 % on a cold-exhaust one. It is gone.
 *
 * ## The two routes, and why both exist
 *
 *     RF ÷ rf_soll                what the DME actually applied, recovered from its own output
 *     KF_RF_KORR_DRREL(rpm, Δ)    the binary's table, read at Δ = kf_rf_tabg_modell(rpm, RF) − TABG
 *
 * They reach the same table two ways, so agreement is the check on DS2 offsets 8 and 14. They are
 * both offered rather than one being hard-coded because **offset 8 has not been confirmed against a
 * real DME**: the mapping comes from the ds2_handler disassembly plus two cross-checks, and if it
 * turned out to point at pre-correction `rf_soll`, the first route would read 1.000 everywhere and
 * the correction would silently vanish. The second route does not depend on that offset for its
 * value, only for the model's Y-axis lookup.
 *
 * Where they legitimately differ: the DME's correction is gated on road speed > 20 km/h, which no
 * logged channel carries. Below it the DME applies 1.000 while the table still reads high — so
 * `RF ÷ rf_soll` is right about what happened and the table route is not.
 *
 * ## What is NOT here
 *
 * Writing the back-calculated table into the binary. That is `WRITE RF KORR` on the hub, beside
 * WRITE WARMUP and WRITE WOT, because it is the same kind of thing — a table derived from the tune,
 * injected at flash time — and because it is an action rather than a derivation setting.
 */

interface Route {
    id: RfKorrSource;
    label: string;
    formula: string;
    /** The channel this route cannot work without, beyond RF which both require. */
    needs?: 'tabg';
}

const ROUTES: Route[] = [
    { id: 'rf-ratio', label: 'RF ÷ rf_soll', formula: 'rf_korr = RF ÷ rf_soll' },
    { id: 'table-delta', label: 'DME TABLE', formula: 'rf_korr = KF_RF_KORR_DRREL(rpm, Δ)', needs: 'tabg' },
];

const TEXT = {
    ja: {
        heading: 'VE 補正に使う rf_korr の出どころ',
        update: 'VE′ = VE × STFT × rf_korr（どちらを選んでも同じ）',
        rfRatio: 'DME が実際に掛けた倍率を、DME 自身の出力から割り戻します。RF 列だけで成立し、'
            + 'センサは要りません。20 km/h ゲートが閉じていた区間も 1.000 として正しく出ます。'
            + 'PATCH ON（k_rf_cfg = 0x02）が前提です — bit4 が立っていると RF に rf_p_saug_i が乗ります。',
        tableDelta: 'BIN の表を、センサが示す Δ で引き直します。Δ = kf_rf_tabg_modell(rpm, RF) − TABG。'
            + '**20 km/h ゲートは見えません** — ゲートが閉じていた区間でも表の値を返すので、'
            + 'そこは DME が実際に掛けた 1.000 とずれます。',
        noTabg: '排気温(TABG)がログに無いため選べません。初回のデータログで TABG が取れているか確認してください。',
        agree: '2 経路の一致',
        agreeGood: '一致。DS2 offset 8 / 14 とカタログのアドレス解釈が同時に裏付けられます。',
        agreeBad: '不一致。offset 8 が補正前の rf_soll を指している疑いがあります — '
            + 'その場合 RF ÷ rf_soll は 1.000 に張り付きます。書き込みの前に確認してください。',
        agreeNone: 'まだ判定できません（TABG または RF が不足）。',
        write: '逆算した表を BIN に書くかどうかは、ハブの WRITE RF KORR で選びます。',
    },
    en: {
        heading: 'Where rf_korr comes from for the VE derivation',
        update: 'VE′ = VE × STFT × rf_korr — the same either way',
        rfRatio: 'Recovers the multiplier the DME actually applied, out of its own output. Works from '
            + 'the RF channel alone, no sensor needed, and correctly reads 1.000 wherever the 20 km/h '
            + 'gate was shut. Assumes the PATCH is on (k_rf_cfg = 0x02) — with bit 4 set, RF also '
            + 'carries rf_p_saug_i and the ratio is contaminated.',
        tableDelta: 'Reads the binary\'s own table at the Δ the sensor reports: '
            + 'Δ = kf_rf_tabg_modell(rpm, RF) − TABG. **It cannot see the 20 km/h gate** — where the '
            + 'gate was shut it still returns the table value, while the DME applied 1.000.',
        noTabg: 'No exhaust temperature (TABG) in this log. Check the first datalog for a TABG channel.',
        agree: 'the two routes',
        agreeGood: 'agree — which confirms DS2 offsets 8 and 14 and the catalog addresses at once.',
        agreeBad: 'disagree. Offset 8 may be pointing at pre-correction rf_soll, in which case '
            + 'RF ÷ rf_soll sits at 1.000. Resolve this before writing anything.',
        agreeNone: 'cannot be compared yet (TABG or RF missing).',
        write: 'Whether the back-calculated table is written into the binary is WRITE RF KORR on the hub.',
    },
};

export const RfKorrSourceControl: React.FC<{
    source: RfKorrSource;
    onChange: (source: RfKorrSource) => void;
    /** The log carries an exhaust temperature, so the table route can index a Δ. */
    hasTabg: boolean;
    readOnly?: boolean;
    /**
     * Mean |RF÷rf_soll − table(rpm,Δ)| over the samples where both exist, or undefined when they
     * cannot be compared. The number is the point: this is the only check the app has on an offset
     * nobody has confirmed on a car.
     */
    routeGap?: number;
    /** How many samples the gap was measured over. See the note beside where it renders. */
    routeSamples?: number;
}> = ({ source, onChange, hasTabg, readOnly = false, routeGap, routeSamples }) => {
    const lang = useDialogLang();
    const t = TEXT[lang];
    const selected = ROUTES.find(r => r.id === source) ?? ROUTES[0];

    /** `**bold**`, so the clause that says what a route CANNOT see is not buried mid-paragraph. */
    const render = (text: string) => text.split(/\*\*(.+?)\*\*/g).map((part, i) => (
        i % 2 === 1 ? <strong key={i} className="text-slate-400 font-bold">{part}</strong> : part
    ));

    const gapOk = routeGap !== undefined && routeGap <= 0.02;

    return (
        <div className="space-y-1">
            <div className="flex justify-between items-center gap-2 text-[10px] text-slate-500 uppercase tracking-wider">
                <span>{t.heading}</span>
            </div>

            <div className="flex gap-1">
                {ROUTES.map(route => {
                    const locked = route.needs === 'tabg' && !hasTabg;
                    return (
                        <button
                            key={route.id}
                            type="button"
                            disabled={readOnly || locked}
                            onClick={() => onChange(route.id)}
                            title={route.formula}
                            // min-h-10, not padding alone. The checkboxes around this reach a 38px
                            // target with `py-3 -my-3` — a big hit area behind a small mark — but a
                            // segmented control has no separate mark to keep small, so it just gets
                            // the height. Measured at 26px before this.
                            className={`flex-1 min-h-10 px-1 text-[9px] font-bold tracking-wider rounded font-mono ${source === route.id
                                ? 'bg-blue-600 text-white'
                                : locked
                                    ? 'bg-slate-900 text-slate-700 cursor-not-allowed'
                                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                        >
                            {route.label}
                        </button>
                    );
                })}
            </div>

            {/* The formula, always. It is the one description of this control that cannot drift away
                from what the code does — a name can. */}
            <p className="text-[9px] font-mono text-blue-400/80">{selected.formula}</p>
            <p className="text-[9px] font-mono text-slate-600">{t.update}</p>

            <p className="text-[9px] text-slate-600 leading-snug">
                {render(source === 'table-delta' ? t.tableDelta : t.rfRatio)}
            </p>

            {!hasTabg && <p className="text-[9px] text-amber-500/80 leading-snug">{t.noTabg}</p>}

            {/* The cross-check. Stated as a number rather than a verdict badge: the threshold is a
                judgement and the reader should see what it was applied to. */}
            <p className="text-[9px] leading-snug">
                <span className="text-slate-500 uppercase tracking-wider">{t.agree}</span>{' '}
                {routeGap === undefined
                    ? <span className="text-slate-600">{t.agreeNone}</span>
                    : (
                        <>
                            <span className="font-mono text-slate-400">Δ{routeGap.toFixed(3)}</span>{' '}
                            <span className={gapOk ? 'text-emerald-400/80' : 'text-red-400'}>
                                {gapOk ? t.agreeGood : t.agreeBad}
                            </span>
                            {/* The sample count is not decoration. This is measured only where the
                                DME's correction was actually running, and on a normal road drive
                                that is a handful of samples out of thousands — a tight Δ over n=3
                                is not a confirmation of anything. */}
                            {routeSamples !== undefined && (
                                <span className="font-mono text-slate-600">{' '}n={routeSamples}</span>
                            )}
                        </>
                    )}
            </p>

            <p className="text-[9px] text-slate-700 leading-snug">{t.write}</p>
        </div>
    );
};
