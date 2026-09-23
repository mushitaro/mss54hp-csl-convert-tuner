'use client';

import React from 'react';
import { RfKorrSource } from '@/lib/types';
import { useDialogLang } from '@/hooks/useDialogLang';
import { Row } from './FilterPanelControls';

/**
 * Where the rf_korr that the VE derivation cancels comes from.
 *
 * One vocabulary, held deliberately: the DME multiplies rf_korr in (RF = rf_soll × rf_korr), the
 * trim learns its error on that corrected value and so carries 1/rf_korr inside it, and the
 * derivation multiplies the same rf_korr back in — VE′ = VE × STFT × rf_korr — to CANCEL it.
 * pt_korr is the one that is divided, inside the rf_soll reconstruction. This file used to say
 * "divide out" for the multiply, and the operator — whose understanding was correct — concluded
 * they had misunderstood (2026-08-22). Words are part of the instrument.
 *
 * ## Why cancelling is not optional
 *
 * The DME meters fuel from `RF = (rf_soll × rf_korr) >> 10` (rf_calc, master 0x0218D0), and
 * rf_korr is applied on all three RF paths whether the PATCH is on or off. So the trim the closed
 * loop learned is an error on the CORRECTED value, and `VE′ = VE × STFT × rf_korr` is what leaves a
 * table the DME can then re-correct at runtime. Not cancelling it was offered as a third option
 * once; it is exact only if the table's claim matches this engine exactly, and its failure mode is
 * LEAN — measured at −6 % on a mixed drive and −13 % on a cold-exhaust one. It is gone.
 *
 * ## The two routes, and why both exist
 *
 *     CALCULATE   rf_korr = RF ÷ rf_soll       what the DME applied, worked out of its own output
 *     TABG        KF_RF_KORR_DRREL(rpm, Δ)     the table's value at Δ = model(rpm, RF) − TABG
 *
 * Named for HOW THE READER GETS THE NUMBER, one word each (operator, 2026-08-25). Three sets of
 * names have been through here: the bare formulas ('RF ÷ rf_soll' / 'DME TABLE'), which said nothing
 * about cancelling; AS APPLIED / TABLE @ ΔEGT, which said what each route cancels but needed a
 * paragraph to tell apart and wrapped on a phone; and these.
 *
 * The second one is the CHANNEL, which is what finally made the pair discriminate. It was LOG for
 * an afternoon, and LOG is a word both routes can claim — both read the log, and both do arithmetic
 * on what they read, so a reader taking either name at face value had even odds of reading the pair
 * backwards. `TABG` cannot be claimed by the other route: it is the one channel this route needs
 * and the other one never touches, it is the word the rest of the app already uses for it (the
 * field registry, the disabled reason), and the disabled reason now says the same word twice on
 * purpose — the channel that is missing IS the button that is off.
 *
 * The copy still pins each name to its fact in the first clause, because CALCULATE is still a word
 * both routes could argue for.
 *
 * ## The row shows a name; everything else is behind the ⓘ
 *
 * Closed, this row is what its neighbours are: a label, the selected route, and the two buttons.
 * The readout line — the selected route's formula and the agreement between the routes — appears
 * when the explanation does, and that is what "put the formula in the info" meant (operator,
 * 2026-08-25). It was read as "take the formula out of the line", which left the line showing a
 * measurement that is the same whichever route is selected: a permanent fixture that no longer
 * responded to the control above it, which is a worse thing to leave on a panel than the formula
 * was. The formula is back where it was, and the whole line moved behind the ⓘ.
 *
 * Not into the prose, which was tried in between: `NAME（formula）` reads well until the formula
 * ends in a bracket of its own, and the table route rendered `KF_RF_KORR_DRREL(rpm, Δ)）`. Nothing
 * on screen says whether a doubled bracket is the copy or the value. A formula belongs on its own
 * line, in mono, where it is unambiguously a value — which is where it already was.
 *
 * ## The copy answers the reader's question, not mine
 *
 * The hint used to carry `k_rf_cfg = 0x02`, "bit 4", and DS2 offsets 8 and 14 — every word true,
 * none of it addressed to the person choosing a route (operator, 2026-08-24; the house rule is
 * ux-patterns → Copy). What a reader needs from those facts is: use CALCULATE normally; this log
 * has to have been recorded with the patch in; if the two routes disagree over part of the drive
 * that stretch is the shut gate and CALCULATE is right; if CALCULATE reads 1.000 everywhere the
 * log's RF is unusable and the table route is the way on. The offsets, the config bit and the
 * disassembly stay here and in types.ts, which is where the next maintainer looks.
 *
 * It also has to say what CHOOSING WRONG COSTS, or the reader has nothing to choose with. The
 * copy reached the point of describing both routes accurately, naming the default, and stating
 * that the row only changes how the VE table is worked out — and that last sentence, without its
 * consequence, is an answer to a question nobody asked (operator, 2026-08-24). The consequence is
 * the whole basis for the choice: the rf_korr multiplied back in has to be the one the DME applied
 * when the sample was logged, because the trim carries its inverse; too large writes the VE table
 * rich, too small writes it lean. That sentence is what makes "which is closer on this log" a
 * question a reader can answer, and it is what the two-route readout under the buttons is FOR.
 *
 * It also has to say what it does NOT decide. The operator read the two routes as "VE-only" versus
 * "fixing KF_RF_KORR_DRREL" (2026-08-24), which is a reasonable reading of two buttons that both
 * mention the table — and it is the other control: rewriting the table is WRITE RF KORR on the
 * hub, and this row still chooses a route on top of it (docs/ecu-logic/60 §6.4: two independent
 * decisions). The last paragraph now says so.
 *
 * BOTH are explained, always, and each paragraph opens with the name of the route it is about.
 * The hint used to describe only the SELECTED route, which read as one unbroken block: the reader
 * could not see where the explanation of the route ended and the two paragraphs after it — about
 * the pair, and about writing — began, because nothing in them named a new subject (operator,
 * 2026-08-24). Naming the route at the head of each paragraph is also what the rest of the panel
 * does: every hint there opens with "this filter excludes…" / "この設定は…".
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
 * ## Why this is a `Row`
 *
 * It was not, and it was the only setting in the panel that was not. It carried its own heading — a
 * Japanese sentence, where every neighbour has a short English name — its own information layout,
 * and five paragraphs that were open all the time while every other control keeps its explanation
 * behind the ⓘ. None of that was a decision; it is what happens when a control cannot reach the
 * shared vocabulary, and it could not, because `Row` lived inside the panel that imports this file.
 * `Row` is in FilterPanelControls now and this is an ordinary row: label, live value, explanation
 * behind the ⓘ, control underneath.
 *
 * ## What is NOT here
 *
 * Writing the back-calculated table into the binary. That is `WRITE RF KORR` on the hub, beside
 * WRITE WARMUP and WRITE WOT, because it is the same kind of thing — a table derived from the tune,
 * injected at flash time — and because it is an action rather than a derivation setting.
 */

