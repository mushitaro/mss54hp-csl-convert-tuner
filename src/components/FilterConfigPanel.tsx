import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Filter } from 'lucide-react';
import { Row, Slider, SubField } from './FilterPanelControls';
import {
    MIN_SELF_SHARE, MIN_INDEPENDENT, AUTOCORR_FALLBACK,
    VE_METHOD_DEFAULT, DIRECT_AUTHORITY_DEFAULT, DIRECT_MIN_SAMPLES, VE_MIN_WEIGHT_DEFAULT, type VeMethod,
} from '@/lib/ve-calculator/calculator';
import { MAX_SAMPLE_SD } from '@/lib/ve-calculator/lowLoadTuner';
import { useFeatureEnabled } from '@/lib/build-variant';
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
 *   4. WHAT IN THIS LOG SAYS TO MOVE IT, and what the car gets if it is set wrong
 *   5. what to do about it on the next run, where there is something to do
 *
 * Part 4 was missing from every one of these and it is the reason the panel exists: a filter is
 * adjusted by looking at the drive you actually recorded and deciding what its characteristics mean
 * for the car (operator, 2026-08-24). "Raising this excludes more samples" is arithmetic, not a
 * judgement — it does not say what in the log would make you raise it, or what the ECU ends up
 * holding if you do not. So each explanation now names the reading to look at (its own count in the
 * drop census, VALID, the accepted-cell count, the faint band of the heatmap), says what that
 * reading means about the drive, and says which direction the resulting bytes are wrong in.
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
            + '水温が安定してから記録を開始すれば、このフィルターが除外するサンプルはほとんど無くなります。\n'
            + '除外の内訳の cold が、このフィルターが実際に取り除いた量です。数 % 以上あれば水温が上がりきる前から記録した走行で、この値を 70〜75 °C に上げれば余裕は増えますが、減るのは低負荷側のサンプルです。cold が 0 のログでは、この値を下げても結果は変わりません — 直すのはスライダーではなく、次の走行の開始タイミングです。',

        katsHint:
            'このフィルターは、排気温がこの値を超えた区間と、その後 20 秒間のサンプルを除外します。\n'
            + '排気温がこの値を超えると、DME は触媒を保護するために燃料を増量し、λ 制御を停止します。Min Temp と同じ機構です。λ 制御が停止しているあいだ λ トリムは更新されず、停止直前の値のまま保持されます。保持された値は、その時点の空気量とは対応していません。増量が抜けきるまでに時間がかかるため、排気温が下がってからの 20 秒も除外します。\n'
            + '値を下げると除外される区間が広がり、保持された λ トリムの混入を確実に防げますが、高負荷側のサンプルが減ります。値を上げると逆になります。\n'
            + '除外の内訳の cat protect が多いログは、高負荷を長く続けた走行です。既定は DME 自身のしきい値に合わせてあるので、下げても高負荷セルの根拠が減るだけです。上げると λ トリムが止まっていた区間が全開域のセルに入り、最も影響の大きい領域を実際とは違う値で書き換えます。加速の合間に冷ます時間を取れば、この除外は減ります。',
        katsLocked: 'このログには排気温が記録されていないため、この設定は何も除外しません。',


        hlSettleHint:
            '充填率が 55 % を超えてから、この秒数が経つまでのサンプルを除外します。\n'
            + '高負荷に入ると DME は排気温補正を一段引き上げますが、排気温センサーは実際の温度より遅れて読むため、'
            + '補正は大きめから始まります。λ トリムがそれを打ち消すには毎秒数 % ずつしか動けず、追いつくまでの間の'
            + 'サンプルは実際より濃い方向に読めます。\n'
            + '実測では、短い加速だけの走行と 30 秒の加速を含む走行で高負荷セルが 5 % 食い違い、'
            + 'この除外を入れると一致しました。加速を 10 秒以上保持すると、除外後にも十分なサンプルが残ります。\n'
            + '0 で無効（この設定が無かった頃のセッションと同じ動作）。\n'
            + '除外の内訳の short pull が、この設定が取り除いた量です。高負荷セルが薄いまま short pull が多いなら、加速が短すぎたということで、値を下げるより加速を長く保つほうが正解です。0 にすると追いつく前のサンプルが入り、高負荷セルはリッチ側に書き換わります — 危険側ではありませんが、全開で出力が出ません。',
        settleHint:
            'この値は、回転数やアクセル開度が変化してから何秒後のサンプルを使うかを決めます。\n'
            + 'DME は燃料の調整に 1〜2 秒かかります。その間のサンプルでは、λ トリムはまだ目標の値に届いていません。\n'
            + '判定は時刻で行うため、通信の速さが変わっても待つ時間は変わりません。\n'
            + '値を上げると除外されるサンプルが増え、残ったサンプルでは DME の調整が終わっています。値を下げると、調整の途中のサンプルが混ざります。\n'
            + '値を上げたときに VALID が大きく落ちるログは、定常が短い走行です。そのときは値を下げるのではなく、一定のアクセルを長く保つ走行を足してください。短いままにすると、λ トリムが目標に届く前のサンプルがセルに入り、そのセルは走らせ方によって上にも下にもずれます。',

        rpmDeltaHint:
            '回転数が変化している最中のサンプルを除外します。この値がその境目で、直前のサンプルと比べて回転数がこの % より大きく動いていたサンプルが落ちます。\n'
            + 'λ トリムは積分器です。空気量が変わっても即座には移動せず、新しい値に到達するまで時間がかかります。変化の最中に記録されたサンプルでは、トリムはまだ移動の途中にあり、変化後の空気量に対応した値になっていません。\n'
            + '回転数が動けば充填量も動きます。λ トリムが新しい値に届くまでには時間がかかるので、その間のサンプルのトリムは、動く前の空気量にも動いた後の空気量にも対応していません。除外の内訳の transient は、この値と Max RO Delta が作っている数字です。\n'
            + '判定は平均ではなく、直前の 1 サンプルとの比較です。比較するのは過去だけなので、変化が始まった瞬間のサンプルは通過し、そのあとが除外されます。\n'
            + '% は前のサンプルの回転数に対する割合です。同じ 5 % でも 1000 rpm では 50 rpm、5000 rpm では 250 rpm にあたるので、低回転ほど厳しく効きます。\n'
            + '値を下げると除外されるサンプルが増え、残ったサンプルは定常状態に近くなりますが、使えるサンプル数は減ります。値を上げると逆になります。\n'
            + '隣り合うセルの値が互い違いにばらつくマップは、変化中のサンプルが残っている兆候です。そのときはこの値を下げます。下げすぎると埋まるセルが減るので、TUNED MAP の上に出ている採用セル数とヒートマップを見ながら決めてください。\n'
            + '路上のログでは、除外の内訳の transient が最も大きくなるのが普通です。問題になるのは、残ったサンプルでヒートマップが埋まらないときで、そのときはこの値を上げるのではなく、同じ回転・同じ開度を長く保つ走りを足してください。上げると λ トリムが移動中のサンプルがそのままセルに入り、マップはエンジンの特性ではなくアクセルの動かし方の形になります。',

        roDeltaHint:
            'アクセル開度が変化している最中のサンプルを除外します。この値がその境目で、直前のサンプルと比べて開度がこの差より大きく動いていたサンプルが落ちます。回転数側とこちらは別々に判定され、どちらかを超えたサンプルが除外されます。\n'
            + '回転が一定でも、開度が動けば充填量は動きます。一定の回転でアクセルだけを煽った区間は Max RPM Delta を通過するので、その区間を落とすのはこちらの値です。\n'
            + '指定のしかたが回転側と違います。回転数は変化率（%）、開度は絶対差（% ポイント）です。開度 20 % から 25 % への変化は、回転数がどこにあっても 5 ポイントとして扱われます。\n'
            + '値を下げると除外されるサンプルが増え、残るのは開度が動いていないサンプルだけになります。値を上げると、煽っている最中のサンプルが混ざります。\n'
            + 'アクセルを細かく動かす走り方のログでは、回転側を絞るよりこちらを下げるほうが効きます。回転がほぼ一定に見えても、開度が動いていればそのサンプルの λ トリムは追いついていません。',

        covVe: 'VE Method',
        covVeHintDirect:
            'DIRECT を使ってください。既定です。測った値をそのまま書きます。\n'
            + '1 回で当てにいきません。データのあるセルを全部書く → 焼く → また走る。走るたびに残った誤差が縮んでいき、数回で収束します。ログのノイズは繰り返しで消えるので、1 回ぶんの精度は要りません。この「また走る」が精度を作っているので、焼いたら必ずもう一度走ってください。\n'
            + 'AUTHORITY は、測った要求のうち何 % を今回書くかです。100 % のまま動かさないでください。要求は既にこのセル自身のサンプルが出した範囲に抑えられているので、ここを下げても安全にはならず、収束が遅くなるだけです。ログが荒れていて 1 回ぶん信用しきれないときだけ 50〜70 % に落とします。\n'
            + 'MIN SAMPLES はセルを書き換えるのに要るサンプル数です。既定 3 —— 平均が取れる最小限で、精度のバーではありません。数えるのは「そのセルの中に入ったサンプル」だけで、隣のために取られてかすっただけのものは数えません。\n'
            + 'MIN WEIGHT は、そのセルが受け取った取り分の合計の下限です。既定 2.5。\n'
            + '1 サンプルは、はさむ 4 つの格子点に取り分として配られます。取り分の合計は必ず 1.00 で、近い格子点ほど大きくなります。MIN SAMPLES が「何回そのセルを訪れたか」を数えるのに対し、MIN WEIGHT は「DME が読んだ数字のうちそのセルが占めた量」を合計します。四角のちょうど真ん中に落ちたサンプルは 4 点に 0.25 ずつ配るので、3 回訪れたセルの取り分が 0.75 しかない、ということが起こります。別の質問なので、両方に下限があります。\n'
            + '上げると、証拠の薄い一帯がまとまって純正値のまま残ります。下げると、隣のセルのために取られたサンプルでセルが書き換わります。\n'
            + '実測（1400 rpm、開度 25 / 30 / 45 %）: 2.5 ではこの 3 セルが一緒に純正値のまま残り、開度を上げるほど値が上がる並びが保たれました。0 では 45 % だけが書き換わり、65 % が純正値のまま取り残されて −5.3 % のくぼみができました。踏み増したときに DME への要求が下がる形になるので、車はそこで揺れます。\n'
            + '0 で無効。純正値のまま残った領域は、この値を下げるのではなく、そこをもう一度走ってください。\n'
            + 'このやり方で落ちるのは「そこを走っていないセル」だけです。1 バイトも変わらないセルは、設定ではなく走行が足りません。\n'
            + '次にやること: 焼いて、次のセッションの BASE に「いま焼いたバイナリ」を指定して、同じ領域をもう一度走ってください。要求がどこも ±2 % に収まったら収束です。そこで初めて STATISTICAL と SHAPE の出番になります。',
        covVeHintStat:
            '収束したあとの最終確認だけに使ってください。ふだんは DIRECT です。\n'
            + 'このやり方は「この 1 回の走行だけで、このセルを 95 % の確信をもって主張できるか」を問います。答えられないセルは純正値のまま 1 バイトも変わりません。何度も走って詰めていく途中でこれを使うと、まだ本物の補正が残っているセルまで拒否します。実測では DIRECT が 58 セル書けるログで 10 セルしか書きませんでした。しかも共通の 10 セルの値はテーブル 1 目盛の半分も違わないので、48 セルを消しただけです。\n'
            + '独立性: λ 制御は 1〜2 Hz で振動する 2 点制御で、ログは 4〜5 Hz です。連続するサンプルは同じ 1 回の振れを 2〜4 点で読んでいるだけなので、サンプル数はそのまま情報量になりません。実測した自己相関（そのセル自身、足りなければ行、最後に 0.85）から独立な観測数を出し、3 に満たないセルは落とします。\n'
            + '自己シェア: 1 つのサンプルは周囲 4 セルに分配されます。合計 1.0 で、セル中心なら 1.0、4 セルの境目なら 0.25 ずつ。そのセル自身の分が 30 % を切ると落とします。\n'
            + '散らばり: 升の中のサンプルが 1 つの条件か、2 つの状態の平均になっていないか。\n'
            + '有意性: 補正がその誤差より大きいかを Student の t 検定（両側 95 %）で見ます。通ったセルも要求どおりには動かず、基準をぎりぎり超えたセルはわずかしか動きません（収縮 λ = 1 − (t95/t)²）。\n'
            + '見るのは TUNED MAP の上の帯です — 「40/480 gate ・ 120 touched」。前がこの条件を満たしたセル数、後がこの走行でデータがあったセル数です。',
        covRf: 'RF KORR Cell Gate',
        covRfHint:
            'この設定は、排気温補正テーブル（KF_RF_KORR_DRREL）のセルに同じ条件を課します。\n'
            + '補正テーブルは 72 セル、VE マップは 480 セルです。しかもこの表の 1 セルは倍率で、VE テーブルに掛かる形で効きます。1 セルの間違いが動かす運転領域は VE マップの 1 セルよりずっと広いので、VE マップとは別に、高い基準を持たせています。\n'
            + 'この表のサンプルは、DME の補正が実際に動いていた区間からしか取れません — 充填率 55〜80 % 以上、20 km/h 以上、しかもそれが数秒続いた区間です。VE マップに比べてサンプルは桁違いに少なく、値を下げて増えるのは「薄い根拠で書き換えたセル」だけです。\n'
            + '見るのは RF KORR タブの下の行です — 「72 セル中 N セルを更新」「アンカー N サンプル」「比 N サンプル」と、その内訳（充填率下限未満で除外 / ヒステリシス帯で除外 / RF・排気温が整定しておらず除外）。更新セルが少ない理由はその内訳に出ます。「充填率下限未満」が大半なら、この設定を下げても意味はありません。足りないのはサンプル数ではなく、持続した高負荷です。\n'
            + 'この表を書き込むかどうかは、ハブの WRITE RF KORR で決めます。',
        covBands: 'Covered At',
        covBandsHint:
            'この設定は、ヒートマップの色分けだけを決めます。計算には影響しません。\n'
            + 'ヒートマップは 3 段階です。薄い色は「通ったが、ゲートを通らなかった」セル。中間色は「ゲートを通り、書き換えられた」セル。濃い色は、この値に達して「もうこの領域を走らなくてよい」セルです。\n'
            + '薄い色と中間色の境目は、ゲートが実際に下した判定そのものです。サンプル数と重みの両方を見た結果を使うため、色と計算が食い違いません。したがってここで決めるのは、濃い色に変わる点だけです。\n'
            + 'ゲートは「このセルを書き換えてよいか」、この値は「この領域をこれ以上走らなくてよいか」を答えます。後者のほうが高い基準なので、既定はゲートよりかなり上に置いています。\n'
            + 'この値は次の走行を決めるための目印です。濃くなったセルはもう走らなくてよい、薄いままのセルはまだ足りない、と読んでください。',
        bandsLegend: (ok: number) =>
            `薄い = データ不足 · 中間 = 書き換え対象 · 濃い = ${ok} サンプル以上`,
        subSamples: 'Min Samples',
        subWeight: 'Min Weight',
        subAuthority: 'Authority',
        factIndep: 'Independent obs.',
        factShare: 'Self-share',
        factScatter: 'Scatter (sd)',
        factSignif: 'Significance',
        factLegacyWeight: 'Weight (retired)',
        factLegacyGateOff: 'Gate off (retired)',
        clearLegacy: 'Clear it',
        transientOffClear: 'Turn it back on',
        transientOffNote:
            'このセッションは Transient Filter を無効にした状態で保存されています。保存された値は '
            + 'そのセッションを再現するために尊重されるので、下の 2 つのしきい値は表示されていても '
            + '何も除外していません。回転数も開度も動いている最中のサンプルがそのままセルに入ります。',
        legacyNote:
            'このセッションは退役した設定を保存しています。保存された値はそのセッションを再現するために '
            + '尊重されるので、放っておくとセルの採否を静かに変え続けます。METHOD が現在の軸です。',
        gateOff:
            '補正テーブルのゲートを切りました。1 サンプルしか記録されていないセルも書き込まれます。'
            + 'このテーブルは 72 セルしかなく、1 セルが VE テーブル全体に掛かる倍率なので、'
            + '薄い根拠のセルが動かす運転領域は VE マップの 1 セルよりずっと広くなります。',
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
            + 'Starting the log after the coolant temperature has stabilised leaves almost nothing for this filter to exclude.\n'
            + 'The cold count in the drop census is what this filter actually removed. More than a few percent means the log was started before the coolant had settled: raising this to 70-75 °C buys margin, and what it costs is low-load samples. On a log whose cold count is zero, lowering this changes nothing — what needs changing is when the next log is started, not the slider.',

        katsHint:
            'This filter excludes samples taken above this exhaust temperature, and those taken in the 20 s that follow.\n'
            + 'Above this temperature the DME adds fuel to protect the catalyst and suspends lambda control — the same mechanism as Min Temp. While lambda control is suspended the lambda trim is not updated: it holds the value it had when control stopped. That held value does not correspond to the air flow at the time it was recorded. The enrichment takes time to clear, which is why the 20 s after the temperature falls are excluded as well.\n'
            + 'Lowering this value widens the excluded stretch and reliably keeps a held lambda trim out of the result, but leaves fewer high-load samples. Raising it does the opposite.\n'
            + 'A large cat protect count means the drive held high load for long stretches. The default is set to the DME\'s own threshold, so lowering it only costs high-load evidence. Raising it lets the stretch where the lambda trim was frozen into the full-load cells — the region where a wrong value matters most. Leaving time to cool between pulls is what reduces this exclusion.',
        katsLocked: 'This log contains no exhaust temperature, so this setting excludes nothing.',

        hlSettleHint:
            'Excludes samples until the filling has been above 55 % for this long.\n'
            + 'Entering high load makes the DME step its exhaust-temperature correction up — off a '
            + 'sensor that reads behind the real temperature, so the step starts too big. The lambda '
            + 'trim can only walk after it a few percent per second, and until it lands the samples '
            + 'read rich of the truth.\n'
            + 'Measured: a drive of short bursts and one holding a 30 s pull disagreed by 5 % in '
            + 'their high-load cells, and agreed once these samples came out. Hold pulls 10 s or '
            + 'longer and plenty survives the exclusion.\n'
            + '0 disables it — the exact behaviour of sessions from before this setting existed.\n'
            + 'The short pull count in the census is what this setting removed. If the high-load cells are still faint and short pull is large, the pulls were too short — hold them longer rather than lowering this. At 0 the samples taken before the trim caught up go in and the high-load cells are written rich: not the dangerous direction, but not the one that makes power either.',

        settleHint:
            'This value sets how long after a change in engine speed or throttle opening a sample may be used.\n'
            + 'The DME takes one to two seconds to complete a fuel adjustment. In a sample taken during that time, the lambda trim has not yet reached its target.\n'
            + 'The test is made on timestamps, so the waiting time stays the same whatever the link speed.\n'
            + 'Raising this value excludes more samples and leaves only those where the DME had finished adjusting. Lowering it admits samples taken mid-adjustment.\n'
            + 'If VALID falls sharply when this is raised, the drive had few steady stretches. Add driving that holds a constant pedal rather than lowering it back: left short, samples taken before the lambda trim reached its target go into the cells, and those cells then sit high or low depending on how the car was driven.',

        rpmDeltaHint:
            'Excludes samples recorded while engine speed was still changing. This value is where the line is drawn: a sample whose engine speed has moved more than this, against the sample before it, is excluded.\n'
            + 'The lambda trim is an integrator. It does not step to a new value when the air flow changes; it takes time to arrive. In a sample recorded during that movement the trim is still part-way there, and does not correspond to the air flow after the change.\n'
            + 'When engine speed moves, filling moves with it. The lambda trim takes time to reach its new value, so during that time the trim in a sample corresponds neither to the air flow before the change nor to the air flow after it. The transient count in the drop census is the number these two values — this and Max RO Delta — produce.\n'
            + 'The test is not an average: it compares against the single sample before this one. It also looks only backwards, so the sample at the instant a change begins passes and the ones after it are excluded.\n'
            + 'The percentage is measured against that earlier sample\'s engine speed. The same 5 % is 50 rpm at 1000 rpm and 250 rpm at 5000, so it bites hardest at low engine speed.\n'
            + 'Lowering this value excludes more samples and leaves the remainder closer to steady state, but reduces how many samples are available. Raising it does the opposite.\n'
            + 'A map whose neighbouring cells disagree cell by cell is the sign that samples taken during a change are still getting through; lower this when you see it. Lowered too far it fills fewer cells, so set it against the accepted-cell count above the TUNED MAP and the heatmap.\n'
            + 'On a road log the transient count is normally the largest one in the census. It becomes a problem only when what is left cannot fill the heatmap, and the answer then is to add driving that holds one engine speed and one throttle opening — not to raise this. Raised too far, samples taken while the lambda trim was still moving go straight into the cells, and the map takes the shape of how the pedal was moved rather than of the engine.',

        roDeltaHint:
            'Excludes samples recorded while throttle opening was still changing. This value is where the line is drawn: a sample whose opening has moved more than this, against the sample taken one Settle Time earlier, is excluded. The two tests are separate, and a sample over either limit is excluded.\n'
            + 'Filling moves when the opening moves, even at a constant engine speed. A stretch driven at steady revs on a moving pedal passes Max RPM Delta, and this is the value that removes it.\n'
            + 'It is stated differently from the engine-speed test: engine speed as a percentage change, opening as an absolute difference in opening percent. Moving from 20 % to 25 % opening counts as 5 points wherever the engine speed happens to be.\n'
            + 'Lowering this value excludes more samples and leaves only those whose opening was not moving. Raising it admits samples taken mid-movement.\n'
            + 'On a log driven with small pedal movements this is the one to lower, rather than tightening the engine-speed test: the revs can look steady while the opening moves, and the lambda trim in those samples has not caught up.',

        covVe: 'VE Method',
        covVeHintDirect:
            'Use DIRECT. It is the default, and it writes what the drive measured.\n'
            + 'It does not try to be right in one pass: write every cell that has data, flash, drive again. Each drive shrinks the error that is left, and it converges in a few laps — so noise in any single log washes out instead of having to be filtered out of it. That second drive is where the accuracy comes from, so always take one.\n'
            + 'AUTHORITY is how much of the measured demand this pass applies. Leave it at 100 %. The demand is already bounded by what samples inside that cell actually asked for, so lowering this does not make the result safer — it only makes convergence slower. Drop it to 50-70 % only when a drive was too messy to take at face value.\n'
            + 'MIN SAMPLES is how many points a cell needs before it is written. The default of 3 is the fewest that can carry an average; it is not a precision bar. It counts only points that landed INSIDE the cell — ones that merely grazed it on their way to a neighbour do not count.\n'
            + 'MIN WEIGHT is the floor on the total share a cell received. Default 2.5.\n'
            + 'One sample is split across the four grid points that bracket it. The shares always sum to 1.00, and the nearer point gets the larger one. MIN SAMPLES counts how many times a cell was visited; MIN WEIGHT adds up how much of the number the DME read was this cell. A sample landing dead centre gives each of the four 0.25, so a cell visited three times can hold three quarters of one sample. They ask different questions, which is why both have a floor.\n'
            + 'Raising it leaves a thinly covered neighbourhood at stock together. Lowering it lets a cell be written on samples that were really its neighbour\'s.\n'
            + 'Measured at 1400 rpm, 25 / 30 / 45 % opening: at 2.5 those three stay at stock together and the row still rises with opening. At 0 only 45 % moved, 65 % was left at stock, and the row dipped 5.3 % — the DME is asked for less as the throttle opens further, which is where the car bucks.\n'
            + '0 turns it off. A region that stayed at stock needs driving again, not a lower setting.\n'
            + 'The only cells this refuses are ones you did not drive. A cell that stays byte-for-byte identical needs driving, not a different setting.\n'
            + 'What to do next: flash, set the NEXT session\'s BASE to the binary you just flashed, and drive the same region again. When no cell asks for more than about 2 %, the map has converged — and that is when STATISTICAL and SHAPE become the right tools.',
        covVeHintStat:
            'For the final check after the map has converged. Use DIRECT for everything before that.\n'
            + 'This method asks whether THIS drive can prove THIS cell on its own, at 95 %. A cell that cannot answer keeps its stock value, byte for byte. Used partway through the loop it refuses cells that still hold real correction: on a measured log it wrote 10 cells where DIRECT wrote 58 — and the shared 10 differ by less than half a writable table step, so it deleted 48 answers without improving any.\n'
            + 'Independence: the lambda controller is a two-point loop oscillating at 1-2 Hz while the log runs at 4-5 Hz, so consecutive samples are two to four readings of ONE swing — a sample count is not an information count. The independent count comes from the measured autocorrelation (the cell\'s own, else its row, else 0.85), and a cell holding fewer than three is refused.\n'
            + 'Self-share: each sample is distributed across the four cells around it, summing to 1.0 — the whole of it at a cell\'s centre, 0.25 each on the corner between four. When less than 30 % of the weight a cell collected is its own, it is refused.\n'
            + 'Scatter: whether the samples in a cell are one condition rather than two states averaged together.\n'
            + 'Significance: whether the correction is larger than the uncertainty in it, as a Student t at 95 %. A cell that passes still does not move by the whole of what it asked for — one that clears the bar by a hair moves by a hair (shrinkage lambda = 1 - (t95/t)^2).\n'
            + 'The strip above the TUNED MAP is what to read — "40/480 gate · 120 touched": how many cells met the condition, and how many the drive left any data in.',
        covRf: 'RF KORR Cell Gate',
        covRfHint:
            'These values apply the same condition to the cells of the exhaust-correction table (KF_RF_KORR_DRREL).\n'
            + 'That table has 72 cells; the VE map has 480. And each of its cells is a multiplier, applied on top of the VE table — so the operating range one wrong cell moves is far wider than one VE cell\'s, which is why it carries its own, higher bar.\n'
            + 'Samples for this table can only come from the stretches where the DME\'s correction was actually running: above 55-80 % filling, above 20 km/h, and held there for seconds. There are orders of magnitude fewer of them than the VE map gets, and lowering these values adds nothing but cells rewritten on thin evidence.\n'
            + 'What to read is the line under the RF KORR tab — "N of 72 cells updated", "N anchor samples", "N ratio samples", and the breakdown beside them (below the filling floor / dropped in the hysteresis band / RF or EGT still moving). That breakdown says why so few cells moved. If most of it is "below the filling floor", lowering these values will not help: what is missing is sustained high load, not sample count.\n'
            + 'Whether this table is written at all is WRITE RF KORR on the hub.',
        covBands: 'Covered At',
        covBandsHint:
            'This value sets the colouring of the heatmap only. It does not affect the calculation.\n'
            + 'The heatmap has three levels. The faintest means the cell was visited but did not clear the gate. The middle one means it cleared the gate and was rewritten. The strongest means it reached this value, and the area needs no more driving.\n'
            + 'The boundary between the first two is the gate\'s own verdict, taken from the calculation itself. It accounts for both the sample count and the weight, so the colour and the calculation cannot say different things. The only thing left to set here is where the strongest level begins.\n'
            + 'The gate answers whether a cell may be rewritten; this value answers whether an area has been driven enough to move on from. The second is the higher bar, which is why the default sits well above the gate.\n'
            + 'This value is a marker for planning the next drive: a cell at full strength needs no more driving, a cell still faint needs more.',
        bandsLegend: (ok: number) =>
            `faint = not enough data · mid = written · full = ${ok}+ samples`,
        subSamples: 'Min Samples',
        subWeight: 'Min Weight',
        subAuthority: 'Authority',
        factIndep: 'Independent obs.',
        factShare: 'Self-share',
        factScatter: 'Scatter (sd)',
        factSignif: 'Significance',
        factLegacyWeight: 'Weight (retired)',
        factLegacyGateOff: 'Gate off (retired)',
        clearLegacy: 'Clear it',
        transientOffClear: 'Turn it back on',
        transientOffNote:
            'This session was saved with the Transient Filter switched off. A stored value is still '
            + 'honoured so that session reproduces, so the two thresholds below are on screen but '
            + 'excluding nothing: samples taken while rpm and throttle are still moving reach the '
            + 'cells unchanged.',
        legacyNote:
            'This session stored a retired setting. A stored value is still honoured so that '
            + 'session reproduces, so left alone it goes on quietly changing which cells are '
            + 'written. METHOD is the axis now.',
        gateOff:
            'The gate on the correction table is off. A cell holding a single sample will be written. '
            + 'That table has only 72 cells and each one is a multiplier over the whole VE table, '
            + 'so a cell written on thin evidence moves a far wider operating range than one VE cell does.',
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
     * Which derivation the tab behind this panel is showing — and therefore which of these
     * controls can change anything from here.
     *
     * The two streams stopped sharing one filter (2026-08-30): the VE map and KF_RF_KORR_DRREL are
     * charged by different settles and judged by different gates. A control that cannot move what
     * is on screen is noise on that screen — the VE cell gate does nothing while you are reading
     * the correction table, and the RF KORR gate does nothing while you are reading the map.
     *
     * SCOPING, NOT HIDING, and the difference matters: every setting here is on the tab it acts
     * on, so none is left running with no control anywhere. That was the failure this panel already
     * carries two notices about, and it is not what this does.
     *
     * Defaults to 've' — every tab that renders this panel except one is a VE surface.
     */
    scope?: 've' | 'rfkorr';
    /**
     * Which channels the loaded log actually carries.
     *
     * Decided by the page, which is the only place that can see the log at all. Every control whose
     * effect depends on a channel is disabled when that channel is absent — a filter that silently
     * does nothing is worse than one that says it cannot.
     */
    channels?: { tabg: boolean; rf: boolean };
    /** This log's measured sample rate, for the "≈ n samples" beside the settle time. Display only:
     *  the filter itself works on timestamps and never converts. */
    measuredHz?: number;
    /** Mean gap between the two rf_korr routes over this log, or undefined when they cannot be
     *  compared. The one check the app has on a DS2 offset nobody has confirmed on a car. */
    routeGap?: number;
    routeSamples?: number;
}





