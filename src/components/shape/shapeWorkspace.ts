import { useDeferredValue, useMemo, useState } from 'react';
import { useDialogLang } from '@/hooks/useDialogLang';
import {
    analyseShape, repairShape, SHAPE_REPAIR_DEFAULTS,
    type ShapeReport, type ShapeRepairOptions, type ShapeRepairResult,
} from '@/lib/ve-calculator/lowLoadShape';
import { summariseConvergence, CONVERGED_BAND, type ConvergenceReport } from '@/lib/ve-calculator/convergence';
import type { VEMap } from '@/lib/types';

/**
 * One SHAPE workspace, read by three surfaces that are nowhere near each other in the tree.
 *
 * The tab used to be a single panel in the map pane holding everything: the counts, the parameter
 * row, the grid, the profile chart and the cell readout. On a phone that put the controls and the
 * chart above and below a grid you had to scroll past — and the graph column beside it, the one
 * every other tab draws a surface in, was empty (operator, 2026-08-26).
 *
 * So each part moved to where it is useful: the grid stays on the map pane, the chart moved into
 * the graph pane where there is room for it, and the parameters became a popover in the footer
 * cluster, in the slot LOG FIELDS occupies on every other tab. That last one is what makes the
 * split work rather than merely spread it out — the footer is on screen from BOTH panes, so a
 * parameter can be moved while looking at the map OR at the chart, which is the point of moving it.
 *
 * Three surfaces, one state. It lives in a hook rather than a context because this codebase passes
 * props: page.tsx calls this once and hands the result to each of the three, so there is exactly
 * one owner and it is visible at the call site.
 */

export const LABEL = {
    title: 'SHAPE',
    falling: 'FALLING',
    jumps: 'GAIN STEPS',
    introduced: 'INTRODUCED',
    about: 'About this view',
    close: 'Close',
    gain: 'dRF/dRO',
    noRun: 'No tune yet.',
    converged: 'CONVERGED',
    settling: 'STILL MOVING',
    // Chrome stays English in both languages — only prose switches. The option names are the
    // physical rules themselves, so they are the same words a tuner would use either way.
    monotone: 'MONOTONE',
    blend: 'BLEND',
    smoothGain: 'SMOOTH',
    extrapolate: 'EXTEND',
    maxMove: 'MAX MOVE',
    ratioCap: 'STEP CAP',
    apply: 'APPLY',
    revert: 'REVERT',
    applied: 'APPLIED',
    shapedCells: 'shaped',
    refusedCells: 'refused',
    base: 'BASE',
    tunedS: 'TUNED',
    shapedS: 'SHAPED',
    axis: 'FILL',
    axisOpening: 'RO',
    axisRpm: 'RPM',
    axisBoth: 'BOTH',
    xEven: 'EVEN',
    xScale: 'TO SCALE',
    // 3D and 2D, not SURFACE and PROFILE (operator, 2026-08-30). The old pair described what the
    // picture IS; these describe what you get, in the words every other tool uses for it. The
    // reader picking between them is choosing a dimensionality, not learning a vocabulary.
    viewSurface: '3D',
    viewProfile: '2D',
    controls: 'SHAPE REPAIR',
    controlsTitle: 'Shape repair',
    viewCol: 'RO',
    viewRow: 'RPM',
    unitGain: 'GAIN',
    unitValue: 'RF',
    unitRatio: '% vs BASE',
};

/**
 * Every sentence the SHAPE tab's ⓘ panels can say, in both languages.
 *
 * Rewritten 2026-08-26 after the operator read the previous set and said 「インフォの説明が何一つ
 * 分からない」 — not one word of it was understandable. It was written by someone who already knew
 * the answer: it said "gradient", "anchor", "interpolated", "breakpoint" and "evidence" without
 * ever saying what those are, opened with the conclusion rather than the picture, and left every
 * option describing a trade-off instead of naming the setting to use.
 *
 * The rules this set is written to, all of them from the operator's own corrections:
 *
 *   - Every term is glossed exactly ONCE, where it is first needed — 充填, 勾配, アンカー, 内挿,
 *     断面. A reader opens one ⓘ at a time, so the gloss lives in the panel that needs it.
 *   - No abstract phrasing. 「セルの話」「間に落ちて」「ど真ん中」 were rejected by name; if a
 *     sentence cannot be pictured, it is rewritten rather than softened.
 *   - Every option hint NAMES THE SETTING TO USE and then the one case that justifies changing it.
 *     A hint that only describes a trade-off leaves the reader to invent a policy.
 *   - Control names stay English inside Japanese sentences — SHAPE, FALLING, GAIN STEPS, MONOTONE,
 *     STEP CAP, RO, RPM, BOTH — because those are the words printed on the switch. So do ECU
 *     symbols: kf_rf_soll is the name in the binary and in the disassembly.
 *   - Short. A previous round was rejected as 冗長.
 *
 * Three facts here are checked against the code rather than against the prose, because a first
 * draft got all three wrong: MONOTONE / BLEND / SMOOTH are OFF by default (SHAPE_REPAIR_DEFAULTS);
 * a GAIN STEP is a ratio ABOVE 1.6 **or below 1/1.6**, so a gradient that collapses counts too; and
 * `analyseShape` is called with no options, so the grid's violet threshold is a fixed 1.6 and does
 * not follow the STEP CAP slider.
 */
