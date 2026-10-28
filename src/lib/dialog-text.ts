/**
 * Copy for the browser's native `alert` / `confirm` dialogs — and for the handful of plain-string
 * notices rendered outside a React dialog — in both display languages.
 *
 * The second case arrived with the notice line on the hub, which had shipped an English-only string
 * written inline at the call site: exactly the failure the rule below exists to prevent. A plain
 * string is not JSX, so the component-local TEXT + useDialogLang pattern buys nothing there; it
 * belongs here.
 *
 * The React dialogs each carry their own TEXT record and pick from it with `useDialogLang`. The
 * native ones had nothing: they were written inline at the call site, so whichever language the
 * author happened to be thinking in is what shipped — the destructive hardware paths ended up
 * Japanese, the session-management ones English, and the log-discard confirms English in an app
 * whose owner reads Japanese. Same rule, one place, so a new call site cannot quietly reintroduce
 * a single-language string.
 *
 * These are called from event handlers rather than during render, which is why the language is
 * resolved by a plain function instead of a hook. It is derived from `navigator.language` and
 * cannot change while the tab is open, so there is nothing for a hook to subscribe to.
 *
 * Chrome stays out of here. Button labels, tooltips and column headings are uppercase technical
 * shorthand (WRITE, PATCH, TUNED) that is the same word in both languages and is part of the
 * instrument's vocabulary — translating those would break the label-is-a-promise chain, not serve it.
 */

import type { RouteId } from '@/lib/log-engine/logProfile';

export type DialogLang = 'ja' | 'en';

// ブラウザの言語設定から表示言語を判定する。日本語(ja / ja-JP 等)なら日本語、それ以外はすべて英語。
// navigator が無い環境(サーバープリレンダー)では既定の日本語を返すが、ダイアログはすべてクライアント
// でのみ現れるため、実際の判定は常にクライアントで行われる。
export function detectDialogLang(): DialogLang {
    if (typeof navigator === 'undefined') return 'ja';
    const primary = (navigator.language || navigator.languages?.[0] || '').toLowerCase();
    return primary.startsWith('ja') ? 'ja' : 'en';
}

/** What the DME needs after any write. Quoted into several messages, so it is written once. */
const KEY_CYCLE_JA =
    '次の手順で終了してください:\n' +
    '1. イグニッションキーを OFF にする\n' +
    '2. そのまま 10秒間 待つ\n' +
    '3. キーを ON に戻す\n\n' +
    'DMEが新しいデータで再初期化されます。';

const KEY_CYCLE_EN =
    'Finish with these steps:\n' +
    '1. Switch the ignition key OFF\n' +
    '2. Wait 10 seconds\n' +
    '3. Turn the key back ON\n\n' +
    'The DME reinitializes with the new data.';

/**
 * Which campaign shape a write belongs to, in one line at the top of the confirm.
 *
 * There is no route B any more — the VE map and the correction table in one flash, the VE divided
 * by k_new. The two are never armed together now (one drive's VE error would land in both), so a
 * table write is A1 whatever run measured it, and nothing divides. `verify:route` pins that.
 */
const ROUTE_TEXT: Record<DialogLang, Record<RouteId, string>> = {
    ja: {
        NONE: '',
        CONSERVATIVE: 'ROUTE 0 — BMW の EGT 補正表はそのままです。VE マップだけを書きます。\n\n',
        A1: 'ROUTE A · 第1段 — EGT 補正表 (KF_RF_KORR_DRREL) だけを書きます。VE マップは含まれません。\n'
            + '  この後はセッション一覧の Actions → NEXT で新しいセッションを作り、そこで VE を測ってください。\n\n',
        A2: 'ROUTE A · 第2段 — VE マップを書きます。補正表はこのキャンペーンで既に書き換え済みです。\n\n',
    },
    en: {
        NONE: '',
        CONSERVATIVE: "ROUTE 0 — BMW's EGT correction table is left alone. Only the VE map is written.\n\n",
        A1: 'ROUTE A step 1 — the EGT correction table (KF_RF_KORR_DRREL) alone. No VE map.\n'
            + '  Continue with Actions → NEXT in the session list and measure VE in that new session.\n\n',
        A2: 'ROUTE A step 2 — the VE map. The correction table was already replaced by this campaign.\n\n',
    },
};

