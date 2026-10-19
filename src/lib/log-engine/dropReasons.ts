import type { DialogLang } from '@/lib/dialog-text';
import type { DropCensus, DropReason } from './lambdaGates';

/**
 * What each reason a sample was left out is called, and what it means for the next drive.
 *
 * Two readers, one text. The census line and its sheet (DropCensus.tsx) show it to the driver
 * standing next to the car; the assistant bridge's `tuner_status` hands it to the owner's assistant,
 * which says it to the same driver out loud. Written once here so the two cannot drift: an assistant
 * reading a sentence the sheet no longer shows would be giving advice the app has withdrawn.
 *
 * The names stay put across languages, because they are the instrument's vocabulary; the
 * explanations follow the reader, because they are what the reader has to act on.
 */

/** Short enough for a phone, and the same vocabulary the docs and the filter panel use. */
export const DROP_LABEL: Record<DropReason, string> = {
    coldEngine: 'cold',
    idle: 'idle',
    transient: 'transient',
    catProtect: 'cat protect',
    fullLoad: 'full load',
    controllerStop: 'la stop',
    fuelCut: 'overrun',
    highLoadSettle: 'short pull',
    settle: 'unsettled',
    excluded: 'excluded',
    linkGap: 'link gap',
    lambdaRamp: 'lambda ramp',
};

/**
 * The one sentence that says what to DO about each, in the reader's language.
 *
 * Same rules as the filter panel's explanations: what was excluded, why that sample cannot be used,
 * and what to do about it next time. One vocabulary across both — a reader who has read the panel
 * should recognise every word here.
 */