const TEXT = {
    en: {
        info: 'Show explanation',
        noRun: 'No tune result yet. Load a log and a BASE, and what that drive did to the table appears '
            + 'here.',
        blockedNoEvidence: 'This drive measured nothing, so there is no way to tell whether the map has settled. SHAPE is refused: given an unfinished surface it makes the measurement error monotone and smooth, which is harder to spot than the bumps it removes. Drive the region and derive again.',
        blockedUnsettled: (n: number, of: number, worst: number) =>
            `${n} of ${of} measured cells still want to move, the largest by ${(100 * worst).toFixed(1)} %. `
            + `The map has not converged, so SHAPE is refused — it would smooth a surface that is about `
            + `to change underneath it. Flash this tune, set the next session's BASE to the binary you `
            + `just flashed, and drive again. When every cell is inside ${(100 * CONVERGED_BAND).toFixed(0)} % `
            + `this unlocks.`,
        cellFalling: 'The throttle opened and less air went in. The table is wrong here, not the engine.',
        cellJump: 'The gradient differs sharply from the cell below, so the throttle comes on unevenly here.',
        intro: (n: number) => n === 0
            ? 'This tune introduced no new kink into the surface.'
            : `This tune introduced ${n} kink${n === 1 ? '' : 's'} that the BASE did not have.`,
        tapTitle: 'Tap a cell',
        tapBody: 'Tap a cell and its gradient appears as a number, and the chart below switches to the cut '
            + 'through that cell. The row at the largest opening is blank, because there is no cell to '
            + 'compare it with. Tap the red and violet cells first to see how far out they are.',
        aboutTitle: 'Air gained per 1% of throttle',
        aboutBody: 'This screen colours how much more air goes in when you open the throttle 1 % further. That '
            + 'rate is called the gradient, and the air itself is called filling (how full of air the cylinder '
            + 'gets on one intake stroke). The numbers come from kf_rf_soll, a table inside the ECU: rows '
            + 'are throttle opening RO (0.10 to 100 %), columns are engine speed RPM (600 to 7900 rpm),'
            + ' and the ECU reads it to decide how much fuel to inject. Engine speed does not change within '
            + 'a column, so read the colours down a column.',
        fallingTitle: 'FALLING (red) is a table error',
        fallingBody: 'A red cell is a place where you opened the throttle further and less air went in. No engine '
            + 'does that at a fixed engine speed, so what is wrong is the table, not the engine. The untouched '
            + 'BASE already holds 34 of them, from 0.001 to 0.204 (filling lost per 1 % of opening). MONOTONE '
            + 'is what repairs them: turn it ON and every cell with no measurement is fixed here.',
        jumpTitle: 'GAIN STEPS: read the pair',
        jumpBody: 'A violet cell is a place where the gradient jumps to 1.6x or more of the cell below it, '
            + 'or drops to 1/1.6 of it or less. You feel it as the throttle coming on unevenly. The opening '
            + 'steps are 0.05 % wide at the bottom and 15 % wide at the top, so jumps show up even in the '
            + 'untouched BASE (200 of the 480 cells, 24 rows x 20 columns). Do not read the count: read '
            + 'the BASE -> TUNED pair and check only whether the tune made it worse.',
        introTitle: 'INTRODUCED: kinks made this run',
        introBody: 'The count of cells that were painted neither red nor violet in the BASE and are painted '
            + 'now. It is the only number on this screen that comes from your log. It happens when a cell '
            + 'your log actually measured is rewritten while the neighbour with no measurement stays where '
            + 'it was. The ECU joins neighbouring cells with a straight line, so a cell that moves alone '
            + 'bends the line to both of its neighbours.',
        remedyTitle: 'Found a kink? Drive its neighbours',
        remedyBody: 'Do not drive that cell again: drive the opening one step above it and one step below it,'
            + ' at the same engine speed. A kink is not a fault in one cell, it is a bend in the line joining '
            + 'two neighbouring cells. Once both sides carry a measurement they move together and the line '
            + 'straightens. Tap the cell on the grid to read the opening and the engine speed to aim for.',
        optMonotone: 'Turn this ON (it is OFF by default). It is the rule forbidding less air to go in as the '
            + 'throttle opens, and there is no number to set. This is the rule that repairs the red cells '
            + '(FALLING). It only works running down a column, so set FILL to RO or BOTH.',
        optBlend: 'Turn this ON (it is OFF by default). Cells your log measured are anchors and cannot be moved; '
            + 'SHAPE REPAIR only moves cells with no measurement. BLEND takes a cell sitting between two '
            + 'anchors and gives it the value read off the straight line joining the two corrections (interpolation).'
            + ' The correction multiplies the BASE value, so the curve BASE drew between the anchors survives.',
        optSmooth: 'Turn this ON (it is OFF by default). It caps how far the gradient may jump between neighbouring '
            + 'cells at the STEP CAP ratio (1.1x to 4.0x, default 1.6). The grid paints a cell violet at '
            + 'a fixed 1.6, so leaving STEP CAP at 1.6 keeps what the repair aims for and what the colour '
            + 'marks the same.',
        optExtend: 'Leave this OFF (OFF by default). It carries the outermost measured correction past the last '
            + 'anchor (the last cell with a measurement), into cells with no measurement at all. There '
            + 'is nothing out there to sit between, so it writes a measured value where you never measured.',
        optMaxMove: 'Leave this at the default 6 % (1 % to 30 %). It is the most any one cell\'s value may be '
            + 'moved, as a percentage of that cell\'s own value, not of throttle opening. A correction '
            + 'that wants more is not written quietly: it is reported as refused.',
        optAxis: 'FILL is which way the correction spreads. Leave it on BOTH unless you have a reason. RO '
            + 'holds one engine speed and runs down a column, and MONOTONE applies only in that '
            + 'direction (BOTH runs RO first, so it applies there too). RPM holds one opening and runs '
            + 'across a row, where filling dropping as the revs rise '
            + 'is normal, so only SMOOTH applies. BOTH runs RO first and lets RPM fill what is left. APPLY '
            + 'arms the write, REVERT takes it back.',
        anchorsNote: (n: number) => `${n} measured cells are frozen. Nothing here can move them.`,
        unitNote: 'Leave this on GAIN. GAIN is the same gradient the grid beside it paints, and both red and '
            + 'violet are decided from that gradient. RF is the filling itself, but the axis spans the '
            + 'whole column (about 0.05 to 1.2), so what the tune moved barely moves the line. Switch to '
            + '% vs BASE only to see how far SHAPE REPAIR moved each cell. BASE becomes a flat line at '
            + 'zero and the movement shows at full height.',
        gainZeroNote: 'On a GAIN chart, look for the stretches where the line sits below zero. That is FALLING: '
            + 'the throttle opening while less air goes in. GAIN STEPS has no line to draw here. For that '
            + 'one, look for a sharp kink in the line.',
        profileCol: 'Engine speed held at one value, the table cut along the opening (a cross-section). Left '
            + 'to right is you pushing the pedal down. On GAIN, anywhere the line sinks below zero is FALLING.',
        profileRow: 'Opening held at one value, the table cut along engine speed. Left to right the revs rise.'
            + ' Filling dropping as the revs rise is normal on this engine, and SHAPE REPAIR does not correct '
            + 'it here.',
        pickForProfile: 'Pick a cell on the grid and PROFILE draws the table cut along one line through that cell.'
            + ' After that, tapping a point on the chart moves you to the next cell along the same line.'
            + ' Switch to SURFACE to see the whole table in 3-D.',
        axisEvenTag: 'x: even steps',
        axisScaleTag: 'x: to scale',
        profileAxisNote: 'This axis is not at the real values: every opening the table holds a number for gets one '
            + 'step of equal width. It matches the grid\'s own spacing, and it is the only axis on which '
            + 'the crowded low-opening rows can be read.',
        profileScaleNote: 'This axis is at the real values. It is the only one where the slope of the line is the real '
            + 'gradient, but most of the 24 openings sit below 5 %, so everything the tune touched overlaps '
            + 'at the left edge. Switch back to EVEN once you have read the slope.',
        axisNote: 'Leave this on EVEN. EVEN draws a 0.05 % step and a 15 % step at the same width, and the '
            + 'low-opening rows can be read on no other axis. Switch to TO SCALE only when you want the '
            + 'slope of the line to be the real gradient.',
    },
    ja: {
        info: '説明を表示',
        noRun: 'まだチューン結果がありません。ログと BASE を読み込むと、その走行が表をどう書き換えたかがここに出ます。',
        cellFalling: 'スロットルを開けたのに入る空気が減っています。間違っているのはエンジンではなく表です。',
        blockedNoEvidence: 'この走行では何も測れていないので、マップが収束したかどうか判断できません。'
            + 'SHAPE は実行できません —— 未完成の面に掛けると、測定誤差のほうを滑らかで単調にしてしまい、'
            + '元の凸凹より見つけにくくなります。その領域を走ってから、もう一度導出してください。',
        blockedUnsettled: (n: number, of: number, worst: number) =>
            `測定できた ${of} セルのうち ${n} セルがまだ動こうとしています（最大 ${(100 * worst).toFixed(1)} %）。`
            + `収束していないので SHAPE は実行できません —— これから変わる面を滑らかにすることになります。`
            + `このチューンを焼き、次のセッションの BASE に「いま焼いたバイナリ」を指定して、もう一度走ってください。`
            + `全セルが ${(100 * CONVERGED_BAND).toFixed(0)} % 以内に収まれば解除されます。`,
        cellJump: '一つ下のセルと勾配が大きく違うので、この辺りでアクセルの付きが不揃いになります。',
        intro: (n: number) => n === 0
            ? 'このチューンは面に新しい折れを作っていません。'
            : `このチューンは BASE に無かった折れを ${n} 個作りました。`,
        tapTitle: 'セルをタップすると',
        tapBody: 'セルをタップすると、そのセルの勾配が数字で出て、下のグラフがそのセルを通る線で切った図に変わります。開度がいちばん大きい行は、比べる相手のセルが無いので空白です。まず赤とバイオレットのセルをタップして、'
            + 'どれだけ外れているか見てください。',
        aboutTitle: '踏んだぶんの空気の増え方',
        aboutBody: 'この画面は、スロットルを 1 % 開け足したときに入る空気がどれだけ増えるかを色にしたものです。この増え方を勾配、増える空気そのものを充填（1 回の吸気で気筒がどれだけ空気で満たされるか）'
            + 'と呼びます。元の数字は ECU の中の表 kf_rf_soll で、縦がスロットル開度 RO（0.10〜100 %）、横が回転数 RPM（600〜7900 rpm）、ECU はこの表を見て噴く燃料を決めます。'
            + '回転数は列ごとに変わらないので、色は列を縦に読んでください。',
        fallingTitle: 'FALLING（赤）は表の間違い',
        fallingBody: '赤いセルは、スロットルを開けたのに入る空気が減っている場所です。回転数が同じままでこうなるエンジンは無いので、間違っているのはエンジンではなく表です。手つかずの BASE にもすでに '
            + '34 個あり、減り方は 0.001 から 0.204（開度 1 % あたりに減る充填）までです。直すのは MONOTONE で、ON にすれば実測の無いセルはここで直ります。',
        jumpTitle: 'GAIN STEPS は対で読む',
        jumpBody: 'バイオレットのセルは、勾配が一つ下のセルの 1.6 倍以上に跳んでいる、または 1/1.6 倍以下に落ちている場所です。アクセルの付きが不揃いに感じられます。開度の目盛りは下端が '
            + '0.05 %、上端が 15 % と幅が違うので、跳び自体は手つかずの BASE でも普通に出ます（480 マス中 200 マス、24 行 × 20 列）。個数ではなく BASE '
            + '→ TUNED の対を見て、チューンで増えたかどうかだけ確かめてください。',
        introTitle: 'INTRODUCED は今回できた折れ',
        introBody: 'BASE では赤にもバイオレットにも塗られていなかったのに、今は塗られているセルの数です。この画面で、あなたのログの結果を映す数字はこれだけです。ログで実測されたセルだけが書き換わり、'
            + '実測の無い隣のセルが元のまま残ると、こうなります。ECU は隣り合うセルの間を直線で結ぶので、1 つだけ動いたセルは両隣への線を折り曲げます。',
        remedyTitle: '折れを見つけたら隣を走る',
        remedyBody: '折れたセルそのものではなく、その一つ上と一つ下の開度を、同じ回転数で走ってください。折れは 1 つのセルの欠陥ではなく、隣り合う 2 つのセルを結ぶ線の曲がりだからです。両側が実測を持てば '
            + '2 つとも一緒に動き、線はまっすぐに戻ります。狙う開度と回転数は、グリッドでそのセルをタップすれば数字で出ます。',
        optMonotone: 'ON にしてください（既定は OFF）。スロットルを開けて入る空気が減ることを禁じる規則で、設定する数字はありません。赤いセル（FALLING）を直すのはこの規則です。効くのは列を縦にたどる向きだけなので、'
            + 'FILL は RO か BOTH にしてください。',
        optBlend: 'ON にしてください（既定は OFF）。実測のあるセルはアンカー（動かせないセル）で、SHAPE REPAIR が動かせるのは実測の無いセルだけです。BLEND は、アンカー '
            + '2 つに挟まれたセルへ、両端の補正を直線で結んだ線から読み取った値（内挿）を入れます。補正は BASE の値への掛け算なので、アンカーの間で BASE が描いていたカーブはそのまま残ります。',
        optSmooth: 'ON にしてください（既定は OFF）。隣り合うセルで勾配が跳ぶ量を、STEP CAP の倍率までに抑えます（1.1〜4.0 倍、既定 1.6）。グリッドがセルをバイオレットに塗る境目は '
            + '1.6 で固定なので、STEP CAP を 1.6 のままにしておけば、直す基準と色の基準が一致します。',
        optExtend: 'OFF のままにしてください（既定 OFF）。いちばん外側の実測の補正を、最後のアンカー（実測のある最後のセル）より外、実測が一つも無いセルまで伸ばして書く設定です。その外側には挟む相手の実測が無く、'
            + '測っていない場所に測った値をそのまま書くことになります。',
        optMaxMove: '既定の 6 % のままにしてください（1〜30 %）。1 つのセルの値を動かしてよい上限で、開度の % ではなく、そのセルの値に対する % です。これを超えたい補正は、黙って書き換えず、'
            + '拒否として報告します。',
        optAxis: 'FILL は、補正をどの向きに広げるかです。理由が無ければ BOTH のままにしてください。RO は回転数を 1 つ固定して列を縦にたどる向きで、MONOTONE が効くのはこの向きだけです（BOTH も RO を先に走らせるので効きます）。'
            + 'RPM は開度を 1 つ固定して行を横にたどる向きで、回転が上がって充填が下がるのは正常なので、ここでは SMOOTH だけが効きます。BOTH は RO を先に走らせ、残りを '
            + 'RPM が埋めます。書き込みを始めるのは APPLY、取り消すのは REVERT です。',
        anchorsNote: (n: number) => `測定済み ${n} セルは固定されています。ここからは動かせません。`,
        unitNote: '普段は GAIN のままにしてください。GAIN は隣のグリッドと同じ勾配で、赤もバイオレットもこの勾配から決まっているからです。RF は充填そのものですが、縦軸が列全体（約 '
            + '0.05〜1.2）に広がるので、動かした分では線がほとんど動きません。SHAPE REPAIR がどれだけ動かしたかを見るときだけ % vs BASE にしてください。BASE '
            + 'が 0 の水平線になり、動かした分がそのまま上下に出ます。',
        gainZeroNote: 'GAIN のグラフでは、線がゼロより下に沈んでいるところを探してください。そこが FALLING、スロットルを開けて入る空気が減っている範囲です。GAIN STEPS の側に引ける線はありません。'
            + 'こちらは、線がカクッと折れているところを探します。',
        profileCol: '回転数を 1 つに固定して、開度に沿って表を切った図（断面）です。左から右へ、ペダルを踏み込んでいく順に並びます。GAIN で見ているなら、線がゼロより下に沈んだところが FALLING '
            + 'です。',
        profileRow: '開度を 1 つに固定して、回転数に沿って表を切った断面です。左から右へ回転が上がります。回転が上がって充填が下がるのはこのエンジンでは正常で、SHAPE REPAIR もここでは直しません。',
        pickForProfile: 'グリッドでセルを選ぶと、そのセルを通る 1 本の線で表を切った図が PROFILE に出ます。以降はグラフ上の点をタップすれば、同じ線の上を隣のセルへ移動できます。表全体を立体で見るなら '
            + 'SURFACE に切り替えてください。',
        axisEvenTag: 'x: 等間隔',
        axisScaleTag: 'x: 実寸',
        profileAxisNote: '横軸は実際の値ではなく、表が数字を持っている開度の目盛りを 1 つずつ等間隔に並べたものです。グリッドと同じ間隔で、下端に詰まった低開度の行が読めるのはこの軸だけです。',
        profileScaleNote: '横軸は実際の値です。線の傾きがそのまま勾配になるのはこの軸だけですが、24 ある開度の目盛りは大半が 5 % 以下にあり、チューンが触った範囲は左端で重なって読めません。傾きを読み終えたら '
            + 'EVEN に戻してください。',
        axisNote: '普段は EVEN のままにしてください。EVEN は 0.05 % 幅の目盛りも 15 % 幅の目盛りも同じ幅で描くので、低開度の行はこの軸でしか読めません。線の傾きをそのまま勾配として読みたいときだけ '
            + 'TO SCALE に切り替えてください。',
    },
};