const JA = {
    // --- workspace / session housekeeping ---
    clearLog: 'このデータログ(CSV)を破棄しますか？',
    // 更新はリロードなので、接続中・記録中は失うものがある。何を失うかを具体的に述べてから聞く。
    reloadBusy: 'アプリを再読み込みします。\n\nDMEとの接続は切断され、記録中のデータログと保存していないチューンは失われます。\n\n続行しますか？',
    // ワークス版のサインインし直し。同じタブで m3 を往復するので、ページは置き換わる。
    reauthUnsaved: 'サインインし直すため、このページを m3 経由で開き直します。\n\nまだ保存していないチューンやデータログは失われます。保存済みのものはこの端末に残ります。\n\n続行しますか？',
    reauthTitle: 'ワークス版のサインインが切れています。押すと m3 を経由してこの画面に戻ります。SYNC はそれまで待機し、この端末のデータはそのまま残ります。',
    discardLog: '今記録したデータログを破棄して、最初からやり直しますか？',
    deleteSession: (label: string) => `「${label}」を削除しますか？この操作は取り消せません。`,
    noStoredBinary: 'このセッションにはBINが保存されていません。',
    // 別の端末から、より新しい版がクラウドに送られている。上書きすると、その端末の分が消える。
    syncOverwriteNewer: (label: string, at?: number) => `「${label}」は、別の端末から${at ? `（${new Date(at).toLocaleString('ja-JP')}）` : ''}新しい版がクラウドに送られています。

この端末の版で上書きすると、その版はクラウドから消えます。先に取り込むなら、キャンセルしてクラウドの一覧から取り込んでください。

上書きして送りますか？`,
    noStoredTune: 'このセッションにはまだTUNEDが保存されていません。',
    noStoredLog: 'このセッションにはデータログが保存されていません。',

    titleRunPreflight: '走行前の確認',
    runPreflight: (profile: string, missing: string[]) =>
        `${profile} のランに必要なパッチが、いま ECU に入っていません。` + '\n\n'
        + missing.map(m => m === 'PATCH'
            ? '・PATCH — MAP補正とLTFT学習が生きたままです。トリムはVE誤差ではなく、'
            + 'DMEが自分で補正した結果を映します。'
            : '・TANK VENT — パージバルブが開きます。EGTランは block 19 を読まないので、'
            + '起きていても検出できません。').join('\n')
        + '\n\n先に WRITE PATCH-ON を当ててから走るのが本来の順序です。'
        + '\nこのまま走ることもできますが、そのログが何を測っているかは保証されません。',
    btnRunAnyway: 'このまま走る',
    titleIdleSource: 'MD_LLRI の出どころが確認できません',
    idleSourceUnproven: (detail: string) =>
        'このランの測定は MD_LLRI ただ 1 つです。RAM の 0xFFD8F0 がその値だという根拠は'
        + '逆アセンブルであって、この ECU がそう答えるかは別の話なので、走行前に'
        + 'ブロック 19 の同じ量と突き合わせています。\n\n'
        + `結果: ${detail}\n\n`
        + 'アドレスが違っていた場合、出てくるのは「エラー」ではなく、もっともらしい数値で'
        + '埋まった 3 分間です。それを元に KF_LLS_TV を書き換えると、間違いは車に入ります。\n\n'
        + '考えられる原因: エンジンが回っていない（両方 0 で一致しない）、'
        + 'DME が RAM 読みを断っている、この系統のキャリブレーションでアドレスが違う。\n\n'
        + 'まずエンジンを暖機アイドルで回した状態でもう一度試すことを勧めます。',
    btnIdleRunAnyway: '確認せずに記録する',
    notReconstructed: '保存されたデータログからこのセッションを再構築できませんでした。マップはもう一度書けません。'
        + 'パッチのスイッチは書けます(車に入っている BIN から組み立てます)。',
    setBaseFirst: '先にBASEを設定してください(BINを読み込むか、DMEから読み出してください)。',
    parseBinaryFailed: (message: string) => `BINの解析に失敗しました: ${message}`,
    noValidCsvData: 'CSVから有効なデータを読み取れませんでした。',

    saved:
        'セッションを保存しました。DRAFT のままです — フィルターを変えて再計算し、保存し直せます。\n' +
        '読み取り専用になるのは、チューンを ECU に WRITE したときだけです(パッチだけの WRITE ではなりません)。\n\n' +
        'OK        = このまま読み込んでおく(すぐ WRITE できます)\n' +
        'キャンセル = ワークスペースを閉じてセッション一覧に戻る',

    // --- 中断されたデータログの復元 ---
    recoverRun: (a: { points: number; startedAt: number; ended: boolean; mock: boolean }) =>
        `保存されていないデータログが残っています。${a.mock ? '(PRACTICE)\n' : '\n'}` +
        `\n記録開始: ${new Date(a.startedAt).toLocaleString()}\n` +
        `サンプル数: ${a.points.toLocaleString()} 件\n` +
        (a.ended
            ? '\nログは正常に終了しましたが、保存前に画面が閉じられたようです。\n'
            : '\n記録中に画面が閉じられたようです(リロード・クラッシュ・スリープなど)。\n') +
        '\nOK        = このログを復元する(BASEも一緒に読み込みます)\n' +
        'キャンセル = 復元しない(このデータは破棄されます)',
    recoverFailed: 'データログを復元できませんでした。元のセッションのBINが見つかりません。',
    keepRunFailed: '画面にあるデータログをセッションに残せなかったので、記録を始めませんでした。SAVE してから、もう一度 START を押してください。',

    // --- data log ---
    // 通信が途切れてログが止まったときだけ出す。STOP で止めたときは接続を残し、何も出さない
    // （リングが START TUNE に戻り、その下の案内が書き込み方を言う）。
    logLost: (failure: string) =>
        '⚠ 通信が途切れたため、データログを中断しました。\n\n' +
        `理由: ${failure}\n\n` +
        '※ ここまでに記録したサンプルは保持しています。\n' +
        '※ 接続はここで解除しました。\n\n' +
        '続けて記録するなら、CONNECTION で接続し直して START TUNE。\n\n' +
        'DMEへ書き込むなら:\n' +
        '1. WRITE の ALPHA-N を ON\n' +
        '2. エンジンを停止し、イグニッションを ON に戻す(エンジンはかけない)\n' +
        '3. CONNECTION で接続し直す → WRITE\n\n' +
        '書き込まずに書き出すなら、ALPHA-N を ON にしてから DOWNLOAD TUNED(WRITE が送るバイト列そのもの)。',
    // OBSERVE: the same stop, without the WRITE route — an observation run derives nothing to write.
    observeLost: (failure: string) =>
        '⚠ 通信が途切れたため、観察ランを中断しました。\n\n' +
        `理由: ${failure}\n\n` +
        '※ ここまでに記録したサンプルは保持しています。\n' +
        '※ 接続はここで解除しました。\n\n' +
        '記録は OBSERVE タブの BYTES と、ログの Watch・Mark 列に残っています。\n' +
        'このランは書き込むものを作りません。名前は、何と一緒に動いたかを見て、あとで付けます。',

    // --- flashing the DME ---
    writeConfirm: (a: { tuned: boolean; patchOn: boolean; drift: string[]; android: boolean; verifyMode: 'quick' | 'full'; boostBaud: number | null; tankVentOff: boolean; kHold: boolean; route: RouteId }) =>
        'DMEへ書き込みます。\n\n' +
        ROUTE_TEXT.ja[a.route] +
        `書き込む内容: ${a.tuned
            ? 'チューニング済みマップ'
            : `⚠ マップは変更しません(パッチのみ) — ${a.patchOn ? 'PATCH ON' : 'PATCH OFF'}`}\n` +
        // 検証方式は「何を証明したことになるか」を変える。ダイアログが「検証OK」と言う意味が
        // モードによって違う以上、消去の前にどちらで走るかを明示しないと約束が曖昧になる。
        `検証方式: ${a.verifyMode === 'full'
            ? 'FULL — DME自身のチェックサム照合に加えて、全65536バイトを読み戻してバイト単位で比較します。'
            : 'QUICK — DME自身のチェックサム照合(DS2 0x0A)。ECUが自分のフラッシュに保持するCRCとの一致を1往復で確認します。'}\n` +
        (a.verifyMode === 'quick'
            ? '  ※ QUICKはカバー範囲65536バイト中65528バイト。ただし不一致の「位置」は分かりません。\n'
            : '') +
        (a.boostBaud
            ? `\n⚠ BOOST ${a.boostBaud} が有効です（実験）。\n`
            + '  消去の直後にボーレートを上げます。DME は programming session の中でしかこのレートを受け付けません。\n'
            + '  切替が拒否されたら 9600 のまま書き込みます。受理されたのに応答が止まった場合は、\n'
            + '  書き込み電文を 1 バイトも送らずに 9600 へ戻します。\n'
            + '  ⚠ どちらのレートでも応答しなくなった場合、データ領域が消去されたまま中断します。\n'
            + '    復旧は「イグニッション OFF → 10 秒 → ON → 再接続 → WRITE をやり直し」です。\n'
            + '    WRITE は必ず消去からやり直すので、再実行は安全です。\n'
            : '') +
        (a.tankVentOff
            ? `\n⚠ TANK VENT: SHUT — タンク換気を無効にしたまま書き込みます。\n`
            + '  ログに出ないパージ学習も止めます。\n'
            + '  目的はチューニング走行中の再現性です。この BIN はそのまま走り続けるためのものではありません。\n'
            + '  キャニスタがパージされなくなり、飽和すれば燃料臭や DTC 24（タンク換気バルブ）の原因になります。\n'
            + '  ログを取り終えたら TANK VENT を OEM に戻してもう一度書き込んでください。\n'
            + '  ファイル名に _TEVOFF が付き、セッションにも記録されます。\n'
            : '') +
        // K HOLD が入った BIN を書くときだけ。走り続ける BIN ではないことを、消去の前に言う。
        (a.kHold
            ? `\n⚠ K HOLD: 1.000 — 冷えた排気の増量が切れ、2400–3000 rpm の部分負荷で点火が最大 2.3° 進む。\n`
            + '  計測用の BIN で、FINALIZE で純正に戻る。\n'
            : '') +
        (a.drift.length ? `\n⚠ 保存時と異なるオプションで書き込みます:\n  ${a.drift.join('\n  ')}\n` : '') +
        '\n⚠ エンジンが停止していること(キーOFF → 再度イグニッションON)を確認してください。\n' +
        '  エンジンが回っているとDMEが書き込みを拒否します。\n' +
        `⚠ 電源(バッテリー)を安定させてください。書き込みには約${a.verifyMode === 'full' ? '4分半' : '2分半'}かかります。\n` +
        '  書き込み中は絶対に電源を切ったり、ケーブルを抜いたりしないでください。\n' +
        // ブラウザ側のダイアログは文言を指定できないため、理由を説明できるのはここだけである。
        '  ブラウザのタブを閉じたり、リロードしたりしないでください。\n' +
        '  (閉じようとすると確認が出ますが、確認を無視すれば離れられてしまいます)\n' +
        // Android では beforeunload の発火が不確実で、上の「確認が出ます」が当てにならない。
        // 画面消灯・アプリ切替も接続を落としうるため、防げない分をここで明示する。
        (a.android
            ? '⚠ この端末(Android)では次の点にも注意してください:\n' +
            '  画面を消灯させないでください(書き込み中は自動消灯を抑止しますが、手動での消灯は防げません)。\n' +
            '  他のアプリに切り替えないでください。\n' +
            '  OTGケーブルとコネクタが動かないよう固定してください。\n'
            : '') +
        '\nチェックサムは自動補正されます。全テレグラムのverifyバイトは両モードとも必ず検査します。\n\n' +
        '続行しますか？',

    /**
     * Shown on the notice line when no byte transport can reach a DME here.
     *
     * Android and desktop fail for entirely different reasons and need different remedies, so this
     * takes the platform rather than shipping one vague sentence that fits neither: on Android
     * `navigator.serial` exists but only enumerates Bluetooth SPP, so the answer is WebUSB + OTG,
     * not "use Chrome" — the user is already in Chrome.
     */
    // 戻り値を string と明示しているのは、リテラル型に推論されると EN 側が JA のリテラル和型に
    // 代入できなくなるため。EN が JA から型付けされている(NativeDialogText)ことによる制約。
    noTransport: (a: { android: boolean }): string => a.android
        ? 'DMEに接続できません — USB OTGアダプタと、WebUSB対応ブラウザ(Chrome)が必要です。PRACTICEならオフラインで試せます。'
        : 'DMEに接続できません — Chrome/Edgeが必要です(Web Serial API)。PRACTICEならオフラインで試せます。',

    /**
     * 走行中のログでリンクが切れ、同じケーブルで再接続しているあいだ（liveSupervisor.ts）。
     *
     * 三つとも「ログは止まっていない」を言う。この行を見る人が最初に知りたいのはそれで、
     * 赤（エラー）ではなく黄（注意）なのもそのため。止まるときは別の文（logLost）が出る。
     * 電話の幅では二行に切れるので、短く保つ。
     */
    linkLost: (): string => 'リンクが切れました — 同じケーブルで再接続しています。ログは止めていません。',
    linkRetrying: (attempt: number, elapsedS: number): string =>
        `リンク断 ${Math.round(elapsedS)} 秒 — 再接続 ${attempt} 回目も応答なし、続けて試しています。`
        + 'ケーブルとコネクタを確認してください。ログは止めていません。',
    linkResumed: (gapS: number): string =>
        `リンクが ${gapS.toFixed(1)} 秒途切れ、再接続しました。途切れた区間はログに記録し、直後は解析から外します。`,

    /**
     * ASSISTANT をオンにする前の確認。何が・どこへ・何のために送られ、何ができないかを一度だけ言う。
     * 送り先は二つ（TSUNAGI の中継と、利用者が接続した AI サービス）で、後者はこちらの管理外 ——
     * それを伏せると、プライバシーポリシーの約束（ワークス版の節）と画面が食い違う。
     */
    titleAssistantOn: 'ASSISTANT をオンにする',
    assistantOn: (): string =>
        'あなたが接続した AI アシスタントが、このタブに問い合わせられるようになります。\n\n'
        + '送るもの: アシスタントが求めたときだけ、このタブの状態（端末の名前（付けていなければ「ナビ」などの既定の名前）・接続・ログの有無・モード・開いているセッション）、この端末に保存したセッションの一覧（番号・名前・日時・BIN とログの有無）、記録済みのデータログの一部（回転・負荷・点火角・ノックなど、観察モードでは指定アドレスのバイト値と印）、開いているセッションのキャリブレーションのうち問い合わせた項目（名前・説明・アドレス・単位・値）、クラウドに送ったセッションの一覧（名前・日時・チューンとログの有無）。VIN とファイル名は送りません。\n'
        + '経路: TSUNAGI の中継（Cloudflare）を通ります。中継は何も保存しません。つなぐとき、端末を見分ける無作為な番号と、ナビから開いたかどうかを中継に伝えます（中継はメモリ上でだけ扱います）。\n'
        + '届く先: あなたがアシスタントに接続したサービス（claude.ai など）。そこでの扱いは、そのサービスの規約によります。\n\n'
        + 'できること: ログの開始と停止、画面の切り替え、セッションを開く・新しく作る・コピーする（NEXT）こと、保存していない変更を捨てること、観察（OBSERVE）の計画の設定とログへの印付け、キャリブレーションの値の変更（CALIBRATION に変更として置きます）、SAVE、クラウドへの送信（SYNC）とクラウドからの取り込み（記録中はしません。送信と取り込みのデータは、このタブとクラウドの間で直接やり取りします）、この端末で前に選んだケーブルへのつなぎ直しと切断、MONITORING への切り替え。\n'
        + 'できないこと: 車への書き込み・フラッシュと、新しいケーブルを選ぶこと。これらの操作は、あなたが頼んだか、声で確認したときだけです。何かを失う操作（保存していない作業を捨てる、別の端末の新しい版を上書きする、取り込みで置き換える、ログの停止）は、必ず読み上げて確認します。\n\n'
        + 'いつでもここでオフにできます。',
    btnAssistantOn: 'オンにする',

    /**
     * 読み取ったBINのチェックサムが合わなかったときだけ出る。成功時は何も出さない。
     *
     * 「ECUが壊れている」と読めないように書くこと。このCRC実装はstock BINと実車読み取りの2回、
     * 独立に実地確認されているので誤検出の可能性は低いが、それでも原因として遥かに確からしいのは
     * 通信のほうであり、対処も「読み直す」である。断定はしない。
     */
    readChecksumBad: (a: { slave: boolean; master: boolean }): string => {
        const which = !a.slave && !a.master ? 'SLAVE/MASTER両方' : !a.slave ? 'SLAVE側' : 'MASTER側';
        return `⚠ 読み取ったBINのチェックサムが合いません(${which}) — 転送が壊れた可能性があります。` +
            'チューンに使う前にREADをやり直してください。';
    },

    /**
     * 何をもって「完了」と言っているのかを、実際に走った検証で名乗る。
     *
     * ここは以前「リードバック検証OK」と固定文で書いていた。QUICKを選べるようになった以上、
     * その一文は場合によって嘘になる — そして「検証OK」としか読めない完了画面は、
     * ラベルが約束であるという原則を最も直接に破る場所である。
     */
    writeVerifiedBy: (v: { mode: 'quick' | 'full'; readBack: boolean }): string =>
        v.readBack
            ? '全バイトのリードバック照合＋DMEのチェックサム照合OK'
            : v.mode === 'quick'
                ? 'DMEのチェックサム照合OK(リードバックは実施していません)'
                : '検証は完了しましたが、実施内容を特定できませんでした',

    patchWriteDone: (v: { mode: 'quick' | 'full'; readBack: boolean }) =>
        `✅ パッチの書き込みが完了しました(${JA.writeVerifiedBy(v)})。\n\n` +
        KEY_CYCLE_JA + '\n\n' +
        'その後 CONNECTION で接続し直すと、START TUNE でデータログを開始できます。',

    writeDone: (v: { mode: 'quick' | 'full'; readBack: boolean }) =>
        `✅ 書き込みが完了しました(${JA.writeVerifiedBy(v)})。\n\n` + KEY_CYCLE_JA,

    // NEXT を、それを決める瞬間に聞く。BASE は今書いた BIN そのもの（= 車に入っているもの）。
    nextConfirm:
        '今書き込んだ BIN から、次のセッションを始めますか？(NEXT)\n\n' +
        'OK        = 新規セッションを作成(BASE = 今書き込んだ BIN。スイッチとフィルタ設定を引き継ぐ)\n' +
        'キャンセル = セッション一覧に戻る',

    writeFailed: (reason: string | null, a?: { wasBackgrounded: boolean }) =>
        '❌ 書き込みに失敗しました。\n\n' +
        `理由: ${reason ?? '不明なエラー'}\n\n` +
        // 原因を名指しできるならそうする。「ケーブルが悪いのか」を延々調べるのと、
        // 「バックグラウンドに回ったから」と分かっているのとでは、次にやることが違う。
        (a?.wasBackgrounded
            ? '⚠ 書き込み中にこのアプリが画面から外れました(画面消灯またはアプリ切替)。\n' +
            '  それが原因の可能性が高いです。次回は画面を点けたまま、他のアプリに切り替えずに実行してください。\n\n'
            : '') +
        '⚠ DMEのデータ領域は消去済みで、書き込みが途中の可能性があります。\n' +
        '  この状態でイグニッションを切ったり走行したりしないでください。\n\n' +
        '対処:\n' +
        '1. 電源(バッテリー)とケーブルの接続を安定させる\n' +
        '2. 通信が切れている場合は CONNECTION で接続し直す\n' +
        '3. 書き込みが成功するまで WRITE をやり直す\n\n' +
        '※ WRITE は毎回消去からやり直すため、再実行しても安全です。',

    // --- flash counter / service block ---
    backupMismatch: (a: { connectedVin: string | null; connectedMock: boolean; backupVin: string | null; backupMock: boolean }) =>
        '❌ このバックアップは書き戻せません。\n\n' +
        `接続中のDME: ${a.connectedVin ?? '不明'}${a.connectedMock ? '（PRACTICE）' : ''}\n` +
        `バックアップ: ${a.backupVin ?? '不明'}${a.backupMock ? '（PRACTICE）' : ''}\n\n` +
        '別の車両、またはPRACTICEで取得したデータです。書き戻すと識別情報が壊れます。',

    flashDialogClosed:
        'フラッシュカウンターのリセット処理を終了しました。\n\n' +
        '次の手順で進めてください:\n' +
        '1. イグニッションキーを OFF にする\n' +
        '2. そのまま 10秒間 待つ\n' +
        '3. キーを ON に戻す\n' +
        '4. CONNECTION で接続し直す\n\n' +
        'DMEはサービス情報ブロックを書き直した状態で再初期化されます。\n' +
        '※ 再初期化されるまで、このセッションでの読み書きは行わないでください。\n' +
        '※ 接続はここで解除しました。',

    // --- 表題とボタン ---
    // 上の長文のうち4本は、ネイティブの alert/confirm ではなくアプリ内ダイアログ(MessageDialog)で
    // 出す。683x400 のヘッドユニットではネイティブ側が本文の長さぶんだけ縦に伸び、選択肢が
    // 折り返しの下に隠れるため。ネイティブはボタン文言を自前で用意するので、ここに無かった。
    /**
     * 系譜チェック。書き込みは常に 65536 バイト全体を消して書き直すので、
     * ECU に今入っている較正がこのチューンの BASE でない場合、
     * **アドレスが 1 バイトも重なっていなくても**相手の変更が丸ごと消える。
     * 「少ししか変えていない」という表示は両方のセッションに出るので、これは目視では気づけない。
     */
    lineageBlocked: (summary: string, verdict: 'diverged' | 'unknown' | 'match') =>
        `${summary}\n\n` +
        (verdict === 'diverged'
            ? '書き込みは 65536 バイト全体の消去＋再書き込みです。\n' +
            'いま車両に入っている変更は、**アドレスが重なっていなくても**すべて失われます。\n' +
            '例: VE セッションと慣性セッションを同じ BASE から分岐させると、\n' +
            '  互いに別の領域しか触っていなくても、後から書いた方が先の方を打ち消します。\n\n' +
            '正しい手順: ECU を READ し直し、その READ を BASE に新しいセッションを作る。\n\n'
            : '確認できないことは「問題なし」ではありません。\n' +
            '半分書き込まれた ECU の復旧など、承知のうえで進める理由がある場合のみ続行してください。\n\n') +
        'それでも書き込みますか？',
    titleLineage: '系譜の確認',
    btnFlashAnyway: '承知のうえで書き込む',

    // Shown live, only while the run has gate-open samples it is throwing away for want of a settle.
    // Names the remedy rather than the symptom: the gate is open, so the load is high enough — what
    // is missing is holding it still, and holding it long enough for the exhaust to catch up.
    rfKorrNoAnchorHint: 'アンカー未取得。加速し続けず、アクセル開度を固定して RF を一定に保ってください（上り坂・3〜4速）。'
        + '整定に 3 秒、排気がモデルに追いつくまで 10 秒以上。同じ回転域で繰り返すこと。',
    titleLogFinished: 'データログ終了',
    titleWriteConfirm: 'DMEへ書き込みます',
    titleWriteFailed: '書き込みに失敗しました',
    titleRecoverRun: '保存されていないデータログ',
    btnOk: 'OK',
    btnCancel: 'キャンセル',
    btnClose: '閉じる',
    btnWrite: '書き込む',
    btnRestore: '復元する',
    btnDiscard: '破棄する',
};