interface Route {
    id: RfKorrSource;
    /** The button, and the row's live value. Short enough to sit in the value slot beside a label. */
    label: string;
    formula: string;
    /** The channel this route cannot work without. Both need `rf`; only the table route also
     *  needs an exhaust temperature to index Δ with. */
    needs: 'rf' | 'tabg';
}

const ROUTES: Route[] = [
    { id: 'rf-ratio', label: 'CALCULATE', formula: 'rf_korr = RF ÷ rf_soll', needs: 'rf' },
    { id: 'table-delta', label: 'TABG', formula: 'rf_korr = KF_RF_KORR_DRREL(rpm, Δ)', needs: 'tabg' },
];

/**
 * The two routes by MECHANISM, for the copy below to name and to quote.
 *
 * Destructured by what each one does rather than by what its button says: the labels are the
 * operator's words and have changed three times, the ratio and the table have not. Every mention of
 * a route in `TEXT`, and every formula in it, is interpolated from here — so a renamed button or a
 * corrected formula cannot leave behind a sentence that describes the old one. The readout line has
 * the same property for the formula itself, by printing `ROUTES[…].formula` rather than a copy of
 * it — which is why the formula is quoted there and named here, and not written out twice.
 */
const [RATIO, TABLE] = ROUTES;

/**
 * The label is English in both, like `VE Cell Gate` and `RF KORR Cell Gate` beside it.
 *
 * Control names are the instrument's vocabulary — the same words the stored TuneSettings and the
 * hub's WRITE RF KORR use — and translating one breaks that chain rather than helping it. Only the
 * text that explains something switches language. This row used to be the exception in both
 * directions: a translated heading, and a heading that was a sentence rather than a name.
 */