export interface ShapeWorkspace {
    t: (typeof TEXT)['en'];
    lang: 'ja' | 'en';
    tuned: VEMap | null;
    base: VEMap | null;
    anchored: boolean[][] | null;
    /** Everything downstream needs these; false means the tab shows its empty state. */
    ready: boolean;
    opts: ShapeRepairOptions;
    set: <K extends keyof ShapeRepairOptions>(k: K, v: ShapeRepairOptions[K]) => void;
    selected: { row: number; col: number } | null;
    /** Tapping the selected cell again clears it, which is the grid's own convention. */
    pick: (row: number, col: number) => void;
    /** Move the selection along the CUT, from the chart — see ShapeGraph. */
    pickAlongCut: (index: number) => void;
    /**
     * Move the axis the 2-D cut is PINNED at — the slider under the chart.
     *
     * The other half of `pickAlongCut`, and the two move perpendicular to each other. That one
     * walks a point along the line being read; this one changes WHICH line is read, leaving the
     * point where it is on the new one. Cutting down a column, this steps the column; cutting
     * across a row, it steps the row.
     */
    pickPinned: (index: number) => void;
    cut: 'column' | 'row';
    setCut: (v: 'column' | 'row') => void;
    unit: 'value' | 'ratio' | 'gain';
    setUnit: (v: 'value' | 'ratio' | 'gain') => void;
    /**
     * Which of the graph pane's two views is up, and which x axis the cut is drawn on.
     *
     * Here rather than in ShapeGraph because the graph pane UNMOUNTS on a phone: switching to MAP
     * makes `graphOnScreen` false, and a `useState` inside the component went back to its default
     * every time you looked at the grid and came back (operator, 2026-08-26). This hook lives in
     * page.tsx and never unmounts, so the view survives the switch.
     */
    view: 'surface' | 'profile';
    setView: (v: 'surface' | 'profile') => void;
    xScale: 'even' | 'scale';
    setXScale: (v: 'even' | 'scale') => void;
    /** Whether the parameter popover is open — same reason, plus it has two instances (the wide
     *  cluster and the footer) that must not disagree about it. */
    controlsOpen: boolean;
    setControlsOpen: (v: boolean) => void;
    proposal: ShapeRepairResult | null;
    applied: ShapeRepairResult | null;
    /** What the map and the chart show: the applied repair if there is one, else the proposal. */
    shownRepair: ShapeRepairResult | null;
    report: ShapeReport | null;
    baseReport: ShapeReport | null;
    /** The gains, as a grid the map can render. */
    gainMap: VEMap | null;
    /** The tuned surface WITH whatever repair is shown. */
    shownMap: VEMap | null;
    /**
     * What the 3-D view draws, in whatever unit the chart is set to — grid, scale and axis name
     * together, because the three have to agree and a caller assembling them separately is how a
     * signed grid ends up on the sequential scale.
     */
    surface: {
        grid: VEMap;
        scale: 'magnitude' | 'deviation';
        midpoint: number;
        zLabel: string;
    } | null;
    /**
     * Whether the map SHAPE is about to repair has stopped moving — see convergence.ts.
     *
     * SHAPE is a projection onto a constraint set, so it makes whatever surface it is given
     * monotone and smooth. Given one drive's output it does that to that drive's NOISE, and a
     * smoothed error is worse than a rough one because it looks deliberate. This is what lets the
     * tab say so instead of applying it.
     */
    convergence: ConvergenceReport;
    /** Non-null means APPLY is refused, and this is the reason to render. */
    shapeBlocked: string | null;
    anchorCount: number;
    anchorCol: boolean[] | undefined;
    colShaped: boolean;
    /** One line of a grid, cut whichever way the chart is set to, in the chosen unit. */
    seriesFor: (grid: readonly (readonly number[])[] | undefined) => (number | null)[];
    cell: ShapeReport['cells'][number][number] | null;
}

