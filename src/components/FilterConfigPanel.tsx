import React, { useState, useEffect } from 'react';
import { X, Filter, Info } from 'lucide-react';
import {
    LogFilterConfig, RfKorrSource, resolveRfKorr, resolveTransientWindow,
    TRANSIENT_SETTLE_SEC_DEFAULT,
} from '@/lib/types';
import { RfKorrSourceControl } from './RfKorrSourceControl';
import { COVERAGE_OK_DEFAULT } from './MapEditor';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * Only the prose is here. The control names — RAW FILTER, Min Temp, Idle RPM Threshold, Transient
 * Filter, Max RO Delta — stay as they are: they are the instrument's vocabulary, the same words the
 * stored TuneSettings and the log columns use, and translating them would break that chain rather
 * than help. What gets translated is the text that explains something.
 *
 * ## How these are written
 *
 * Every explanation answers one question and only that one: **move this control, and what happens to
 * the accuracy of the VE correction?** Four parts, in this order —
 *
 *   1. what this control excludes (fact)
 *   2. why that sample cannot be used (mechanism)
 *   3. what raising and lowering it does (both directions)
 *   4. what to do about it on the next run, where there is something to do
 *
 * Subject and verb in every sentence. No metaphor — the actor is the DME, lambda control, the engine
 * or the filter, and it gets named. No implementation history, no internal variable names, no session
 * numbers; those belong in code comments, and they were what made the previous copy unreadable.
 *
 * One vocabulary, fixed: サンプル (not 点), 除外する (not 捨てる/外す), λ トリム (not トリム/補正),
 * VE 補正値, セルを書き換える, 純正値, 充填量.
 *
 * Mechanisms are only stated where they have been checked against the disassembly, the XDF or the
 * Funktionsrahmen. Min Temp and Cat Protect are two conditions of one mechanism — the lambda loop
 * not closing — and are written so that understanding either one explains the other.
 */