const TEXT = {
    ja: {
        label: 'RF KORR Cancel',
        hint:
            'DME は燃料を RF = rf_soll × rf_korr で計っています（rf_korr が排気温補正）。λ トリムはこの'
            + '補正済みの値に対する誤差を学習するので、トリムの中には掛かった rf_korr の逆数が残っています。'
            + '新しいテーブル値は VE′ = VE × STFT × rf_korr — 掛かったのと同じ値を掛け直して、その逆数を'
            + '打ち消します。この行が選ぶのは「DME がいくつ掛けたか」をどちらの経路で求めるかだけです。\n'
            + `${RATIO.label} は、DME が実際に掛けた値を、DME 自身の出力から計算で割り出して`
            + '打ち消します。排気温補正が切れていた区間も 1.000 と正しく出るので、'
            + '通常はこちらを使ってください。rf_soll を組み直すのに吸気温と気圧のチャンネルが要り、'
            + 'どちらかを欠くログでは rf_korr を測れず λ トリムだけで計算します。またパッチを入れて'
            + '記録したログが前提です — パッチ無しのログでは RF に別の補正が混ざり、比が正しく出ません。\n'
            + `${TABLE.label} は、名前のとおり、ログの排気温チャンネルを使う唯一の経路です。`
            + 'DME の排気温補正テーブルを実測の ΔEGT（モデル排気温 − ログの TABG）で引き直し、'
            + 'その表が選んだ値を打ち消します。この経路には車速による補正の入り切りが見えないので、'
            + `補正が切れていた区間でも表の値を返し、そこでは ${RATIO.label} とずれます。\n`
            + 'どちらを選ぶかは、書き込む VE テーブルの値にそのまま効きます。掛け直す rf_korr が'
            + '実際に掛かった値より大きければ VE テーブルはリッチ側に、小さければリーン側に'
            + '書き込まれます。選ぶ基準は「このログで、実際に掛かった値にどちらが近いか」だけです。\n'
            + '2 つの経路が一致すれば、このログの RF が正しく読めている裏付けになります'
            + '（平均差はこの説明のすぐ上に出しています）。ずれが一部の区間だけなら、それは補正が切れていた'
            + `区間で、正しいのは ${RATIO.label} です。${RATIO.label} がどこでも 1.000 に張り付く場合は`
            + `このログの RF が使えないので、${TABLE.label} で進めてください。\n`
            + '排気温補正の表そのもの（KF_RF_KORR_DRREL）は、この行では決まりません。表の逆算は'
            + `この設定を見ておらず、常に ${RATIO.label} と同じ測り方をします。書き換えるかどうかは`
            + 'ハブの WRITE RF KORR で決めます。',
        noTabg: `このログには排気温が記録されていないため、${TABLE.label} は選べません。`,
        noRf: 'このログには相対充填量が記録されていないため、どちらの経路も使えません。',
    },
    en: {
        label: 'RF KORR Cancel',
        hint:
            'The DME meters fuel from RF = rf_soll × rf_korr, where rf_korr is its EGT correction. The '
            + 'lambda trim learns its error against that corrected value, so the inverse of whatever '
            + 'rf_korr was applied is sitting inside the trim. The new table value is '
            + 'VE′ = VE × STFT × rf_korr — multiplying the same rf_korr back in cancels that inverse. '
            + 'This row only chooses which route the applied amount is found by.\n'
            + `${RATIO.label} works out the value the DME actually applied, arithmetically, from `
            + 'its own output, and cancels exactly that. It reads 1.000 where the exhaust '
            + 'correction was switched off, which is correct, so this is the one to use normally. '
            + 'It needs the intake-temperature and ambient-pressure channels to rebuild rf_soll; a '
            + 'log missing either cannot measure rf_korr and is calculated from the lambda trim '
            + 'alone. It also assumes the log was recorded with the patch in: without it, RF '
            + 'carries another correction as well and the ratio is not clean.\n'
            + `${TABLE.label} is named for the channel it needs: it is the only route that reads `
            + 'your logged exhaust temperature. It re-reads the DME’s exhaust-correction table at '
            + 'the measured ΔEGT (model exhaust temperature − logged TABG) and cancels the value '
            + 'the table selects. It cannot see the correction being switched in and out with road '
            + 'speed, so where the correction was off it still returns the table value, and there '
            + `it parts ways with ${RATIO.label}.\n`
            + 'The choice goes straight into the VE table you write. Multiply back a rf_korr '
            + 'larger than the one that was actually applied and the VE table comes out rich; '
            + 'smaller and it comes out lean. So the whole basis for choosing is which route is '
            + 'closer to what was actually applied, on this log.\n'
            + 'Agreement between the two routes confirms that this log’s RF is being read correctly '
            + '(the mean difference is on the line just above this). A difference over part of the drive is '
            + `the stretch where the correction was off, and ${RATIO.label} is the one that is `
            + `right. If ${RATIO.label} sits at 1.000 everywhere, this log’s RF cannot be used — `
            + `carry on with ${TABLE.label}.\n`
            + 'The exhaust-correction table itself (KF_RF_KORR_DRREL) is not decided here. Its '
            + `back-calculation does not read this setting — it always measures the way `
            + `${RATIO.label} does — and whether it is rewritten is WRITE RF KORR on the hub.`,
        noTabg: `No exhaust temperature in this log, so ${TABLE.label} cannot be selected.`,
        noRf: 'This log contains no relative filling value, so neither route can be used.',
    },
};