export function useShapeWorkspace({ tuned, base, anchored, applied, demandMap, hitMap }: {
    tuned: VEMap | null;
    base: VEMap | null;
    anchored: boolean[][] | null;
    applied: ShapeRepairResult | null;
    /** The current derivation's pre-gain demands and sample counts, for the convergence test. */
    demandMap?: number[][] | null;
    hitMap?: number[][] | null;
}): ShapeWorkspace {
    const lang = useDialogLang() === 'ja' ? 'ja' : 'en';
    const t = TEXT[lang];
    const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
    const [opts, setOpts] = useState<ShapeRepairOptions>(SHAPE_REPAIR_DEFAULTS);
    const set = <K extends keyof ShapeRepairOptions>(k: K, v: ShapeRepairOptions[K]) =>
        setOpts(o => ({ ...o, [k]: v }));

    /** Which way the profile chart cuts. Independent of which way the FILL runs — you often want to
     *  look across rpm at a repair that ran down the opening axis, because that is where a fill in
     *  one direction shows up as a step in the other. */
    const [cut, setCut] = useState<'column' | 'row'>('column');
    /**
     * What the chart plots, and the default is NOT the obvious one.
     *
     * A column of this table spans roughly 0.01 to 0.87 filling. The corrections a drive produces
     * are one to five percent of a cell, so on an axis carrying the whole column a 3 % change to a
     * 0.11 cell is about half a pixel — the chart looked static while the numbers moved, which is
     * the first thing anyone reported about it. Plotting the RATIO to BASE puts the flat line at
     * zero and every adjustment at full height. The absolute view is still one tap away, because
     * judging monotonicity needs it.
     */
    const [unit, setUnit] = useState<'value' | 'ratio' | 'gain'>('gain');
    const [view, setView] = useState<'surface' | 'profile'>('surface');
    /** Even by default: it is the spacing the grid uses, and the only one in which the low-opening
     *  rows are legible. TO SCALE is a tap away and is the only axis a slope can be read off. */
    const [xScale, setXScale] = useState<'even' | 'scale'>('even');
    const [controlsOpen, setControlsOpen] = useState(false);

    /**
     * The proposal, recomputed on every change to a parameter. Cheap enough to do live — 480 cells
     * over twenty columns of arithmetic — and that is the point: the chart has to move while the
     * slider does, or the operator is adjusting a number against a memory of the last result.
     */
    const proposal: ShapeRepairResult | null = useMemo(() => {
        if (!tuned || !base || !anchored) return null;
        return repairShape(base.data, tuned.data, anchored, tuned.yAxis, opts, tuned.xAxis);
    }, [tuned, base, anchored, opts]);

    /** APPLY freezes a proposal; changing a parameter afterwards proposes again over the top. */
    const shownRepair = applied ?? proposal;

    /**
     * The same repair, at LOW PRIORITY, for everything that draws a picture of it.
     *
     * ## Measured, because the obvious diagnosis was wrong
     *
     * Dragging STEP CAP was reported as very sluggish. The natural suspicion is the arithmetic —
     * a repair and an analysis over 480 cells, live, on every pixel of the drag. Benched on the
     * real table it is **0.10 ms and 0.20 ms**. The tick costs **30-50 ms**. So 99 % of it is the
     * RENDER: the grid is 504 table cells, and although `MapEditor` is `React.memo`, its props are
     * a fresh `gainMap` object and a fresh `cellTint` closure every tick, so memo compares by
     * reference, finds two new references, and re-renders all 504.
     *
     * Debouncing would have been the wrong fix twice over: it makes the picture lag on purpose,
     * and it does not reduce the work, only its rate. `useDeferredValue` keeps the SLIDER on the
     * urgent path — its own label tracks the thumb at full rate — while the pictures re-render at
     * low priority, and React ABANDONS an in-progress low-priority pass when the next drag event
     * arrives. So a fast drag costs one redraw at the end rather than one per pixel, and a slow
     * one still redraws continuously.
     *
     * `shownRepair` itself stays urgent: APPLY hands `proposal` to the write, and that must be the
     * grid the numbers on screen were computed from, not one frame behind it.
     */
    const viewRepair = useDeferredValue(shownRepair);

    const report: ShapeReport | null = useMemo(
        () => (tuned ? analyseShape(viewRepair?.values ?? tuned.data, base?.data ?? null, tuned.yAxis) : null),
        [tuned, base, viewRepair]);
    const baseReport: ShapeReport | null = useMemo(
        () => (base ? analyseShape(base.data, null, base.yAxis) : null),
        [base]);

    /** The gains, as a grid the map can render. One fewer interval than rows, so the top row is
     *  blank — rendered as 0 rather than omitted, because the grid is rectangular. */
    const gainMap: VEMap | null = useMemo(() => {
        if (!tuned || !report) return null;
        return {
            xAxis: tuned.xAxis, yAxis: tuned.yAxis,
            data: report.cells.map(row => row.map(c => c.gain ?? 0)),
        };
    }, [tuned, report]);

    /**
     * The surface the 3-D view draws: the tune as it stands, repair included.
     *
     * NOT the gains. The gain grid is the diagnostic, and it steps by 13x between its own intervals
     * because the opening axis does — a surface of it is one spike and a floor. The shape being
     * repaired is the FILLING surface, where a kink is visible as a kink and the profile beside it
     * is one cut through the same object (operator, 2026-08-26).
     */
    const shownMap: VEMap | null = useMemo(() => {
        if (!tuned) return null;
        return viewRepair ? { ...tuned, data: viewRepair.values.map(r => [...r]) } : tuned;
    }, [tuned, viewRepair]);

    /**
     * The surface, in the unit the chart is set to.
     *
     * One switch for both views (operator, 2026-08-26): the profile and the surface are the same
     * object, so a unit that applied to only one of them left the two answering different
     * questions. GAIN and % vs BASE are SIGNED — zero is the interesting value in both — so they
     * take the diverging scale centred there, where RF takes the sequential one.
     *
     * Falls back to RF when the ratio is asked for without a BASE to compare against, which is the
     * one case where the requested unit cannot be computed at all.
     */
    const surface = useMemo(() => {
        if (!shownMap) return null;
        if (unit === 'gain' && gainMap) {
            return { grid: gainMap, scale: 'deviation' as const, midpoint: 0, zLabel: LABEL.gain };
        }
        if (unit === 'ratio' && base) {
            return {
                grid: {
                    ...shownMap,
                    data: shownMap.data.map((row, r) => row.map((v, c) => {
                        const b = base.data[r]?.[c];
                        return b ? 100 * (v / b - 1) : 0;
                    })),
                },
                scale: 'deviation' as const, midpoint: 0, zLabel: LABEL.unitRatio,
            };
        }
        return { grid: shownMap, scale: 'magnitude' as const, midpoint: 0, zLabel: 'RF %' };
    }, [shownMap, gainMap, base, unit]);

    const ready = !!(tuned && report && gainMap);
    const col = selected?.col ?? null;
    const row = selected?.row ?? null;

    /** One line of a grid, cut whichever way the chart is set to. */
    const rawLine = (grid: readonly (readonly number[])[] | undefined): (number | null)[] => {
        if (!grid) return [];
        if (cut === 'row') return row === null ? [] : (grid[row] ?? []).map(v => v ?? null);
        return col === null ? [] : grid.map(r => r[col] ?? null);
    };
    const baseLine = rawLine(base?.data);
    /** The axis the cut runs along — the one the gain is measured against. */
    const cutAxis = tuned ? (cut === 'row' ? tuned.xAxis : tuned.yAxis) : [];
    /**
     * The line's own gradient, indexed the way the GRID indexes it.
     *
     * `cells[r].gain` is the interval ABOVE row r, so the last point has none — see analyseShape.
     * Matching that exactly is the point of plotting this at all: a cell the grid paints red is the
     * point on this line that dips below zero, at the same index, and the marker lands on both.
     */
    const gainLine = (line: (number | null)[]): (number | null)[] => line.map((v, i) => {
        const next = line[i + 1];
        const dx = cutAxis[i + 1] - cutAxis[i];
        return v === null || next === null || next === undefined || !dx ? null : (next - v) / dx;
    });
    /** In `ratio` mode every series is expressed as a percentage against the BASE at the same
     *  point, which is what makes a one-percent correction visible at all. */
    const seriesFor = (grid: readonly (readonly number[])[] | undefined): (number | null)[] => {
        const line = rawLine(grid);
        if (unit === 'gain') return gainLine(line);
        if (unit === 'value') return line;
        return line.map((v, i) => {
            const b = baseLine[i];
            return v === null || b === null || b === 0 ? null : 100 * (v / b - 1);
        });
    };
    const anchorCol = !anchored ? undefined
        : cut === 'row'
            ? (row === null ? undefined : anchored[row]?.map(Boolean))
            : (col === null ? undefined : anchored.map(r => !!r[col]));
    const anchorCount = anchored ? anchored.flat().filter(Boolean).length : 0;

    /**
     * Whether this drive still wants to move the map, and the sentence to show when it does.
     *
     * Measured over the WHOLE table rather than only the rows SHAPE writes. The low-opening shape
     * is produced by the same air model as the rest of the surface: if the high-load cells are
     * still asking for 15 %, the model is not settled anywhere, and the low rows are being shaped
     * against a base that is about to change under them.
     *
     * An unmeasured map is NOT converged. `converged` is false when nothing was evaluated, so a
     * fresh session cannot slip through the gate by having no evidence to contradict it.
     */
    const convergence = useMemo(
        () => summariseConvergence(demandMap, hitMap),
        [demandMap, hitMap]);
    const shapeBlocked = !ready ? null
        : convergence.converged ? null
            : convergence.evaluated === 0 ? t.blockedNoEvidence
                : t.blockedUnsettled(convergence.unsettled, convergence.evaluated, convergence.worst);
    /** Whether THIS column has a shaped cell. The repair runs per column and leaves a column with
     *  fewer than two anchors entirely alone, so a global count is the wrong test here: it would
     *  draw a violet line exactly over the blue one and label it SHAPED, which claims a proposal
     *  where there is none. */
    const colShaped = !!shownRepair && (cut === 'row'
        ? row !== null && !!shownRepair.shaped[row]?.some(Boolean)
        : col !== null && shownRepair.shaped.some(r => r[col]));

    return {
        t, lang, tuned, base, anchored, ready, opts, set,
        selected,
        pick: (r, c) => setSelected(s => (s && s.row === r && s.col === c ? null : { row: r, col: c })),
        // The chart's own axis is the OTHER one from the cut: cutting down a column, a point on it
        // is a row. Selecting from there keeps the column and moves the row, so the line being read
        // does not change under the finger — only the marker on it.
        pickAlongCut: (i) => setSelected(s => (
            !s ? s : cut === 'row' ? { row: s.row, col: i } : { row: i, col: s.col }
        )),
        // The perpendicular of the above: the index it holds still is the one this moves.
        pickPinned: (i) => setSelected(s => (
            !s ? s : cut === 'row' ? { row: i, col: s.col } : { row: s.row, col: i }
        )),
        cut, setCut, unit, setUnit, view, setView, xScale, setXScale,
        controlsOpen, setControlsOpen,
        proposal, applied, shownRepair, report, baseReport, gainMap, shownMap, surface,
        convergence, shapeBlocked,
        anchorCount, anchorCol, colShaped, seriesFor,
        cell: selected && report ? (report.cells[selected.row]?.[selected.col] ?? null) : null,
    };
}