const NO_CHANNELS = { tabg: false, rf: false } as const;

/**
 * A gate the operator cannot move, shown so the panel describes the gate that actually runs.
 *
 * Four of the six VE tests are constants derived from measurement rather than settings, and a
 * panel that listed only the adjustable ones was describing a gate that no longer exists.
 *
 * Module scope, not inside the component: a component redefined on every render is a new type on
 * every render, so React unmounts and remounts its subtree instead of updating it.
 */
const Fact: React.FC<{ label: string; value: string; dim?: boolean }> = ({ label, value, dim }) => (
    <div className="flex justify-between items-baseline text-[9px] uppercase tracking-wider">
        <span className={dim ? 'text-slate-700' : 'text-slate-600'}>{label}</span>
        <span className={dim ? 'text-slate-700' : 'text-slate-500 font-mono'}>{value}</span>
    </div>
);

/**
 * The two methods, as buttons.
 *
 * Module scope for the same reason `Fact` is: a component defined inside a component is a new type
 * on every render, and `react-hooks/static-components` is right to refuse it.
 *
 * The order is the order of the argument — DIRECT first because it is the default and the method
 * the community means by "VE tuning", statistical second because it is the specialist pass at
 * the end.
 *
 * DIRECT rather than the name of the tool the approach comes from: that is another company's
 * product, this is not their algorithm, and a label naming them would claim an association that
 * does not exist. The measured default it descends from is still credited where it belongs, in
 * the note on minCellWeight in calculator.ts.
 */