/**
 * The readout line's own words, English in both languages — like `Samples` and `Weight` beside it.
 *
 * This line is a machine readout: a formula, a measured Δ, a verdict and a sample count. The panel
 * keeps readout labels in one language and puts the reasoning behind the ⓘ, where it is written in
 * the reader's. Translating `routes` / `agree` would have made this the only readout on the panel
 * that changes width and vocabulary with the browser's locale, for no gain — what a reader needs in
 * their own language is why a disagreement matters and what to do about it, and that is in `hint`.
 */
const READOUT = { routes: 'routes', agree: 'agree', disagree: 'disagree', none: 'not comparable' } as const;

export const RfKorrSourceControl: React.FC<{
    source: RfKorrSource;
    onChange: (source: RfKorrSource) => void;
    /** The log carries an exhaust temperature, so the table route can index a Δ. */
    hasTabg: boolean;
    /** Both routes divide by or read RF; without it neither can be computed. */
    hasRf: boolean;
    readOnly?: boolean;
    /**
     * Mean |RF÷rf_soll − table(rpm,Δ)| over the samples where both exist, or undefined when they
     * cannot be compared. The number is the point: this is the only check the app has on an offset
     * nobody has confirmed on a car.
     */
    routeGap?: number;
    /** How many samples the gap was measured over. See the note beside where it renders. */
    routeSamples?: number;
    /** The `row(id)` bundle from the panel — the ⓘ label and its open/close state, so this row's
     *  explanation behaves exactly like its neighbours'. */
    id: string;
    infoLabel: string;
    open: boolean;
    onToggleInfo: () => void;
}> = ({
    source, onChange, hasTabg, hasRf, readOnly = false, routeGap, routeSamples,
    id, infoLabel, open, onToggleInfo,
}) => {
    const t = TEXT[useDialogLang()];
    const selected = ROUTES.find(r => r.id === source) ?? ROUTES[0];
    const gapOk = routeGap !== undefined && routeGap <= 0.02;

    return (
        <Row
            id={id}
            label={t.label}
            /* Plain, like its neighbours' values. The old labels were DME formula fragments
               and carried font-mono as machine data; these are the names of routes — app
               furniture, sans like every other label. The machine data (the formula itself)
               is on the readout line, which opens with the ⓘ. */
            value={selected.label}
            lockedReason={!hasRf ? t.noRf : !hasTabg ? t.noTabg : undefined}
            hint={t.hint}
            infoLabel={infoLabel}
            open={open}
            onToggleInfo={onToggleInfo}
        >
            {/* Two buttons rather than a slider, because this is the one setting in the panel that
                is a CHOICE and not a threshold. `min-h-10` for the same reason the neighbouring
                checkboxes carry `py-3 -my-3`: a 38px target. There is no small mark to keep small
                here, so the control simply takes the height. */}
            <div className="flex gap-1">
                {ROUTES.map(route => {
                    const locked = route.needs === 'tabg' ? !hasTabg : !hasRf;
                    return (
                        <button
                            key={route.id}
                            type="button"
                            disabled={readOnly || locked}
                            onClick={() => onChange(route.id)}
                            title={route.formula}
                            className={`flex-1 min-h-10 px-1 text-[9px] font-bold tracking-wider rounded ${source === route.id
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

            {/* One readout line, shown WITH the explanation and not before it (operator,
                2026-08-25): closed, this row is a label, a name and two buttons, like every other
                row in the panel.
                The formula leads it because it is the one description of this control that cannot
                drift from what the code does — it IS `ROUTES[…].formula` — and because it is the
                half of this line that answers to the buttons above. The route gap follows because
                it is a measurement about THIS log, and the sample count rides with it: the
                comparison only exists where the DME's correction was actually running, which on a
                road drive is a handful of samples out of thousands — a tight Δ over n=3 confirms
                nothing. Both halves are machine data, so the line is mono and its own words stay
                English while the paragraphs under it switch language. */}
            {open && (
            <p className="text-[9px] font-mono leading-snug pt-2">
                <span className="text-blue-400/80">{selected.formula}</span>
                <span className="text-slate-700"> · </span>
                <span className="text-slate-500 uppercase tracking-wider">{READOUT.routes}</span>{' '}
                {routeGap === undefined
                    ? <span className="text-slate-600">{READOUT.none}</span>
                    : (
                        <>
                            <span className="text-slate-400">Δ{routeGap.toFixed(3)}</span>{' '}
                            <span className={gapOk ? 'text-emerald-400/80' : 'text-red-400'}>
                                {gapOk ? READOUT.agree : READOUT.disagree}
                            </span>
                            {routeSamples !== undefined && (
                                <span className="text-slate-600">{' '}n={routeSamples}</span>
                            )}
                        </>
                    )}
            </p>
            )}
        </Row>
    );
};