const TEXT = {
    ja: {
        settings: 'フィルター設定',
        locked: '固定 — このセッションは ECU に書き込み済みで、その ECU に入っているバイト列はこの設定から作られました。ここを動かすと記録が実物と食い違います。別のフィルターで調整するには「Use as base」で新しいセッションを開始してください。（保存しただけなら固定されません。）',
        immediate: '変更は即時反映されます',
        info: '説明を表示',

        minTempHint:
            'このフィルターは、冷却水温がこの値に達していないサンプルを除外します。\n'
            + 'DME は水温が 60 °C を超えるまで λ 制御を閉じません。それまでのあいだ λ トリムは更新されず、直前の値のまま保持されます。保持された値は、その時点の空気量とは対応していません。既定の 65 °C は、この 60 °C に対して余裕を取った値です。\n'
            + '値を上げると除外されるサンプルが増え、λ 制御が閉じていない区間の混入を確実に防げますが、使えるサンプル数は減ります。値を下げると、λ トリムが動き始めた直後のサンプルが混ざります。\n'
            + '水温が安定してから記録を開始すれば、このフィルターが除外するサンプルはほとんど無くなります。',

        idleHint:
            'このフィルターは、回転数がこの値より低く、かつスロットル開度がほぼ 0 のサンプルを除外します。\n'
            + 'DME は充填量が最も低い領域でだけ、噴射時間を 12〜30 % 増やしています。この増量は VE マップとは別のテーブルで決まっており、このツールはそのテーブルを書き換えません。λ 制御は閉じているため、λ トリムはこの増量を打ち消す方向に下がります。つまりこの領域の λ トリムは、空気量の誤差ではなく、意図的な増量を打ち消した結果です。\n'
            + 'VE マップにはこの領域のセルも存在します。しかしそのセルを λ トリムに合わせて動かすと、噴射側の増量を吸気側で相殺することになり、増量の意図そのものを失います。\n'
            + '値を上げると除外される範囲が広がり、低回転側のセルに残るサンプルが減ります。値を下げると、増量の影響を受けたサンプルが混ざります。停車時間の長いログで除外の割合が大きくなるのは、正常な結果です。',

        katsHint:
            'このフィルターは、排気温がこの値を超えた区間と、その後 20 秒間のサンプルを除外します。\n'
            + '排気温がこの値を超えると、DME は触媒を保護するために燃料を増量し、λ 制御を停止します。Min Temp と同じ機構です。λ 制御が停止しているあいだ λ トリムは更新されず、停止直前の値のまま保持されます。保持された値は、その時点の空気量とは対応していません。増量が抜けきるまでに時間がかかるため、排気温が下がってからの 20 秒も除外します。\n'
            + '値を下げると除外される区間が広がり、保持された λ トリムの混入を確実に防げますが、高負荷側のサンプルが減ります。値を上げると逆になります。',
        katsLocked: 'このログには排気温が記録されていないため、この設定は何も除外しません。',

        tankVentHint:
            'このフィルターは、タンク換気バルブが開いていたサンプルを除外します。\n'
            + 'バルブが開いているあいだ、燃料タンク内で発生した蒸発ガスがエンジンに入ります。DME はこのガスを噴射量として数えていないため、λ 制御は蒸発ガスの分だけ λ トリムを下げます。この λ トリムは λ 制御が正常に働いた結果ですが、次回の走行で同じ量の蒸発ガスが発生する保証はありません。\n'
            + '純正設定では 2500 rpm 以上・中負荷でバルブがほぼ連続して開くため、この設定を有効にするとログの大半が除外されることがあります。\n'
            + '走行前に PATCH でバルブを閉じておけば、この問題そのものが発生しません。この設定は、閉じずに記録したログを利用するためのものです。',
        tankVentLocked: 'このログにはタンク換気バルブの状態が記録されていないため、この設定は何も除外しません。',

        transientHint:
            'このフィルターは、回転数またはスロットル開度が変化している最中のサンプルを除外します。\n'
            + 'λ トリムは積分器です。空気量が変わっても即座には移動せず、新しい値に到達するまで時間がかかります。変化の最中に記録されたサンプルでは、λ トリムはまだ移動の途中にあり、変化後の空気量に対応した値になっていません。',

        settleHint:
            'この値は、回転数やアクセル開度が変化してから何秒後のサンプルを使うかを決めます。\n'
            + 'DME は燃料の調整に 1〜2 秒かかります。その間のサンプルでは、λ トリムはまだ目標の値に届いていません。\n'
            + '判定は時刻で行うため、通信の速さが変わっても待つ時間は変わりません。\n'
            + '値を上げると除外されるサンプルが増え、残ったサンプルでは DME の調整が終わっています。値を下げると、調整の途中のサンプルが混ざります。',

        rpmDeltaHint:
            'この値は、Settle Time で指定した時間のあいだに回転数が何 % 変化したら「変化した」と判定するかを決めます。\n'
            + '判定は平均ではなく、その時間だけ前にある 1 サンプルとの比較です。比較するのは過去だけなので、変化が始まった瞬間のサンプルは通過し、そのあとが除外されます。\n'
            + '値を下げると除外されるサンプルが増え、残ったサンプルは定常状態に近くなりますが、使えるサンプル数は減ります。値を上げると逆になります。',

        roDeltaHint:
            'この値は、Max RPM Delta と同じ判定をアクセル開度に対して行います。\n'
            + '回転数側が変化率（%）で指定するのに対し、こちらは開度の絶対差（% ポイント）で指定します。',

        covIntro:
            'ここから下の設定は、除外するサンプルではなく、書き換えてよいセルを決めます。条件を満たさなかったセルは、純正値のまま 1 バイトも変更されません。',
        covVe: 'VE Cell Gate',
        covVeHint:
            'この設定は、1 つのセルを書き換えるために必要なサンプル数と重みを決めます。\n'
            + 'サンプルは走行中のどの時点のものでもよく、連続している必要はありません。合計がこの値に達すれば条件を満たします。\n'
            + '重みを別に指定するのは、1 つのサンプルが周囲 4 つのセルに分配されるためです。セルの中心付近で記録されたサンプルはそのセルに大きな重みを与え、境界付近で記録されたサンプルは 4 つに分散します。したがってサンプル数だけでは、そのセルにどれだけの情報が入ったかを表せません。\n'
            + '値を上げると書き換えられるセルが減り、書き換えられたセルは平均に使うサンプルが増えるぶん値が安定します。値を下げると逆になります。',
        covRf: 'RF KORR Cell Gate',
        covRfHint:
            'この設定は、補正テーブルのセルに同じ条件を課します。\n'
            + '補正テーブルは 72 セル、VE マップは 480 セルです。1 セルが結果に与える影響が大きいため、VE マップとは別の値を持たせています。',
        covBands: 'Covered At',
        covBandsHint:
            'この設定は、ヒートマップの色分けだけを決めます。計算には影響しません。\n'
            + 'ヒートマップは 3 段階です。薄い色は「通ったが、ゲートを通らなかった」セル。中間色は「ゲートを通り、書き換えられた」セル。濃い色は、この値に達して「もうこの領域を走らなくてよい」セルです。\n'
            + '薄い色と中間色の境目は VE Cell Gate のサンプル数そのものです。ゲートが採用したセルが薄いままだと、色と計算が食い違うためです。したがってここで決めるのは、濃い色に変わる点だけです。\n'
            + 'ゲートは「このセルを書き換えてよいか」、この値は「この領域をこれ以上走らなくてよいか」を答えます。後者のほうが高い基準なので、既定はゲートよりかなり上に置いています。',
        bandsLegend: (gate: number, ok: number) =>
            `薄い = 1〜${gate - 1} · 中間 = ${gate}〜${ok - 1}（書き換え済み）· 濃い = ${ok} 以上`,
        subSamples: 'Samples',
        subWeight: 'Weight',
        gateOff:
            'ゲートを無効にしました。1 サンプルしか記録されていないセルもマップに書き込まれます。下に表示される採用セル数が、この設定による変化を示します。',
    },
    en: {
        settings: 'Filter Settings',
        locked: 'Locked — this session has been written to the ECU, and the bytes in it were built from these settings. Changing them here would make the record disagree with the car. Use as base to start a new session and tune with different filters. (Saving alone does not lock anything.)',
        immediate: 'Adjustments apply immediately',
        info: 'Show explanation',

        minTempHint:
            'This filter excludes samples recorded before the coolant reached this temperature.\n'
            + 'The DME does not close the lambda loop until the coolant is above 60 °C. Until then the lambda trim is not updated: it holds the value it had before. That held value does not correspond to the air flow at the time it was recorded. The default of 65 °C leaves a margin above that 60 °C threshold.\n'
            + 'Raising this value excludes more samples and reliably keeps the open-loop stretch out of the result, but leaves fewer samples to work with. Lowering it admits samples taken just after the lambda trim started moving again.\n'
            + 'Starting the log after the coolant temperature has stabilised leaves almost nothing for this filter to exclude.',

        idleHint:
            'This filter excludes samples taken below this engine speed with the throttle essentially closed.\n'
            + 'In the lowest filling region the DME deliberately increases injection time by 12 to 30 %. That increase comes from a table separate from the VE map, and this tool does not write it. Lambda control is closed, so the lambda trim falls to cancel the increase. The lambda trim in this region is therefore the result of cancelling a deliberate enrichment, not of an air-flow error.\n'
            + 'The VE map does contain cells for this region. Moving those cells to satisfy the lambda trim would cancel an injection-side enrichment on the air side, which removes the effect the enrichment was there to produce.\n'
            + 'Raising this value widens the excluded range and leaves fewer samples in the low-speed cells. Lowering it admits samples affected by the enrichment. A log with long stops losing a large share of its samples here is the expected result.',

        katsHint:
            'This filter excludes samples taken above this exhaust temperature, and those taken in the 20 s that follow.\n'
            + 'Above this temperature the DME adds fuel to protect the catalyst and suspends lambda control — the same mechanism as Min Temp. While lambda control is suspended the lambda trim is not updated: it holds the value it had when control stopped. That held value does not correspond to the air flow at the time it was recorded. The enrichment takes time to clear, which is why the 20 s after the temperature falls are excluded as well.\n'
            + 'Lowering this value widens the excluded stretch and reliably keeps a held lambda trim out of the result, but leaves fewer high-load samples. Raising it does the opposite.',
        katsLocked: 'This log contains no exhaust temperature, so this setting excludes nothing.',

        tankVentHint:
            'This filter excludes samples recorded while the tank ventilation valve was open.\n'
            + 'While the valve is open, vapour formed in the fuel tank enters the engine. The DME does not count that vapour as injected fuel, so lambda control lowers the lambda trim by the corresponding amount. The lambda trim is the correct output of a working control loop, but there is no guarantee that the same quantity of vapour will be present on the next drive.\n'
            + 'With stock settings the valve is open almost continuously above 2500 rpm at mid load, so enabling this setting can exclude most of a log.\n'
            + 'Shutting the valve for the run with PATCH prevents the problem altogether. This setting exists to make use of a log recorded without it.',
        tankVentLocked: 'This log contains no tank ventilation channel, so this setting excludes nothing.',

        transientHint:
            'This filter excludes samples recorded while engine speed or throttle opening was still changing.\n'
            + 'The lambda trim is an integrator. It does not step to a new value when the air flow changes; it takes time to arrive. In a sample recorded during that movement the lambda trim is still part-way there, and does not correspond to the air flow after the change.',

        settleHint:
            'This value sets how long after a change in engine speed or throttle opening a sample may be used.\n'
            + 'The DME takes one to two seconds to complete a fuel adjustment. In a sample taken during that time, the lambda trim has not yet reached its target.\n'
            + 'The test is made on timestamps, so the waiting time stays the same whatever the link speed.\n'
            + 'Raising this value excludes more samples and leaves only those where the DME had finished adjusting. Lowering it admits samples taken mid-adjustment.',

        rpmDeltaHint:
            'This value sets how much engine speed may change, as a percentage, over the Settle Time before the sample counts as having changed.\n'
            + 'The test is not an average: it compares against the single sample taken that long earlier. It also looks only backwards, so the sample at the instant a change begins passes and the ones after it are excluded.\n'
            + 'Lowering this value excludes more samples and leaves the remainder closer to steady state, but reduces how many samples are available. Raising it does the opposite.',

        roDeltaHint:
            'This value applies the same test as Max RPM Delta to throttle opening.\n'
            + 'Engine speed is tested as a percentage change; throttle opening is tested as an absolute difference in opening percent.',

        covIntro:
            'The settings below do not decide which samples to exclude. They decide which cells may be rewritten. A cell that does not meet the condition keeps its stock value, byte for byte.',
        covVe: 'VE Cell Gate',
        covVeHint:
            'These values set how many samples, and how much weight, a cell needs before it may be rewritten.\n'
            + 'The samples may come from any point in the drive and do not have to be consecutive. The condition is met once the totals reach these values.\n'
            + 'Weight is specified separately because each sample is distributed across the four cells surrounding it. A sample recorded near the centre of a cell gives that cell most of its weight; a sample recorded near a boundary is split across four. A sample count alone therefore does not describe how much information a cell received.\n'
            + 'Raising these values rewrites fewer cells, and each rewritten cell is averaged over more samples, so its value is more stable. Lowering them does the opposite.',
        covRf: 'RF KORR Cell Gate',
        covRfHint:
            'These values apply the same condition to the cells of the correction table.\n'
            + 'The correction table has 72 cells; the VE map has 480. One cell of the correction table therefore carries far more of the result, which is why it has its own values.',
        covBands: 'Covered At',
        covBandsHint:
            'This value sets the colouring of the heatmap only. It does not affect the calculation.\n'
            + 'The heatmap has three levels. The faintest means the cell was visited but did not clear the gate. The middle one means it cleared the gate and was rewritten. The strongest means it reached this value, and the area needs no more driving.\n'
            + 'The boundary between the first two is the VE Cell Gate\'s own sample count, because a cell the gate accepted must not still be painted as thin — the colour and the calculation would be saying different things. So the only thing left to set here is where the strongest level begins.\n'
            + 'The gate answers whether a cell may be rewritten; this value answers whether an area has been driven enough to move on from. The second is the higher bar, which is why the default sits well above the gate.',
        bandsLegend: (gate: number, ok: number) =>
            `faint = 1-${gate - 1} · mid = ${gate}-${ok - 1} (rewritten) · full = ${ok}+`,
        subSamples: 'Samples',
        subWeight: 'Weight',
        gateOff:
            'The gate is off. A cell holding a single sample will be written into the map. The accepted-cell count shown below is what this setting changed.',
    },
};

