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

const JA = {
    // --- workspace / session housekeeping ---
    clearLog: 'このデータログ(CSV)を破棄しますか？',
    discardLog: '今記録したデータログを破棄して、最初からやり直しますか？',
    deleteSession: (label: string) => `「${label}」を削除しますか？この操作は取り消せません。`,
    noStoredBinary: 'このセッションにはBINが保存されていません。',
    noStoredTune: 'このセッションにはまだTUNEDが保存されていません。',
    noStoredLog: 'このセッションにはデータログが保存されていません。',
    noTuneToFinalize: 'このセッションにはファイナライズできるTUNEDがありません。',
    noBinaryOfKind: (which: string) => `このセッションには ${which.toUpperCase()} のBINがありません。`,
    notReconstructed: '保存されたデータログからこのセッションを再構築できませんでした。書き込みは無効です。',
    setBaseFirst: '先にBASEを設定してください(BINを読み込むか、DMEから読み出してください)。',
    parseBinaryFailed: (message: string) => `BINの解析に失敗しました: ${message}`,
    noValidCsvData: 'CSVから有効なデータを読み取れませんでした。',

    saved:
        'セッションを保存しました。\n\n' +
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

    // --- data log ---
    logFinished: (failure: string | null) =>
        (failure
            ? '⚠ 通信が途切れたため、データログを中断しました。\n\n' +
            `理由: ${failure}\n\n` +
            '※ ここまでに記録したサンプルは保持しています。\n\n'
            : 'データログを終了しました。\n\n') +
        'DMEへ書き込む場合は、次の手順で進めてください:\n' +
        '1. エンジンを停止(キーを OFF)\n' +
        '2. 再度イグニッションを ON にする(エンジンはかけない)\n' +
        '3. CONNECTION で接続し直す → WRITE\n\n' +
        '※ エンジンが回っているとDMEが書き込みを拒否します。\n' +
        '※ エンジンを止めると通信が切れるため、接続はここで解除しました。\n\n' +
        '書き込まない場合は、このまま DOWNLOAD TUNED で書き出せます(WRITEが送るバイト列そのもの)。',

    // --- flashing the DME ---
    writeConfirm: (a: { tuned: boolean; patchOn: boolean; drift: string[]; android: boolean }) =>
        'DMEへ書き込みます。\n\n' +
        `書き込む内容: ${a.tuned
            ? 'チューニング済みマップ'
            : `⚠ マップは変更しません(パッチのみ) — ${a.patchOn ? 'PATCH ON' : 'PATCH OFF'}`}\n` +
        (a.drift.length ? `\n⚠ 保存時と異なるオプションで書き込みます:\n  ${a.drift.join('\n  ')}\n` : '') +
        '\n⚠ エンジンが停止していること(キーOFF → 再度イグニッションON)を確認してください。\n' +
        '  エンジンが回っているとDMEが書き込みを拒否します。\n' +
        '⚠ 電源(バッテリー)を安定させてください。書き込みには約4分かかります。\n' +
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
        '\nチェックサムは自動補正されます。書き込み後にリードバック検証を行います。\n\n' +
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

    patchWriteDone:
        '✅ パッチの書き込みが完了しました(リードバック検証OK)。\n\n' +
        KEY_CYCLE_JA + '\n\n' +
        'その後 CONNECTION で接続し直すと、START TUNE でデータログを開始できます。',

    writeDone: '✅ 書き込みが完了しました(リードバック検証OK)。\n\n' + KEY_CYCLE_JA,

    retuneConfirm:
        'このチューンの続きから、次のセッションを始めますか？\n\n' +
        'OK        = 新規セッションを作成(BASE = 今書き込んだTUNED)\n' +
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
};

type NativeDialogText = typeof JA;

const EN: NativeDialogText = {
    clearLog: 'Discard this data log (CSV)?',
    discardLog: 'Discard the log just recorded and start over?',
    deleteSession: (label: string) => `Delete "${label}"? This cannot be undone.`,
    noStoredBinary: 'This session has no stored binary.',
    noStoredTune: 'This session has no saved tune yet.',
    noStoredLog: 'This session has no stored log.',
    noTuneToFinalize: 'This session has no saved tune to finalize.',
    noBinaryOfKind: (which: string) => `This session has no ${which.toUpperCase()} binary.`,
    notReconstructed: 'This session could not be reconstructed from its stored log — flashing is disabled.',
    setBaseFirst: 'Set a BASE first (upload a BIN or read it from the DME).',
    parseBinaryFailed: (message: string) => `Error parsing binary: ${message}`,
    noValidCsvData: 'No valid data found in CSV.',

    saved:
        'Session saved.\n\n' +
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

    logFinished: (failure: string | null) =>
        (failure
            ? '⚠ The data log stopped because the link was lost.\n\n' +
            `Reason: ${failure}\n\n` +
            'Note: the samples recorded up to that point have been kept.\n\n'
            : 'Data log finished.\n\n') +
        'To write to the DME, continue like this:\n' +
        '1. Stop the engine (key OFF)\n' +
        '2. Switch the ignition back ON (do not start the engine)\n' +
        '3. Reconnect with CONNECTION → WRITE\n\n' +
        'Note: the DME refuses the write while the engine is running.\n' +
        'Note: stopping the engine drops the link, so the connection was released here.\n\n' +
        'If you are not writing, you can export it as it is with DOWNLOAD TUNED (the exact bytes WRITE sends).',

    writeConfirm: (a: { tuned: boolean; patchOn: boolean; drift: string[]; android: boolean }) =>
        'Writing to the DME.\n\n' +
        `What will be written: ${a.tuned
            ? 'the tuned map'
            : `⚠ the map is NOT changed (patches only) — ${a.patchOn ? 'PATCH ON' : 'PATCH OFF'}`}\n` +
        (a.drift.length ? `\n⚠ Writing with different options than were saved:\n  ${a.drift.join('\n  ')}\n` : '') +
        '\n⚠ Confirm the engine is stopped (key OFF → ignition back ON).\n' +
        '  The DME refuses the write while the engine is running.\n' +
        '⚠ Keep the power (battery) stable. The write takes about 4 minutes.\n' +
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
        '\nThe checksum is corrected automatically. The write is verified by reading it back.\n\n' +
        'Continue?',

    noTransport: (a: { android: boolean }) => a.android
        ? 'Cannot reach a DME — a USB OTG adapter and a WebUSB-capable browser (Chrome) are required. PRACTICE works offline.'
        : 'Cannot reach a DME — Chrome or Edge is required (Web Serial API). PRACTICE works offline.',

    patchWriteDone:
        '✅ The patch write is complete (read-back verified).\n\n' +
        KEY_CYCLE_EN + '\n\n' +
        'Reconnect with CONNECTION afterwards, then START TUNE begins the data log.',

    writeDone: '✅ The write is complete (read-back verified).\n\n' + KEY_CYCLE_EN,

    retuneConfirm:
        'Start the next session from this tune?\n\n' +
        'OK     = create a new session (BASE = the TUNED just written)\n' +
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
};

const TEXT: Record<DialogLang, NativeDialogText> = { ja: JA, en: EN };

/** The native-dialog copy in the display language. Call it at the point of use — it is cheap, and
 *  reading `navigator` lazily keeps this module safe to import from anywhere. */
export function dialogText(): NativeDialogText {
    return TEXT[detectDialogLang()];
}