type NativeDialogText = typeof JA;

const EN: NativeDialogText = {
    clearLog: 'Discard this data log (CSV)?',
    reloadBusy: 'Reload the app.\n\nThe DME link will drop, and any log being recorded or tune not yet saved will be lost.\n\nContinue?',
    reauthUnsaved: 'Signing in again reopens this page by way of m3.\n\nA tune or a log not yet saved will be lost. Everything saved stays on this device.\n\nContinue?',
    reauthTitle: 'The WORKS build has signed this device out. This goes through m3 and comes straight back here. SYNC waits until then, and everything on this device stays.',
    discardLog: 'Discard the log just recorded and start over?',
    deleteSession: (label: string) => `Delete "${label}"? This cannot be undone.`,
    noStoredBinary: 'This session has no stored binary.',
    syncOverwriteNewer: (label: string, at?: number) => `A newer copy of "${label}" was sent to the cloud from another device${at ? ` (${new Date(at).toLocaleString('en-GB')})` : ''}.

Sending this device's copy replaces it, and that copy is gone from the cloud. To bring it back first, cancel and restore it from the cloud list.

Send over it?`,
    noStoredTune: 'This session has no saved tune yet.',
    noStoredLog: 'This session has no stored log.',

    titleRunPreflight: 'Before this run',
    runPreflight: (profile: string, missing: string[]) =>
        `The ${profile} run needs patches that are not in the ECU right now.` + '\n\n'
        + missing.map(m => m === 'PATCH'
            ? '- PATCH - MAP compensation and LTFT learning are still live, so the trim reports the '
            + 'DME correcting itself rather than the VE error you are trying to measure.'
            : '- TANK VENT - the purge valve will open. An EGT run does not read block 19, so it '
            + 'cannot even see it happening.').join('\n')
        + '\n\nThe intended order is WRITE PATCH-ON first, then drive.'
        + '\nRunning anyway is allowed; what the log measures is then not guaranteed.',
    btnRunAnyway: 'Run anyway',
    titleIdleSource: 'MD_LLRI could not be confirmed',
    idleSourceUnproven: (detail: string) =>
        'This run measures exactly one thing, MD_LLRI. That RAM address is right in a disassembly; '
        + 'whether it is right in THIS ECU is a question only this ECU can answer, so it is checked '
        + 'against the same quantity in block 19 before the run starts.\n\n'
        + `Result: ${detail}\n\n`
        + 'If the address is wrong, what comes back is not an error — it is three minutes of '
        + 'plausible numbers. Writing KF_LLS_TV from those puts the mistake in the car.\n\n'
        + 'Likely causes: the engine is not running (both read zero and cannot agree), the DME is '
        + 'refusing RAM reads, or this calibration puts the channel elsewhere.\n\n'
        + 'Try again with the engine running at a warm idle before overriding this.',
    btnIdleRunAnyway: 'Record without the check',
    notReconstructed: 'This session could not be reconstructed from its stored log, so its map cannot be '
        + 'written again. Its patch switches still can — the build starts from the BIN in the car.',
    setBaseFirst: 'Set a BASE first (upload a BIN or read it from the DME).',
    parseBinaryFailed: (message: string) => `Error parsing binary: ${message}`,
    noValidCsvData: 'No valid data found in CSV.',

    saved:
        'Session saved. It stays a DRAFT — change the filters, re-derive and save again.\n' +
        'Only writing a tune to the ECU makes a session read-only (a patch-only WRITE does not).\n\n' +
        'OK     = keep it loaded (you can WRITE it now)\n' +
        'Cancel = close the workspace and return to the session list',

    recoverRun: (a: { points: number; startedAt: number; ended: boolean; mock: boolean }) =>
        `An unsaved data log was left behind.${a.mock ? ' (PRACTICE)\n' : '\n'}` +
        `\nStarted: ${new Date(a.startedAt).toLocaleString()}\n` +
        `Samples: ${a.points.toLocaleString()}\n` +
        (a.ended
            ? '\nThe log finished normally, but the page was closed before it was saved.\n'
            : '\nThe page went away while it was still recording (reload, crash, or sleep).\n') +
        '\nOK     = restore this log (the BASE is loaded with it)\n' +
        'Cancel = do not restore (this data will be discarded)',
    recoverFailed: 'The data log could not be restored — the original session\'s binary is missing.',
    keepRunFailed: 'The data log on screen could not be kept in the session, so recording did not start. SAVE, then press START again.',

    logLost: (failure: string) =>
        '⚠ The data log stopped because the link was lost.\n\n' +
        `Reason: ${failure}\n\n` +
        'Note: the samples recorded up to that point have been kept.\n' +
        'Note: the connection was released here.\n\n' +
        'To record another run, reconnect with CONNECTION, then START TUNE.\n\n' +
        'To write to the DME:\n' +
        '1. Under WRITE, turn ALPHA-N on\n' +
        '2. Stop the engine and switch the ignition back ON (do not start the engine)\n' +
        '3. Reconnect with CONNECTION → WRITE\n\n' +
        'To export without writing, turn ALPHA-N on, then DOWNLOAD TUNED (the exact bytes WRITE sends).',
    observeLost: (failure: string) =>
        '⚠ The observation run stopped because the link was lost.\n\n' +
        `Reason: ${failure}\n\n` +
        'Note: the samples recorded up to that point have been kept.\n' +
        'Note: the connection was released here.\n\n' +
        'What it saw is under BYTES on the OBSERVE tab, and in the log\'s Watch and Mark columns.\n' +
        'This run makes nothing to write. The names come afterwards, from what moved with what.',

    writeConfirm: (a: { tuned: boolean; patchOn: boolean; drift: string[]; android: boolean; verifyMode: 'quick' | 'full'; boostBaud: number | null; tankVentOff: boolean; kHold: boolean; route: RouteId }) =>
        'Writing to the DME.\n\n' +
        ROUTE_TEXT.en[a.route] +
        `What will be written: ${a.tuned
            ? 'the tuned map'
            : `⚠ the map is NOT changed (patches only) — ${a.patchOn ? 'PATCH ON' : 'PATCH OFF'}`}\n` +
        `Verification: ${a.verifyMode === 'full'
            ? "FULL — the DME's own checksum, plus all 65536 bytes read back and compared byte for byte."
            : "QUICK — the DME's own encoding checksum (DS2 0x0A), one exchange against the CRCs the ECU stores in its own flash."}\n` +
        (a.verifyMode === 'quick'
            ? '  Note: QUICK covers 65528 of the 65536 bytes, but cannot say WHERE a mismatch is.\n'
            : '') +
        (a.boostBaud
            ? `\n⚠ BOOST ${a.boostBaud} is armed (experimental).\n`
            + '  The baud is raised immediately after the erase — the DME accepts this rate only from\n'
            + '  inside a programming session, and the erase is what creates one.\n'
            + '  A refused switch simply writes at 9600. If it is accepted and the DME then goes silent,\n'
            + '  the link drops back to 9600 before a single write telegram is sent.\n'
            + '  ⚠ If the ECU answers at neither rate, the write stops with the data area erased.\n'
            + '    Recovery: ignition OFF, wait 10 s, back ON, reconnect, and run WRITE again.\n'
            + '    WRITE always restarts from the erase, so re-running it is safe.\n'
            : '') +
        (a.tankVentOff
            ? `\n⚠ TANK VENT: SHUT — writing with tank ventilation disabled.\n`
            + '  It also stops the purge learning the logs cannot see.\n'
            + '  This is for reproducibility during a tuning run. It is not a BIN to keep driving.\n'
            + '  The charcoal canister stops being purged; once saturated it can cause a fuel smell,\n'
            + '  and DTC 24 (tank-venting valve) is the code for a valve that will not open.\n'
            + '  When the logging is done, set TANK VENT back to OEM and write once more.\n'
            + '  The filename carries _TEVOFF, and the session records it.\n'
            : '') +
        // Only for a BIN carrying K HOLD: said before the erase, because it is not a BIN to keep.
        (a.kHold
            ? `\n⚠ K HOLD: 1.000 — cold-exhaust enrichment is off, and part-load ignition at 2400–3000 rpm advances by up to 2.3°.\n`
            + '  This BIN is for measuring; FINALIZE puts the stock values back.\n'
            : '') +
        (a.drift.length ? `\n⚠ Writing with different options than were saved:\n  ${a.drift.join('\n  ')}\n` : '') +
        '\n⚠ Confirm the engine is stopped (key OFF → ignition back ON).\n' +
        '  The DME refuses the write while the engine is running.\n' +
        `⚠ Keep the power (battery) stable. The write takes about ${a.verifyMode === 'full' ? 'four and a half' : 'two and a half'} minutes.\n` +
        '  Never cut the power or unplug the cable while it is writing.\n' +
        '  Do not close or reload this browser tab.\n' +
        '  (Trying to close it asks for confirmation, but confirming still leaves.)\n' +
        (a.android
            ? '⚠ On this device (Android), also note:\n' +
            '  Do not let the screen switch off (auto-off is held back while writing, but a manual\n' +
            '  press cannot be prevented).\n' +
            '  Do not switch to another app.\n' +
            '  Secure the OTG cable and connector so they cannot move.\n'
            : '') +
        "\nThe checksum is corrected automatically. Every telegram's verify byte is checked in both modes.\n\n" +
        'Continue?',

    noTransport: (a: { android: boolean }) => a.android
        ? 'Cannot reach a DME — a USB OTG adapter and a WebUSB-capable browser (Chrome) are required. PRACTICE works offline.'
        : 'Cannot reach a DME — Chrome or Edge is required (Web Serial API). PRACTICE works offline.',

    titleAssistantOn: 'Turn ASSISTANT on',
    assistantOn: () =>
        'The AI assistant you connected will be able to ask this tab questions.\n\n'
        + 'What is sent: only when the assistant asks, this tab\'s state (the device\'s name — yours, or a default such as the head unit\'s — link, whether a log is running, mode, the open session),the list of sessions saved on this device (number, name, date, whether each has a BIN and a log), parts of the data log it has recorded (rpm, load, ignition angles, knock and the rest; in observation mode, the bytes of the addresses watched and the marks), the calibration items of the open session it asks about (name, description, address, units, values), and the list of sessions sent to your cloud (name, dates, whether each has a tune and a log). Never the VIN or a file name.\n'
        + 'How: through TSUNAGI\'s relay (Cloudflare), which stores nothing. When it connects, the tab tells the relay a random number that tells devices apart and whether it was opened from the head unit (kept in memory only).\n'
        + 'Where it ends up: the service you connected the assistant to (claude.ai and others), under that service\'s own terms.\n\n'
        + 'What it can do: start and stop a log, bring a view to the front, open, start and copy (NEXT) sessions, drop unsaved changes, set an observation (OBSERVE) plan and put marks on the log, change calibration values (placed on CALIBRATION as changes), SAVE, and send to your cloud (SYNC) and bring a session back from it (never while a log records; what is sent or brought back goes directly between this tab and the cloud), reconnect the cable chosen on this device before and release it, and switch to MONITORING.\n'
        + 'What it cannot do: write to or flash the car, or choose a new cable. It does these only when you ask or confirm out loud; anything that loses something (dropping unsaved work, sending over another device\'s newer copy, replacing a copy here, stopping the log) it always reads back first.\n\n'
        + 'You can turn it off here at any time.',
    btnAssistantOn: 'Turn on',

    linkLost: () => 'Link lost — reconnecting on the same cable. The log has not stopped.',
    linkRetrying: (attempt, elapsedS) =>
        `Link down ${Math.round(elapsedS)} s — reconnect attempt ${attempt} got no answer, still trying. `
        + 'Check the cable and connector. The log has not stopped.',
    linkResumed: gapS =>
        `The link was down ${gapS.toFixed(1)} s and is back. The gap is recorded in the log, and the samples just after it are left out of the map.`,

    readChecksumBad: (a: { slave: boolean; master: boolean }): string => {
        const which = !a.slave && !a.master ? 'SLAVE and MASTER' : !a.slave ? 'SLAVE' : 'MASTER';
        return `⚠ The BIN just read fails its checksum (${which}) — the transfer may be corrupt. ` +
            'Run READ again before tuning from it.';
    },

    writeVerifiedBy: (v: { mode: 'quick' | 'full'; readBack: boolean }): string =>
        v.readBack
            ? "every byte read back and compared, plus the DME's own checksum"
            : v.mode === 'quick'
                ? "the DME's own checksum — no read-back was performed"
                : 'verified, but the checks that ran could not be identified',

    patchWriteDone: (v: { mode: 'quick' | 'full'; readBack: boolean }) =>
        `✅ The patch write is complete (${EN.writeVerifiedBy(v)}).\n\n` +
        KEY_CYCLE_EN + '\n\n' +
        'Reconnect with CONNECTION afterwards, then START TUNE begins the data log.',

    writeDone: (v: { mode: 'quick' | 'full'; readBack: boolean }) =>
        `✅ The write is complete (${EN.writeVerifiedBy(v)}).\n\n` + KEY_CYCLE_EN,

    nextConfirm:
        'Start the next session from the BIN just written? (NEXT)\n\n' +
        'OK     = create a new session (BASE = the BIN just written; switches and filter settings carry over)\n' +
        'Cancel = return to the session list',

    writeFailed: (reason: string | null, a?: { wasBackgrounded: boolean }) =>
        '❌ The write failed.\n\n' +
        `Reason: ${reason ?? 'unknown error'}\n\n` +
        (a?.wasBackgrounded
            ? '⚠ This app left the screen while it was writing (the screen switched off, or you\n' +
            '  switched apps). That is the most likely cause. Next time, keep the screen on and\n' +
            '  stay in this app for the whole write.\n\n'
            : '') +
        "⚠ The DME's data area has already been erased and the write may be incomplete.\n" +
        '  Do not switch the ignition off and do not drive in this state.\n\n' +
        'What to do:\n' +
        '1. Make the power (battery) and cable connection stable\n' +
        '2. If the link dropped, reconnect with CONNECTION\n' +
        '3. Repeat WRITE until it succeeds\n\n' +
        'Note: WRITE always starts over from the erase, so re-running it is safe.',

    backupMismatch: (a: { connectedVin: string | null; connectedMock: boolean; backupVin: string | null; backupMock: boolean }) =>
        '❌ This backup cannot be written back.\n\n' +
        `Connected DME: ${a.connectedVin ?? 'unknown'}${a.connectedMock ? ' (PRACTICE)' : ''}\n` +
        `Backup:        ${a.backupVin ?? 'unknown'}${a.backupMock ? ' (PRACTICE)' : ''}\n\n` +
        'It came from a different vehicle, or from PRACTICE. Writing it back would corrupt the identity records.',

    flashDialogClosed:
        'The flash counter reset has finished.\n\n' +
        'Continue like this:\n' +
        '1. Switch the ignition key OFF\n' +
        '2. Wait 10 seconds\n' +
        '3. Turn the key back ON\n' +
        '4. Reconnect with CONNECTION\n\n' +
        'The DME reinitializes with the rewritten service block.\n' +
        'Note: do not read or write in this session until it has reinitialized.\n' +
        'Note: the connection was released here.',

    // --- titles and buttons ---
    lineageBlocked: (summary: string, verdict: 'diverged' | 'unknown' | 'match') =>
        `${summary}\n\n` +
        (verdict === 'diverged'
            ? 'A write erases and rewrites all 65536 bytes.\n' +
            'Whatever is in the car now would be lost — INCLUDING changes at addresses this tune\n' +
            'does not touch at all.\n' +
            'Example: branch a VE session and an inertia session off the same BASE, and even though\n' +
            '  they edit completely separate regions, the second one flashed undoes the first.\n\n' +
            'The correct step: re-READ the ECU and build this tune on that read.\n\n'
            : 'Not being able to tell is not the same as it being fine.\n' +
            'Continue only if you have a reason to write over an unknown state — recovering a\n' +
            'half-flashed ECU, for instance.\n\n') +
        'Write anyway?',
    titleLineage: 'Lineage check',
    btnFlashAnyway: 'Write anyway',

    rfKorrNoAnchorHint: 'No anchor yet. Stop accelerating through the load — hold the pedal still and keep RF '
        + 'steady (uphill, 3rd or 4th). Three seconds to settle, ten or more for the exhaust to catch up. '
        + 'Repeat in the same rpm band.',
    titleLogFinished: 'Data log finished',
    titleWriteConfirm: 'Write to the DME',
    titleWriteFailed: 'The write failed',
    titleRecoverRun: 'Unsaved data log',
    btnOk: 'OK',
    btnCancel: 'Cancel',
    btnClose: 'Close',
    btnWrite: 'Write',
    btnRestore: 'Restore',
    btnDiscard: 'Discard',
};

/** Both languages, for the verify scripts that read the copy back; the app calls dialogText(). */
export const DIALOG_TEXT: Record<DialogLang, NativeDialogText> = { ja: JA, en: EN };

/** The native-dialog copy in the display language. Call it at the point of use — it is cheap, and
 *  reading `navigator` lazily keeps this module safe to import from anywhere. */
export function dialogText(): NativeDialogText {
    return DIALOG_TEXT[detectDialogLang()];
}