export const DROP_WHY: Record<DialogLang, Record<DropReason, string>> = {
    en: {
        coldEngine: 'The DME does not close the lambda loop below 60 °C, so the lambda trim was not being updated. Let the coolant reach temperature before starting the log.',
        idle: 'At the lowest filling the DME adds 12-30 % more fuel from a table this tool does not write, and the lambda trim falls to cancel it. Not a fault, and not information about air flow.',
        transient: 'Engine speed or throttle was still changing, so the lambda trim had not finished moving to its new value. Hold a steady pedal for longer.',
        catProtect: 'The DME was enriching to protect the catalyst, which suspends lambda control — the trim held its last value. Includes the 20 s the enrichment takes to clear.',
        fullLoad: 'Past the DME\'s full-load threshold, where lambda control is switched off. The WOT TH patch keeps it running.',
        controllerStop: 'The lambda trim was pinned at its own limit, so it reports "at least this much" rather than a measurement.',
        fuelCut: 'You lifted off in gear and the DME shut the injectors, so there was no mixture to measure and the trim parked at exactly 1.000. Nothing to fix — every drive contains these, and counting them as "this cell is perfect" is what this removes.',
        highLoadSettle: 'The pull was too fresh. Above 55 % filling the DME steps its exhaust-temperature correction up off a sensor that lags, and the lambda trim needs about six seconds to walk after it — until then the reading is high by whatever it has not covered. Hold the pull longer: two drives disagreed by 5 % at high load until the short-pull samples came out.',
        settle: 'The operating point was still moving a settle ago, so the two things rf_korr is a ratio OF were measured at different air flows. This does not touch the VE map: the sample stays in the log and can still earn a cell. Hold a steady throttle for longer than Settle Time if the rf_korr table is what you are after.',
        excluded: 'You took this stretch out of the drive, because it disagreed with the rest of it. Nothing is wrong with these samples except that they belong to a different population; RESTORE on the map tab puts them back.',
        linkGap: 'The link to the DME dropped during the run and the app reconnected. For the first two seconds after that, the only sample to compare against is one from before the gap, so nothing can say the engine was steady. Check the cable, the OBD connector and the USB lead — how you drove did not cause this.',
        lambdaRamp: 'The lambda trim was still ramping back from a fuel cut, a loop restart or an rf_korr step, so it read the seconds since then rather than the map. After a lift-off or a tip-in, hold the pedal steady for a few seconds — the cell counts from there.',
    },
    ja: {
        coldEngine: '水温 60 °C 未満では DME が λ 制御を閉じないため、λ トリムが更新されていません。水温が上がってからログを開始してください。',
        idle: '最低充填では、本ツールが書き換えない表から DME が 12〜30 % 増量し、λ トリムがそれを打ち消すぶん下がります。故障ではなく、空気量についての情報でもありません。',
        transient: '回転数かスロットルがまだ変化していて、λ トリムが新しい値へ移動し終えていません。ペダルをもっと長く一定に保ってください。',
        catProtect: '触媒保護のために DME が増量しており、その間 λ 制御は停止してトリムは直前の値を保持します。増量が抜けるまでの 20 秒も含みます。',
        fullLoad: 'DME の全負荷閾値を超えた区間で、λ 制御が切られています。WOT TH パッチはこれを生かし続けるためのものです。',
        controllerStop: 'λ トリムが自身の上下限に張り付いていました。「少なくともこれだけ」という表示であって、測定値ではありません。',
        fuelCut: 'ギアを入れたままアクセルを戻し、DME が噴射を止めた区間です。混合気が無いので測るものが無く、トリムはちょうど 1.000 で止まります。直すものはありません — どの走行にも必ず含まれ、これを「このセルは完璧」と数えないための除外です。',
        highLoadSettle: '引きが新しすぎます。充填 55 % を超えると DME は排気温補正を一段上げますが、その元になるセンサーは遅れて読むため、λ トリムが追いつくのに約 6 秒かかります。それまでの値は、追いつけていない分だけ高く出ます。引きをもっと長く保持してください — 2 本の走行が高負荷で 5 % 食い違い、この短い引きを除いて一致しました。',
        settle: 'Settle Time だけ前の時点で、まだ回転数か開度が動いていました。rf_korr は 2 つの量の比なので、その 2 つが別々の空気量で測られたことになります。VE マップには影響しません — このサンプルはログに残り、セルの根拠にもなります。rf_korr の表が目的なら、Settle Time より長くアクセルを一定に保ってください。',
        excluded: '走行の一部を、残りの区間と食い違うという理由であなたが除外しました。サンプル自体に問題はなく、別の母集団に属しているというだけです。マップタブの RESTORE で戻せます。',
        linkGap: '走行中に DME とのリンクが切れ、アプリが再接続しました。再接続から 2 秒のあいだは、比べられるサンプルが途切れる前のものしかなく、エンジンが落ち着いていたとは言えません。ケーブル・OBD コネクタ・USB の接続を確認してください — 走り方が原因ではありません。',
        lambdaRamp: '燃料カット・ループ再始動・rf_korr の段差のあとで λ トリムがまだ戻る途中にあり、マップではなく経過秒数を読んでいました。アクセルを戻した後や踏み込んだ後は、数秒ペダルを一定に保ってください — そこからがセルに数えられます。',
    },
};

/** The reasons that left anything out, most first — the order the line and its sheet show them in. */
export function droppedReasons(census: DropCensus): (readonly [DropReason, number])[] {
    return (Object.keys(DROP_LABEL) as DropReason[])
        .map(r => [r, census[r]] as const)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);
}

export interface DropExplanation {
    samples: number;
    label: string;
    why: string;
}

/**
 * The same rows in words, keyed by reason, most first: what `tuner_status` answers.
 *
 * A bare key such as `highLoadSettle` is a name the assistant can only repeat; the sentence beside
 * it is the part that tells the driver what to change on the next run.
 */
export function explainDrops(census: DropCensus, lang: DialogLang): Partial<Record<DropReason, DropExplanation>> {
    return Object.fromEntries(droppedReasons(census).map(([r, n]) =>
        [r, { samples: n, label: DROP_LABEL[r], why: DROP_WHY[lang][r] }]));
}