const VE_METHODS: { id: VeMethod; label: string }[] = [
    { id: 'direct', label: 'DIRECT' },
    { id: 'statistical', label: 'STATISTICAL' },
];

export const FilterConfigPanel: React.FC<Props> = ({
    config, onConfigChange, readOnly = false, openUp, scope = 've', channels = NO_CHANNELS, measuredHz,
    routeGap, routeSamples,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    /** Which stream this tab is reading — see the `scope` prop. Named so the JSX reads as a claim
     *  about the surface rather than a string comparison repeated eight times. */
    const onVe = scope === 've';
    const onRfKorr = scope === 'rfkorr';
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

    /**
     * Propagation to the page, decoupled from the controls.
     *
     * `localConfig` is what every control here renders, and it moves in the frame of the touch.
     * Handing each movement to `onConfigChange` as well is what made the START of a drag stutter:
     * every call commits the config page-wide, and although the data-bearing components bail out,
     * that reconciliation shares the thread with the finger — once per pointer-move. So a number
     * (a slider) queues and goes 120 ms after the last movement, and a toggle — a single event —
     * goes at once. The page defers the expensive recompute again on its own side (see
     * handleConfigChange there); this queue exists so that DURING a drag the page does nothing at
     * all. `sendPending` reads only refs, so the unmount flush below cannot go stale.
     */
    const pendingRef = useRef<LogFilterConfig | null>(null);
    const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSentRef = useRef<LogFilterConfig>(config);
    const onConfigChangeRef = useRef(onConfigChange);
    useEffect(() => { onConfigChangeRef.current = onConfigChange; });
    const sendPending = useCallback(() => {
        if (sendTimerRef.current !== null) { clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
        const cfg = pendingRef.current;
        if (!cfg) return;
        pendingRef.current = null;
        lastSentRef.current = cfg;
        onConfigChangeRef.current(cfg);
    }, []);
    const propagate = (cfg: LogFilterConfig, coalesce: boolean) => {
        pendingRef.current = cfg;
        if (!coalesce) { sendPending(); return; }
        if (sendTimerRef.current !== null) clearTimeout(sendTimerRef.current);
        sendTimerRef.current = setTimeout(sendPending, 120);
    };
    // A queued change must not die with the panel — the mobile layout unmounts it on close.
    useEffect(() => () => sendPending(), [sendPending]);

    // Sync local config when an EXTERNAL change arrives (session load, reset). Our own sends echo
    // back as this same prop one commit later; identity against the last object sent tells the two
    // apart, and skipping the echo keeps a change made DURING that commit from being clobbered by
    // it. An external config supersedes anything still queued.
    // A setState in an effect, deliberately: the identity guard means this body runs only when the
    // parent hands down a config this panel did not produce -- a session load or a reset -- and the
    // one extra render it causes then IS the synchronisation, not a cascade. Our own sends echo
    // back as the same object and are skipped.
    useEffect(() => {
        if (config === lastSentRef.current) return;
        // The identity guard above is what rules out the cascade this lint fears: our own sends
        // echo back as the same object and are skipped, so this body runs only for a config this
        // panel did not produce -- a session load or a reset -- and that one extra render IS the
        // synchronisation. (If this directive ever reports unused, the react-compiler has merely
        // bailed out of analysing the component; the reasoning still holds.)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLocalConfig(config);
        pendingRef.current = null;
        lastSentRef.current = config;
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
        propagate(newCfg, false);
    };

    // `undefined` is a value here, not an omission: an optional setting turned OFF has to be able
    // to say so. `transientSettleSec` is the wait in seconds when set and "use the legacy sample
    // count" when absent, and a control that could only write numbers could never say the latter.
    const handleChange = (key: keyof LogFilterConfig, value: number | boolean | string | undefined) => {
        if (readOnly) return;
        // The cast, rather than a `@ts-ignore` over the whole statement.
        //
        // TypeScript cannot check a computed key against a union of keys with different value types
        // — `minTemp` is a number and `enableMinTemp` is a boolean, so `{ [key]: value }` is only
        // assignable if it can prove which key this is, and it cannot. Narrowing that to the one
        // expression it applies to means the rest of the line is still checked, which is what
        // `@ts-ignore` on the line above was silently giving up.
        const newCfg = { ...localConfig, [key]: value } as LogFilterConfig;
        setLocalConfig(newCfg);
        // A number is a slider mid-drag; everything else is a single decisive event.
        propagate(newCfg, typeof value === 'number');
    };

    const row = (id: string) => ({
        id,
        infoLabel: t.info,
        open: infoFor.has(id),
        onToggleInfo: () => toggleInfo(id),
    });

    /**
     * The settle wait, said in the unit it is actually kept in.
     *
     * A config from before this control carries no seconds — only the sample count it was built
     * with, and the filter is still using that count. Forcing a seconds value in here showed 2.0 s
     * for a session whose filter was waiting 4 samples, which at 2.95 Hz is 1.4 s: the panel was
     * describing what this control WOULD apply if it were touched, not what was happening. Every
     * session made so far is in that state — `transientSettleSec` is not in DEFAULT_FILTER_CONFIG,
     * so it appears only once this slider has been dragged.
     */
    const storedSec = localConfig.transientSettleSec;
    const settleSamples = resolveTransientWindow(localConfig, measuredHz);
    const settleSec = storedSec
        ?? (measuredHz && measuredHz > 0 ? localConfig.transientWindow / measuredHz : TRANSIENT_SETTLE_SEC_DEFAULT);
    // With no seconds AND no rate there is nothing to convert between, so it says the one number
    // that is true rather than relating two that cannot be related.
    const settleLabel = storedSec === undefined && !(measuredHz && measuredHz > 0)
        ? `${localConfig.transientWindow} samples`
        : settleSamples === undefined
            ? `${settleSec.toFixed(1)} s`
            : `${settleSec.toFixed(1)} s ≈ ${settleSamples}`;
    const veMethod: VeMethod = localConfig.veMethod ?? VE_METHOD_DEFAULT;
    const directMethod = veMethod === 'direct';
    const veAuthority = Math.round(100 * (localConfig.directAuthority ?? DIRECT_AUTHORITY_DEFAULT));
    /**
     * A stored `enableVeCellGate: false`, which no longer has a control.
     *
     * It never turned the gate off. It moved the two STRUCTURAL bars to 1 sample / 0 weight and
     * left self-share, independence and significance refusing exactly as before — so a session that
     * stored it has a switch claiming "off" over a gate that was mostly still on. METHOD is the
     * honest axis, and this is shown the way the retired weight is: named, with the way out.
     */
    const veGateForcedOpen = localConfig.enableVeCellGate === false;
    const rfGateOn = localConfig.enableRfKorrCellGate ?? true;
    /** Whether the KF_RF_KORR_DRREL cell gate is worth offering — see the block comment beside it.
     *  Read here rather than passed in: the panel is rendered from two places in the page, and a
     *  prop threaded twice is a prop one of them will eventually forget. */
    const rfKorrOpen = useFeatureEnabled('rfKorr');
    const veSamples = localConfig.minVeCellSamples ?? (directMethod ? DIRECT_MIN_SAMPLES : 10);
    /**
     * The STORED weight, with no display default.
     *
     * `?? 5` here was the bug the panel had: the calculator retired this gate to a default of 0
     * and the panel went on rendering 5, so the screen showed a bar the derivation was not
     * applying. Undefined now means what it means — the gate is off — and a real stored value is
     * shown as the legacy setting it is.
     */
    const veWeight = localConfig.minVeCellWeight ?? VE_MIN_WEIGHT_DEFAULT;
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

                        <div className={`space-y-12 ${readOnly ? 'opacity-60 pointer-events-none select-none' : ''}`}>
                            {/* ORDER, top to bottom: what the map SHOWS, then what it WRITES, then which
                                samples it is allowed to use (operator, 2026-08-28).
                            
                                Not the pipeline order. The pipeline runs the other way — samples are
                                filtered, then cells are decided, then the map is coloured — and following
                                it put the two rows nobody opens the panel to look at at the top. This is
                                reading order instead: the legend for the picture on screen, the decision
                                that picture reports, and last the conditions that are set once and left.
                            
                                NO HEADINGS. They were tried and they were noise: the rows already say what
                                they are, and a title plus a sentence over each group said it again in other
                                words (operator, 2026-08-30). What separates the groups is SPACE — `space-y-8`
                                between them against `space-y-4` inside — and no rule between them either,
                                because a gap and a hairline are two ways of saying the same thing.

                                TRANSIENT SITS WITH VE METHOD, which is where it was and where it belongs: it
                                is the VE stream's own filter (see the table below) and the two are read
                                against each other. Moving it away from that was mine, and it was wrong.
                            
                    WHAT EACH TAB SEES, AND IT IS READ OUT OF filter.ts RATHER THAN OFF THE
                    LABELS. The names mislead: SETTLE TIME sounds like a transient control and is
                    not one, and TRANSIENT FILTER sounds common and is not.

                      1/2  minTemp, katsTabgOn      drop + continue BEFORE the rfKorrData push
                                                    -> both streams
                      3b   highLoadSettleSec        clears settledForRfKorr, which gates that push
                                                    -> rf_korr only
                      3c   transientSettleSec       marks settleUnsteady on the pushed row; it
                                                    never touches validData
                                                    -> rf_korr only
                      4    rpm/roStableThreshold    drop + continue AFTER the push, so the sample
                                                    is already rf_korr evidence
                                                    -> VE only

                    I had two of these backwards on the first pass, from the comments rather than
                    the code (operator, 2026-08-30). The order of the pushes is the whole answer
                    and it is four lines of filter.ts.

                    WHAT EACH TAB SEES. A control that cannot change what is on screen is noise
                                on that screen: the VE cell gate moves nothing while you are reading the
                                correction table, and the RF KORR gate moves nothing while you are reading
                                the map. So each is shown where it acts. Neither disappears from the app —
                                every one is on the tab it belongs to, which is the difference between
                                scoping a control and hiding a setting that is still running. */}

                            {onVe && (<section className="space-y-4">
                            <Row
                                {...row('bands')}
                                label={t.covBands}
                                value={`${coveredAt}`}
                                hint={t.covBandsHint}
                            >
                                <Slider min={10} max={1000} step={10} value={coveredAt}
                                    onChange={v => handleChange('coverageOk', v)} />
                                {/* `pt-2`: this legend sits directly under a slider, and it was
                                    the closest text to any thumb on the panel. */}
                                <p className="text-[9px] text-slate-600 leading-snug pt-2">
                                    {t.bandsLegend(coveredAt)}
                                </p>
                            </Row>
                            </section>)}

                            <section className="space-y-4">
                            {onVe && (
                            <Row
                                {...row('veGate')}
                                label={t.covVe}
                                value={directMethod ? 'DIRECT' : 'STATISTICAL'}
                                hint={directMethod ? t.covVeHintDirect : t.covVeHintStat}
                            >
                                <div className="space-y-3 pt-1">
                                    {/* THE AXIS. Two buttons rather than a toggle, because the
                                        two are not on/off of one thing — they answer different
                                        questions and each has its own parameters underneath.
                                        The toggle that used to be here claimed to switch the
                                        gate off while four of its six tests kept running. */}
                                    <div className="flex gap-1">
                                        {VE_METHODS.map(m => (
                                            <button key={m.id} type="button" disabled={readOnly}
                                                onClick={() => handleChange('veMethod', m.id)}
                                                className={`flex-1 min-h-10 px-1 text-[9px] font-bold tracking-wider rounded ${veMethod === m.id
                                                    ? 'bg-blue-600 text-white'
                                                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}>
                                                {m.label}
                                            </button>
                                        ))}
                                    </div>

                                    {/* Ceiling from the measurement in MapEditor: session #902
                                        put 130 samples in its busiest cell of 480, so a
                                        threshold of 200 could not be met by any drive at all. */}
                                    <SubField label={t.subSamples} value={`${veSamples}`}>
                                        <Slider min={1} max={100} value={veSamples}
                                            onChange={v => handleChange('minVeCellSamples', v)} />
                                    </SubField>

                                    {/* WEIGHT — the other half of "does this cell have evidence",
                                        and it reads coverage where SAMPLES reads visits. A cell can
                                        be visited three times and still have been three quarters of
                                        one sample's worth, because a sample between four nodes
                                        gives each of them a quarter. See VE_MIN_WEIGHT_DEFAULT for
                                        why 2.5 and what it costs. 0 turns the bar off. */}
                                    <SubField label={t.subWeight} value={veWeight.toFixed(1)}>
                                        <Slider min={0} max={10} step={0.5} value={veWeight}
                                            onChange={v => handleChange('minVeCellWeight', v)} />
                                    </SubField>

                                    {directMethod ? (
                                        <>
                                            <SubField label={t.subAuthority} value={`${veAuthority} %`}>
                                                <Slider min={10} max={100} step={5} value={veAuthority}
                                                    onChange={v => handleChange('directAuthority', v / 100)} />
                                            </SubField>
                                        </>
                                    ) : (
                                        /* Not adjustable, and saying so is the point: these
                                           four came from measuring this car, not from a
                                           setting anyone chose. */
                                        <div className="space-y-1 pt-1 border-t border-slate-800">
                                            <Fact label={t.factIndep}
                                                value={`>= ${MIN_INDEPENDENT}  (rho ~ ${AUTOCORR_FALLBACK})`} />
                                            <Fact label={t.factShare}
                                                value={`>= ${MIN_SELF_SHARE.toFixed(2)}`} />
                                            <Fact label={t.factScatter}
                                                value={`<= ${MAX_SAMPLE_SD.toFixed(2)}`} />
                                            <Fact label={t.factSignif} value="t > t95(dof)" />
                                        </div>
                                    )}

                                    {/* Only when an older session forced the cell gate open. It is
                                        still honoured so that session reproduces, which means it
                                        can be silently ADMITTING cells, and the only honest thing
                                        is to name it and offer the exit. The weight bar used to be
                                        listed here too; it is a live control again — see
                                        VE_MIN_WEIGHT_DEFAULT — so it has a slider above instead. */}
                                    {veGateForcedOpen && (
                                        <div className="space-y-1 pt-1 border-t border-slate-800">
                                            <Fact label={t.factLegacyGateOff} value="1 / 0" />
                                            <button type="button" disabled={readOnly}
                                                onClick={() => handleChange('enableVeCellGate', true)}
                                                className="w-full text-[9px] uppercase tracking-wider rounded
                                                    border border-slate-700 px-2 py-1 text-slate-400
                                                    hover:text-slate-200 hover:border-slate-600
                                                    disabled:text-slate-700 disabled:border-slate-800">
                                                {t.clearLegacy}
                                            </button>
                                            <p className="text-[9px] text-slate-600 leading-snug">
                                                {t.legacyNote}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </Row>
                            )}

                                    {onVe && (<>
                                    {/* TRANSIENT FILTER, and what is left of it is the whole of it.
                                        Two thresholds, one question — is the operating point moving —
                                        and both are read against the sample Settle Time picks out.
                                        The two settles that used to sit here have gone to the streams
                                        they charge; see their new homes above.

                                        NO TOGGLE. It had one, and with the settles gone it was a
                                        switch over two thresholds that already reach their own off
                                        position: Max RPM Delta and Max RO Delta both run to 50, which
                                        admits everything a drive can produce. A second way to say the
                                        same thing is a second thing to get wrong, and this one could
                                        disagree with the sliders under it — a session with the toggle
                                        off looked, on screen, like a session with two thresholds set
                                        wide, and reproduced differently.

                                        `enableTransient` itself is NOT gone. Sessions saved with it
                                        off have to keep reproducing, so the field is still honoured
                                        and the notice below names it when it is doing something — the
                                        same treatment the retired VE settings get, and for the same
                                        reason: a filter that is silently refusing samples with no
                                        control on screen is worse than one with a control. */}
                                    {localConfig.enableTransient === false && (
                                        <div className="space-y-1">
                                            <p className="text-[9px] text-red-400 leading-snug">
                                                {t.transientOffNote}
                                            </p>
                                            <button type="button" disabled={readOnly}
                                                onClick={() => handleChange('enableTransient', true)}
                                                className="w-full text-[9px] uppercase tracking-wider rounded
                                                    border border-slate-700 px-2 py-1 text-slate-400
                                                    hover:text-slate-200 hover:border-slate-600
                                                    disabled:text-slate-700 disabled:border-slate-800">
                                                {t.transientOffClear}
                                            </button>
                                        </div>
                                    )}

                                    <div className="space-y-4">
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
                                    </>)}

                            {/* THE CORRECTION TABLE — and the two halves are NOT equally scoped.

                                KF_RF_KORR_DRREL is 72 cells, and every one of them is a multiplier over the
                                VE map — so one wrong cell moves a far wider operating range than one VE cell
                                does, which is why its gate carries a higher bar than the VE side. SOURCE
                                chooses how it is measured and the GATE decides which of its cells may move.
                                They read as one thing because they are adjacent, and until 2026-08-30 they
                                were also gated as one thing, which was wrong.

                                SOURCE reaches the VE map on every build. `plan.source` picks which measured
                                rf_korr is used (calculator.ts: `rfKorrFromEgt` or `rfKorr`) and the next line
                                multiplies the trim by it. That is the VE correction itself, and it happens
                                whether or not the table is ever written. So SOURCE stays everywhere.

                                THE GATE reaches the VE map by exactly one route: it shapes `tunedRfKorr`,
                                which the calculator consults only behind `options.writeRfKorr &&
                                tunedRfKorr.acceptable` — and page.tsx ANDs that flag with
                                featureEnabled('rfKorr'). A build that cannot write the table cannot arm it,
                                so the two sliders move nothing there. verify:ve-divisor proves it by running
                                two tuned tables that disagree everywhere through the real calculator: with
                                the write off they give the same map, with it on they do not.

                                A control that changes nothing is worse than an absent one — the reader
                                concludes the derivation is broken rather than that this build has no table.

                                Whether the table is written at all is WRITE RF KORR on the hub. */}
                            <div className="space-y-4">

                                {/* RF KORR — not a filter, but it belongs to "how this log becomes a
                                    map" and has to travel with the session for the tune to be
                                    reproducible, which is why it is in this panel at all. */}
                                <RfKorrSourceControl
                                    {...row('rfKorrSource')}
                                    source={rfKorrSource}
                                    onChange={setRfKorrSource}
                                    hasTabg={channels.tabg}
                                    hasRf={channels.rf}
                                    readOnly={readOnly}
                                    routeGap={routeGap}
                                    routeSamples={routeSamples}
                                />

                                {/* The charge-temperature normalisation used to be offered here.
                                    It was measured on session #917 — 31 degC of intake-air span,
                                    a converged charge model — and it FAILED its own acceptance
                                    test: the leftover temperature dependence is +0.029 %/degC
                                    (ideal gas would be -0.30) and switching it on widened the
                                    cell-to-cell spread from 7.30 % to 7.86 %. A control that has
                                    been measured to make things worse is worse than a dead one.
                                    The arithmetic survives in chargeTemp.ts with the numbers; see
                                    there for how to re-test it. */}

                                {/* SETTLE TIME — the lambda wait, filed with the other one.

                                    Both settles wait for `la_f_regler`, which is why they read as a
                                    pair and why they belong beside SOURCE rather than under
                                    TRANSIENT FILTER, whose two thresholds ask a different question
                                    (is the operating point moving) and answer it from rpm and
                                    throttle without consulting the trim at all.

                                    NOT behind `rfKorrOpen`, and that is deliberate. Filed here it
                                    reads as an rf_korr control, but the field still gates the VE
                                    stream in `filter.ts` — `validData` — on every build. Hiding it
                                    where RF KORR does not render would leave a setting shaping the
                                    VE map with no control on screen, which is the failure this
                                    panel already carries two notices about. It sits with SOURCE,
                                    which is here for the same reason: it reaches the VE map on
                                    every derivation.

                                    The default is 0, so out of the box it costs the VE stream
                                    nothing — it compares each sample against the one before it. */}
                                {onRfKorr && (
                                <Row
                                    {...row('settle')}
                                    label="Settle Time"
                                    value={settleLabel}
                                    hint={t.settleHint}
                                >
                                    <Slider min={0} max={3} step={0.1} value={settleSec}
                                        onChange={v => handleChange('transientSettleSec', v)} />
                                </Row>
                                )}

                                {/* HIGH LOAD SETTLE — a sample filter, and it belongs to this block
                                    rather than to the sample filters at the bottom of the panel.

                                    Since 2026-08-30 it gates `rfKorrData` and nothing else: the
                                    wait it imposes is the lambda integrator catching up with the
                                    EGT correction's step at high filling, which is a question about
                                    the correction table and never was one about the VE map. While
                                    it sat under TRANSIENT FILTER the VE stream paid all of it and
                                    the rf_korr derivation paid none, which is exactly backwards
                                    and cost a fifteen-minute drive 158 VE samples.

                                    Behind `rfKorrOpen` with the gate, because a build that cannot
                                    write KF_RF_KORR_DRREL has no rf_korr stream to narrow. SOURCE
                                    above is the exception and stays on every build — it reaches the
                                    VE map on every derivation, which this does not. */}
                                {rfKorrOpen && onRfKorr && <Row
                                    {...row('hlSettle')}
                                    label="High Load Settle"
                                    value={(localConfig.highLoadSettleSec ?? 0) > 0
                                        ? `${(localConfig.highLoadSettleSec ?? 0).toFixed(1)} s`
                                        : 'OFF'}
                                    hint={t.hlSettleHint}
                                >
                                    {/* 0 = off, so an operator can reproduce an archived
                                        session's map without hunting for a hidden default.
                                        15 s is past every convergence seen in the data. */}
                                    <Slider min={0} max={15} step={0.5}
                                        value={localConfig.highLoadSettleSec ?? 0}
                                        onChange={v => handleChange('highLoadSettleSec', v)} />
                                </Row>}

                                {rfKorrOpen && onRfKorr && <Row
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
                                </Row>}

                            </div>
                            </section>

                            <section className="space-y-4">
                                {/* VE ONLY, from the code and not from the label: step 4 drops with
                                    `drop('transient'); continue;` AFTER `rfKorrData.push`, so a sample it
                                    refuses is already rf_korr evidence and only `validData` pays it. */}

                            {/* WHICH SAMPLES MAY BE USED — all of it, in one place.

                                These were split either side of the cell decisions: the transient tests here
                                and the temperature ones at the top of the panel, which made them look like
                                two different kinds of setting. They are not. Each one answers "is this
                                sample telling the truth about steady-state filling", and they are set once
                                for a car and then left alone, which is why they are last. */}
                            <div className="space-y-4">


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
                            </div>
                            </section>
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