interface Props {
    config: LogFilterConfig;
    onConfigChange: (newConfig: LogFilterConfig) => void;
    /** Archived — i.e. FLASHED — sessions show the settings their tune was built with, but must not
     *  re-derive it: those bytes are in an ECU and the record has to keep describing them.
     *
     *  A saved-but-unflashed session is NOT archived and NOT read-only. Saving is how a live run is
     *  persisted at all, so locking on save meant the only way to keep a drive was to give up
     *  adjusting the filters it would be read through. */
    readOnly?: boolean;
    /** Open above the trigger instead of below it. The mobile footer sits at the bottom edge, so a
     *  popover hanging `top-10` off a control down there opens off-screen. */
    openUp?: boolean;
    /**
     * Which channels the loaded log actually carries.
     *
     * Decided by the page, which is the only place that can see the log at all. Every control whose
     * effect depends on a channel is disabled when that channel is absent — a filter that silently
     * does nothing is worse than one that says it cannot.
     */
    channels?: { tabg: boolean; tankVent: boolean; rf: boolean; stft: boolean };
    /** This log's measured sample rate, for the "≈ n samples" beside the settle time. Display only:
     *  the filter itself works on timestamps and never converts. */
    measuredHz?: number;
    /** Mean gap between the two rf_korr routes over this log, or undefined when they cannot be
     *  compared. The one check the app has on a DS2 offset nobody has confirmed on a car. */
    routeGap?: number;
    routeSamples?: number;
}

/**
 * One control, one shape.
 *
 * Everything in this panel is the same object: a name, a value, an optional on/off, sliders, and an
 * explanation that is out of the way until asked for. Before this there were three shapes — sliders
 * with a permanent paragraph under them, a bare checkbox, and a pair of number inputs — and the
 * paragraphs alone ran the panel to twice the height of a phone.
 *
 * The explanation lives behind the ⓘ and never in a `title`. Chrome for Android surfaces `title` on
 * neither tap nor long-press, so an explanation put there does not exist on the device this panel is
 * read on. The disabled reason is the exception and is always visible: a control that cannot be
 * pressed has to say why without being asked.
 */
const Row: React.FC<{
    id: string;
    label: string;
    value?: React.ReactNode;
    /** Omitted for a row with no on/off of its own. */
    toggle?: { checked: boolean; onChange: (v: boolean) => void; accent?: string };
    /** Non-empty means the control is inert on this log, and says so. */
    lockedReason?: string;
    hint: string;
    infoLabel: string;
    open: boolean;
    onToggleInfo: () => void;
    children?: React.ReactNode;
}> = ({ id, label, value, toggle, lockedReason, hint, infoLabel, open, onToggleInfo, children }) => {
    const on = toggle ? toggle.checked : true;
    const live = on && !lockedReason;
    return (
        <div className="space-y-1" data-filter-row={id}>
            <div className="flex justify-between items-center gap-2 text-[10px] text-slate-500 uppercase tracking-wider">
                {toggle ? (
                    <label className={`py-3 -my-3 flex items-center gap-2 min-w-0 ${lockedReason ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                        <input
                            type="checkbox"
                            checked={toggle.checked}
                            disabled={!!lockedReason}
                            onChange={(e) => toggle.onChange(e.target.checked)}
                            className={`w-3 h-3 rounded bg-slate-700 border-none shrink-0 ${toggle.accent ?? 'accent-blue-500'} disabled:opacity-40`}
                        />
                        <span className={`truncate ${lockedReason ? 'text-slate-700' : ''}`}>{label}</span>
                    </label>
                ) : (
                    <span className="truncate">{label}</span>
                )}
                <span className="flex items-center gap-1 shrink-0">
                    {value !== undefined && (
                        <span className={live ? 'text-slate-300' : 'text-slate-600'}>{value}</span>
                    )}
                    <button
                        type="button"
                        onClick={onToggleInfo}
                        aria-expanded={open}
                        aria-label={infoLabel}
                        className={`p-1.5 -mr-1.5 rounded transition-colors ${open ? 'text-blue-400' : 'text-slate-600 hover:text-slate-400'}`}
                    >
                        <Info className="w-3 h-3" />
                    </button>
                </span>
            </div>
            {children}
            {/* Above the explanation, not inside it: the reason a control cannot be used is not
                background reading. */}
            {lockedReason && (
                <p className="text-[9px] text-amber-500/80 leading-snug">{lockedReason}</p>
            )}
            {open && (
                <p className="text-[9px] text-slate-500 leading-relaxed whitespace-pre-line pt-0.5">{hint}</p>
            )}
        </div>
    );
};

/** The rendered width of the thumb, from globals.css. Needed here to know where it is. */
const THUMB_PX = 18;

/**
 * A slider that only moves when you grab the thumb.
 *
 * A native range input jumps to wherever the track is pressed. That is fine for a volume control and
 * wrong for these: the panel is read at arm's length in a car, the sliders sit four to a screen, and
 * a press that lands 20px off the thumb does not miss — it silently sets a new evidence threshold
 * and re-derives the map. There is no undo, and nothing announces it.
 *
 * So a press outside the thumb is cancelled. `preventDefault` on pointerdown suppresses both the
 * jump and the drag that would follow it, which leaves the press doing exactly nothing. Keyboard
 * adjustment is untouched — arrow keys never went through this path — so the control stays operable
 * without a pointer.
 *
 * The tolerance is one thumb width either side, not half: fingers are wider than cursors, and the
 * failure this prevents is expensive while the failure it introduces — having to press again, a
 * little closer — is not.
 */
const Slider: React.FC<{
    min: number; max: number; step?: number; value: number; disabled?: boolean;
    accent?: string; onChange: (v: number) => void;
}> = ({ min, max, step, value, disabled, accent = 'accent-blue-500', onChange }) => (
    <input
        type="range"
        min={min} max={max} step={step}
        disabled={disabled}
        value={value}
        onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            // The thumb's centre travels between half a thumb in from each end, never to the edges.
            const frac = max > min ? (value - min) / (max - min) : 0;
            const centre = r.left + THUMB_PX / 2 + frac * (r.width - THUMB_PX);
            if (Math.abs(e.clientX - centre) > THUMB_PX) e.preventDefault();
        }}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`w-full h-1 rounded-lg appearance-none touch-none ${disabled ? 'bg-slate-800 accent-slate-600' : `bg-slate-700 ${accent}`}`}
    />
);

/**
 * One number inside a group that shares a switch.
 *
 * The VE and RF KORR gates are two numbers each, and stacking their sliders with one shared label
 * put two 18px thumbs four pixels apart with nothing saying which was which. Each gets its own name,
 * its own readout and its own line.
 */
const SubField: React.FC<{ label: string; value: string; dim?: boolean; children: React.ReactNode }> = (
    { label, value, dim, children },
) => (
    <div className="space-y-1.5">
        <div className="flex justify-between items-baseline text-[9px] uppercase tracking-wider">
            <span className={dim ? 'text-slate-700' : 'text-slate-500'}>{label}</span>
            <span className={dim ? 'text-slate-700' : 'text-slate-400 font-mono'}>{value}</span>
        </div>
        {children}
    </div>
);

const NO_CHANNELS = { tabg: false, tankVent: false, rf: false, stft: false } as const;

export const FilterConfigPanel: React.FC<Props> = ({
    config, onConfigChange, readOnly = false, openUp, channels = NO_CHANNELS, measuredHz,
    routeGap, routeSamples,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [localConfig, setLocalConfig] = useState<LogFilterConfig>(config);
    const t = TEXT[useDialogLang()];

    /** Which explanations are open. A Set rather than one at a time: these are read against each
     *  other — Min Temp and Cat Protect are the same mechanism — and a panel that shuts the last one
     *  every time you open the next cannot be read that way. */
    const [infoFor, setInfoFor] = useState<ReadonlySet<string>>(() => new Set());
    const toggleInfo = (id: string) => setInfoFor(prev => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
    });

    // Sync local config if prop changes (reset)
    useEffect(() => {
        setLocalConfig(config);
    }, [config]);

    const rfKorrSource = resolveRfKorr(localConfig).source;

    /** Writes the source AND clears the two fields it supersedes.
     *
     *  Cleared rather than kept in step, which is the opposite of what the old three-way did. Those
     *  fields are now read ONLY when `rfKorrSource` is absent (see resolveRfKorr), so leaving a
     *  stale `rfKorrMode: 'tuned'` behind would be a second, invisible opinion about the table
     *  write — and `storedWriteRfKorr` consults exactly that field when reconstructing an old
     *  session. A config that carries the current field must not also answer the legacy question. */
    const setRfKorrSource = (source: RfKorrSource) => {
        if (readOnly) return;
        const newCfg: LogFilterConfig = { ...localConfig, rfKorrSource: source };
        delete newCfg.rfKorrMode;
        delete newCfg.applyRfKorr;
        setLocalConfig(newCfg);
        onConfigChange(newCfg);
    };

    const handleChange = (key: keyof LogFilterConfig, value: number | boolean) => {
        if (readOnly) return;
        // @ts-ignore
        const newCfg = { ...localConfig, [key]: value };
        setLocalConfig(newCfg);
        onConfigChange(newCfg);
    };

    const row = (id: string) => ({
        id,
        infoLabel: t.info,
        open: infoFor.has(id),
        onToggleInfo: () => toggleInfo(id),
    });

    const settleSec = localConfig.transientSettleSec ?? TRANSIENT_SETTLE_SEC_DEFAULT;
    const settleSamples = resolveTransientWindow({ ...localConfig, transientSettleSec: settleSec }, measuredHz);
    const veGateOn = localConfig.enableVeCellGate ?? true;
    const rfGateOn = localConfig.enableRfKorrCellGate ?? true;
    const veSamples = localConfig.minVeCellSamples ?? 10;
    const veWeight = localConfig.minVeCellWeight ?? 5;
    const rfSamples = localConfig.rfKorrMinCellSamples ?? 10;
    const rfWeight = localConfig.rfKorrMinCellWeight ?? 5;
    const coveredAt = localConfig.coverageOk ?? COVERAGE_OK_DEFAULT;

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`p-2 rounded text-slate-400 hover:text-blue-400 transition-colors ${isOpen ? 'text-blue-400 bg-slate-800' : 'hover:bg-slate-800'}`}
                title={t.settings}
            >
                <Filter className="w-4 h-4" />
            </button>

            {isOpen && (
                <>
                    {/* Backdrop to close */}
                    <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />

                    {/* Popover Panel */}
                    <div className={`${openUp ? 'fixed inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),494px)] overflow-y-auto overscroll-contain' : 'absolute right-0 top-10 w-[280px] max-h-[min(70dvh,494px)] overflow-y-auto overscroll-contain'} bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 p-4 animate-in fade-in zoom-in-95 duration-200`}>
                        <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-2">
                            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                                <Filter className="w-3 h-3" />
                                RAW FILTER
                            </h3>
                            <button
                                onClick={() => setIsOpen(false)}
                                className="text-slate-500 hover:text-slate-300"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {readOnly && (
                            <p className="mb-3 text-[9px] font-mono text-amber-500/80 leading-relaxed">
                                {t.locked}
                            </p>
                        )}

                        <div className={`space-y-4 ${readOnly ? 'opacity-60 pointer-events-none select-none' : ''}`}>
                            <Row
                                {...row('minTemp')}
                                label="Min Temp"
                                value={`${localConfig.minTemp}°C`}
                                toggle={{ checked: localConfig.enableMinTemp, onChange: v => handleChange('enableMinTemp', v) }}
                                hint={t.minTempHint}
                            >
                                <Slider min={0} max={100} value={localConfig.minTemp}
                                    disabled={!localConfig.enableMinTemp}
                                    onChange={v => handleChange('minTemp', v)} />
                            </Row>

                            <Row
                                {...row('idle')}
                                label="Idle RPM Threshold"
                                value={`${localConfig.idleRpm} RPM`}
                                toggle={{ checked: localConfig.enableIdle, onChange: v => handleChange('enableIdle', v) }}
                                hint={t.idleHint}
                            >
                                <Slider min={500} max={2000} step={50} value={localConfig.idleRpm}
                                    disabled={!localConfig.enableIdle}
                                    onChange={v => handleChange('idleRpm', v)} />
                            </Row>

                            {/* Defaults ON (`?? true` in the filter), so a session saved before this
                                field existed behaves the same as a new one rather than silently
                                keeping frozen-trim rows. */}
                            <Row
                                {...row('kats')}
                                label="Cat Protect EGT"
                                value={`${localConfig.katsTabgOn ?? 850} °C`}
                                toggle={{ checked: localConfig.enableOpenLoopExclusion ?? true, onChange: v => handleChange('enableOpenLoopExclusion', v) }}
                                lockedReason={channels.tabg ? undefined : t.katsLocked}
                                hint={t.katsHint}
                            >
                                {/* 700 °C is well below anything that arms the enrichment; 950 is
                                    above the sensor's useful working range here. The stock
                                    K_TI_KATS_TABG_EIN sits at 850, mid-scale. */}
                                <Slider min={700} max={950} step={10} value={localConfig.katsTabgOn ?? 850}
                                    disabled={!(localConfig.enableOpenLoopExclusion ?? true) || !channels.tabg}
                                    onChange={v => handleChange('katsTabgOn', v)} />
                            </Row>

                            {/* Defaults OFF, unlike Cat Protect above — see LogFilterConfig. No
                                slider: the threshold exists in the config for a car whose valve reads
                                a small non-zero at rest, but the useful setting is "anything the DME
                                calls open", and a control offering a number here would imply there
                                is a good one to pick. */}
                            <Row
                                {...row('tankVent')}
                                label="Tank Vent"
                                value={`> ${localConfig.tankVentMaxMs ?? 0} ms`}
                                toggle={{ checked: localConfig.enableTankVentExclusion ?? false, onChange: v => handleChange('enableTankVentExclusion', v) }}
                                lockedReason={channels.tankVent ? undefined : t.tankVentLocked}
                                hint={t.tankVentHint}
                            />

                            {/* COVERAGE — a section, not another row, because these answer a
                                different question from everything above them. The row filters decide
                                which samples survive; these decide which CELLS may be rewritten from
                                the samples that did. Mixing them into one list is how the map ended
                                up with no evidence gate at all while looking like it had one. */}
                            <div className="pt-3 mt-1 border-t border-slate-800/60 space-y-4">
                                <div>
                                    <div className="text-[10px] text-slate-400 uppercase tracking-wider">COVERAGE</div>
                                    <p className="text-[9px] text-slate-600 mt-0.5 leading-relaxed">{t.covIntro}</p>
                                </div>

                                <Row
                                    {...row('veGate')}
                                    label={t.covVe}
                                    toggle={{ checked: veGateOn, onChange: v => handleChange('enableVeCellGate', v) }}
                                    hint={t.covVeHint}
                                >
                                    <div className="space-y-3 pt-1">
                                        {/* Ceiling from the measurement in MapEditor: session #902
                                            put 130 samples in its busiest cell of 480, so a
                                            threshold of 200 could not be met by any drive at all. */}
                                        <SubField label={t.subSamples} dim={!veGateOn} value={`${veSamples}`}>
                                            <Slider min={1} max={100} value={veSamples}
                                                disabled={!veGateOn} onChange={v => handleChange('minVeCellSamples', v)} />
                                        </SubField>
                                        <SubField label={t.subWeight} dim={!veGateOn} value={veWeight.toFixed(1)}>
                                            <Slider min={0.5} max={30} step={0.5} value={veWeight}
                                                disabled={!veGateOn} onChange={v => handleChange('minVeCellWeight', v)} />
                                        </SubField>
                                    </div>
                                    {!veGateOn && <p className="text-[9px] text-red-400 leading-snug">{t.gateOff}</p>}
                                </Row>

                                <Row
                                    {...row('rfGate')}
                                    label={t.covRf}
                                    toggle={{ checked: rfGateOn, onChange: v => handleChange('enableRfKorrCellGate', v) }}
                                    hint={t.covRfHint}
                                >
                                    <div className="space-y-3 pt-1">
                                        <SubField label={t.subSamples} dim={!rfGateOn} value={`${rfSamples}`}>
                                            <Slider min={1} max={100} value={rfSamples}
                                                disabled={!rfGateOn} onChange={v => handleChange('rfKorrMinCellSamples', v)} />
                                        </SubField>
                                        <SubField label={t.subWeight} dim={!rfGateOn} value={rfWeight.toFixed(1)}>
                                            <Slider min={0.5} max={30} step={0.5} value={rfWeight}
                                                disabled={!rfGateOn} onChange={v => handleChange('rfKorrMinCellWeight', v)} />
                                        </SubField>
                                    </div>
                                    {!rfGateOn && <p className="text-[9px] text-red-400 leading-snug">{t.gateOff}</p>}
                                </Row>

                                {/* One number, not two. The lower band is the VE gate — see
                                    coverageThin — so there is nothing left to set but the point at
                                    which a cell is done. No on/off either: this colours the heatmap
                                    and gates nothing, so there is no behaviour to switch off. */}
                                <Row
                                    {...row('bands')}
                                    label={t.covBands}
                                    value={`${coveredAt}`}
                                    hint={t.covBandsHint}
                                >
                                    <Slider min={10} max={1000} step={10} value={coveredAt}
                                        onChange={v => handleChange('coverageOk', v)} />
                                    <p className="text-[9px] text-slate-600 leading-snug pt-0.5">
                                        {t.bandsLegend(veGateOn ? veSamples : 1, coveredAt)}
                                    </p>
                                </Row>
                            </div>

                            {/* RF KORR — not a filter, but it belongs to "how this log becomes a
                                map" and has to travel with the session for the tune to be
                                reproducible, which is why it is in this panel at all. */}
                            <RfKorrSourceControl
                                source={rfKorrSource}
                                onChange={setRfKorrSource}
                                hasTabg={channels.tabg}
                                hasRf={channels.rf}
                                readOnly={readOnly}
                                routeGap={routeGap}
                                routeSamples={routeSamples}
                            />

                            <div className="pt-3 border-t border-slate-800 space-y-4">
                                <Row
                                    {...row('transient')}
                                    label="Transient Filter"
                                    toggle={{ checked: localConfig.enableTransient, onChange: v => handleChange('enableTransient', v), accent: 'accent-orange-500' }}
                                    hint={t.transientHint}
                                />

                                <div className={`space-y-4 ${!localConfig.enableTransient ? 'opacity-50 pointer-events-none' : ''}`}>
                                    <Row
                                        {...row('settle')}
                                        label="Settle Time"
                                        value={settleSamples === undefined
                                            ? `${settleSec.toFixed(1)} s`
                                            : `${settleSec.toFixed(1)} s ≈ ${settleSamples}`}
                                        hint={t.settleHint}
                                    >
                                        <Slider min={0.5} max={5} step={0.5} value={settleSec}
                                            accent="accent-orange-500"
                                            onChange={v => handleChange('transientSettleSec', v)} />
                                    </Row>

                                    <Row
                                        {...row('rpmDelta')}
                                        label="Max RPM Delta"
                                        value={`${localConfig.rpmStableThreshold}%`}
                                        hint={t.rpmDeltaHint}
                                    >
                                        <Slider min={1} max={50} value={localConfig.rpmStableThreshold}
                                            accent="accent-orange-500"
                                            onChange={v => handleChange('rpmStableThreshold', v)} />
                                    </Row>

                                    <Row
                                        {...row('roDelta')}
                                        label="Max RO Delta"
                                        value={`${localConfig.tpsStableThreshold}%`}
                                        hint={t.roDeltaHint}
                                    >
                                        <Slider min={1} max={50} value={localConfig.tpsStableThreshold}
                                            accent="accent-orange-500"
                                            onChange={v => handleChange('tpsStableThreshold', v)} />
                                    </Row>
                                </div>
                            </div>
                        </div>

                        <div className="mt-4 pt-3 border-t border-slate-800 text-center">
                            <span className="text-[10px] text-slate-600">{t.immediate}</span>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};
