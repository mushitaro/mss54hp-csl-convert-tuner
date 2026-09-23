import React, { useCallback, useEffect, useState } from 'react';
import { Gauge, Loader2, AlertTriangle, LifeBuoy } from 'lucide-react';
import { FlashCounterInfo, FlashCounterRegion, ServiceBlockLayout, LOW_SLOT_WARNING_THRESHOLD, FLASH_COUNTER_RESET_ENABLED } from '@/lib/dme-link/flashCounter';
import { TransferPhase, DmeErrorKind } from '@/lib/dme-link/types';
import { FlashCounterOutcome } from '@/hooks/useDmeLink';
import { ServiceBlockReport, formatServiceBlockReport } from '@/lib/dme-link/serviceBlockReport';
import { ServiceBackupSummary } from '@/lib/db/serviceBackupRepository';
import { useDialogLang } from '@/hooks/useDialogLang';
import { DialogFrame, PhaseStack, PhaseLayer, DialogActions } from './DialogFrame';

interface Props {
    /** dmeLink.readFlashCounter — resolves null on failure (the reason lands in `error`). */
    onRead: () => Promise<FlashCounterInfo | null>;
    /** dmeLink.readEngineRpm — null means "could not ask", which is NOT the same as zero. */
    onReadRpm: () => Promise<number | null>;
    /** dmeLink.resetFlashCounter. `onBackup` must persist the 16 KB image or throw. The outcome
     *  reports whether the block was found already erased, because that decides between offering a
     *  retry and offering the restore — and the two are not interchangeable here. */
    onReset: (onBackup: (pair: ArrayBuffer) => Promise<void>, boost: boolean) => Promise<FlashCounterOutcome>;
    /** Whether this connection can change baud on the open handle. False renders the BOOST row
     *  disabled with the reason on it rather than hiding it — "why is this still two minutes" is
     *  the question the row exists to answer, and a control that is not there cannot answer it. */
    boostAvailable: boolean;
    /** Saves the pre-erase service block. Rejecting here stops the reset before anything is erased. */
    onBackup: (pair: ArrayBuffer) => Promise<void>;
    /** Reads both service blocks. Read-only. Null on failure. */
    onInspect: () => Promise<ServiceBlockReport | null>;
    /** Offers the inspected 16 KB as a file — an explicit, separately-chosen export. */
    onSaveInspection: () => void;
    /** Saved pre-erase backups, newest first — what the recovery phase can restore from. */
    onListBackups: () => Promise<ServiceBackupSummary[]>;
    /** Writes one saved backup back to the DME. Null on failure. */
    onRestore: (at: number) => Promise<FlashCounterInfo | null>;
    onClose: () => void;
    /** Fired once, only after the reset and its verifying read-back have both succeeded. */
    onResetComplete: (before: FlashCounterInfo, after: FlashCounterInfo) => void;
    transferProgress: number | null;
    transferPhase: TransferPhase | null;
    error: string | null;
    /** What kind of failure `error` is, when the link could classify it. 'electrical' swaps the retry
     *  advice for the physical checklist; 'serviceBlockErased' routes to the recovery phase, where
     *  retrying is the one thing that must not be offered. */
    errorKind: DmeErrorKind | null;
}

/**
 * 'resetting' deliberately spans the read, the backup, the erase, the rewrite and the verifying
 * read-back as one step. Once the erase has gone out the service block — AIF, ZIF and the VIN
 * records included — is gone until the rewrite lands, so there is no point at which stopping is
 * better than continuing. That phase therefore renders no cancel affordance at all.
 *
 * 'blocked' is separate from 'failed': nothing has been attempted and nothing is wrong with the
 * link, the DME is simply in a state where this must not run. Merging the two would offer Retry
 * for a condition only the user can clear.
 */
type Phase = 'reading' | 'viewing' | 'blocked' | 'confirming' | 'resetting' | 'result' | 'failed'
    // Reached only when the DME's block is found already erased, i.e. an earlier reset was
    // interrupted. Split from 'failed' because the correct action is the opposite one: 'failed'
    // offers Retry, and retrying here is exactly what makes the loss permanent.
    | 'recover' | 'restoring' | 'restored'
    // Read-only inspection of both service blocks. Reachable from every non-busy phase, because the
    // question it answers ("what is actually in there?") is the one that has to come before deciding
    // anything else — including whether the reset's premise holds at all.
    | 'inspecting' | 'inspected';

// 表示言語ごとの文言。表示言語は useDialogLang で全ダイアログ共有。
const TEXT = {
    ja: {
        title: 'RESET FLASH — フラッシュカウンター',
        close: '閉じる',
        loading: 'フラッシュカウンターを読み込み中…',
        checkingRpm: 'エンジン回転数を確認中…',
        colUsed: '使用',
        colRemaining: '残り',
        colState: '状態',
        used: (u: number, limit: number) => `${u}/${limit}`,
        stateLabel: {
            available: '空き',
            dataProgrammingActive: 'データ書込中',
            programProgrammingActive: 'プログラム書込中',
            fullOrUnknown: '満杯 / 不明',
        } as Record<string, string>,
        note: (<>リセット後は <span className="text-slate-300 font-bold">1/30</span> になります（0/30 ではありません）。先頭スロットは「消費済み」の目印として残る仕様です。</>),
        confirmQuestion: 'フラッシュカウンターをリセットしますか？',
        reset: 'リセット',
        cancel: 'やめる',
        runReset: 'リセット実行',
        blockedNotAvailable: (name: string, marker: string) => (<>
            DMEが<span className="text-slate-100 font-bold">前回の書き込みを終えていない状態</span>です。
            <br />イグニッションを OFF → ON して接続し直してから、もう一度お試しください。
            <br /><span className="text-slate-600">（{name} / マーカー {marker}）</span>
        </>),
        blockedEngineRunning: (rpm: number) => (<>
            <span className="text-slate-100 font-bold">エンジンが回転しています</span>（{Math.round(rpm)} rpm）。
            <br />リセットはエンジン停止中にのみ実行できます。エンジンを止め、イグニッションをONにしてから、もう一度お試しください。
        </>),
        blockedRpmUnknown: (<>
            <span className="text-slate-100 font-bold">エンジンが止まっていることを確認できませんでした。</span>
            回転数を読み取れなかっただけで、かかっている／止まっているのどちらを意味するものでもありません。
            <br />シフトを N に入れ、エンジンを止めた状態でイグニッションを ON にし、再試行してください。
            シフトが 1 速に入ったままでもこの表示になることが分かっています（原因は未特定）。
        </>),
        blockedDisabled: (<>
            <span className="text-slate-100 font-bold">リセットは現在無効化されています。</span>カウンターの表示のみ利用できます。
            <br />実車で Slave 側の読み出しが全 0xFF になる事象を確認したため、読み出しアドレスが未確定です。
            消去は両プロセッサを一度に消すため、この状態で実行すると Slave 側の車両情報を破壊する恐れがあります。
        </>),
        // 内部用語（サービス情報ブロック / ブートフィールド / ZIF …）はここには出さない。
        // ユーザーが判断できるのは「何が失われうるか」と「何をすればいいか」だけ。
        warn: (<>
            リセット中にDMEの電源が切れると、<span className="text-slate-100 font-bold">車両情報（VIN・書き込み履歴）</span>が失われます。
        </>),
        warnPower: '電源(バッテリー)を安定させ、ケーブルを抜かないでください。ブラウザのタブを閉じたりリロードしたりもしないでください。所要 約1.5〜2分です。',
        warnInterrupted: (<>
            中断した場合は<span className="text-slate-100 font-bold">リセットを再実行しないでください。</span>再実行すると復旧できなくなります。
        </>),
        // 「起きてから調べる」ができない情報なので、起きる前に見せておく。
        warnRecovery: (<>
            中断してしまったときの対応:
            <br />① イグニッションキーを OFF にしない　② ケーブルを抜かない　③ このブラウザを閉じない
            <br />③ の状態のまま <span className="text-slate-100 font-bold">ヘッダーの FLASH をもう一度クリック</span>してください。
            中断を検知して<span className="text-slate-100 font-bold">「復旧を実行」</span>を表示します（消去前のデータはブラウザ内に保存されています）。
        </>),
        warnKeyCycle: '完了後は接続を切断します。キーOFF → 10秒待つ → キーON → CONNECTION で接続し直してください。',
        boost: 'BOOST — 書き込みを 125000 baud で行う',
        boostHint: '16 KB の書き込みが約4倍速くなります（読み出しは 9600 のまま）。レート切り替えは消去が開くプログラミングセッションの中でだけ DME が受け付けます。拒否されたら 9600 で書くだけ、受理された後に無応答になったら書き込み電文を1本も送る前に 9600 へ戻ります。',
        boostUnavailable: 'この接続では使えません。レート切り替えはポートを開いたまま行える必要があり、それができるのは Android の USB 接続だけです。9600 で実行します。',
        resetting: 'リセット中… 中断できません。',
        phase: {
            reading: '現在のデータを読み出し中',
            erasing: '消去中',
            writing: '書き込み中',
            verifying: '書き込んだ内容を確認中',
        } as Record<TransferPhase, string>,
        done: '✅ リセット完了。書き込んだ内容を読み戻して確認済みです。',
        doneKeyCycle: 'キーOFF → 10秒待つ → キーON。その後 CONNECTION で接続し直してください。',
        failLead: 'フラッシュカウンターの読み出し/リセットに失敗しました。',
        failHint: '接続を確認して再試行してください。',
        failHintElectrical: (<>
            通信線（K-line）が<span className="text-slate-100 font-bold">送信中に電気的に乱されて</span>います。再試行では直りません。
            <br />1. まずエンジン停止（IG ON）と始動中で発生頻度を比べる — 始動中だけなら点火系ノイズ
            <br />2. OBDプラグを挿し直し、接続したまま軽く動かして再現するか確認
            <br />3. USBポートを変える（ハブを介さない）
            <br />4. OBDポートのグラウンドと KL15 電源を確認
        </>),
        failRecovery: '⚠ 途中まで進んでいた場合はリセットを再実行しないでください。再実行すると復旧できなくなります。イグニッションキーをOFFにせず、ケーブルを抜かず、このブラウザを閉じないでください — 消去前のデータがブラウザ内に保存されており、これが唯一の復旧元です。',
        retry: '再試行',
        recoverTitle: '前回のリセットが中断されています',
        recoverLead: 'DMEの車両情報が消去されたまま書き戻されていません。リセットは実行できません（実行すると復旧できなくなります）。',
        recoverAction: '下のバックアップをDMEに書き戻して復旧します。所要 約1〜1.5分。完了するまで電源とケーブルをそのままにしてください。',
        recoverNone: '復旧に使えるバックアップがこのブラウザに見つかりません。イグニッションを切らず、ケーブルも抜かず、この画面のまま対応を検討してください。',
        recoverPick: '書き戻すバックアップ:',
        restore: '復旧を実行',
        restoring: '書き戻し中… 中断できません。',
        restored: '✅ 復旧完了。車両情報を書き戻し、読み戻して確認しました。',
        restoredNext: 'このあとフラッシュカウンターのリセットをやり直せます。',
        inspect: 'サービス情報を読み出す',
        inspectHint: '読み出しのみ。消去も書き込みも行いません（約25秒）。',
        inspecting: 'サービス情報ブロックを読み出し中…',
        inspectTitle: 'サービス情報ブロックの内容',
        inspectPointers: 'DMEが申告しているアドレス',
        inspectAifIn: { master: 'マスター側にあります', slave: 'スレーブ側にあります', outside: '読み出した2ブロックの外にあります', unavailable: '取得できませんでした' } as Record<string, string>,
        inspectAllErased: '全て 0xFF（消去状態）',
        inspectHasData: 'データあり',
        inspectAifSlots: (n: number, total: number) => `AIFスロット: ${total}個中 ${n}個に記録あり`,
        inspectAifUnparsed: 'AIFは読み出した範囲の外にあるため解析できません。',
        inspectSave: '16KBを保存',
        inspectCopy: 'テキストをコピー',
        copied: 'コピーしました',
    },
    en: {
        title: 'RESET FLASH — Flash Counter',
        close: 'Close',
        loading: 'Reading the flash counter…',
        checkingRpm: 'Checking engine speed…',
        colUsed: 'Used',
        colRemaining: 'Left',
        colState: 'State',
        used: (u: number, limit: number) => `${u}/${limit}`,
        stateLabel: {
            available: 'Available',
            dataProgrammingActive: 'Data programming',
            programProgrammingActive: 'Program programming',
            fullOrUnknown: 'Full / unknown',
        } as Record<string, string>,
        note: (<>After the reset this reads <span className="text-slate-300 font-bold">1/30</span>, not 0/30 — the first slot stays marked as consumed by design.</>),
        confirmQuestion: 'Reset the flash counter?',
        reset: 'Reset',
        cancel: 'Cancel',
        runReset: 'Run Reset',
        blockedNotAvailable: (name: string, marker: string) => (<>
            The DME <span className="text-slate-100 font-bold">has not finished a previous write</span>.
            <br />Cycle the ignition off and on, reconnect, then try again.
            <br /><span className="text-slate-600">({name} / marker {marker})</span>
        </>),
        blockedEngineRunning: (rpm: number) => (<>
            The <span className="text-slate-100 font-bold">engine is running</span> ({Math.round(rpm)} rpm).
            <br />The reset can only run with the engine stopped. Stop it, switch the ignition back on, then try again.
        </>),
        blockedRpmUnknown: (<>
            <span className="text-slate-100 font-bold">Could not confirm the engine is stopped.</span>
            {' '}The engine speed could not be READ, which means neither that it is running nor that it is not.
            <br />Put the gearbox in neutral, stop the engine, switch the ignition on and retry. This has also been
            seen with the shifter left in first (cause not yet known).
        </>),
        blockedDisabled: (<>
            <span className="text-slate-100 font-bold">The reset is currently disabled;</span> the counter reading still works.
            <br />On a real vehicle the slave side read back as all-0xFF, so the read address is unconfirmed. The erase clears
            both processors at once, so running it in this state could destroy the slave&apos;s vehicle information.
        </>),
        // No internal vocabulary here (service block / boot field / ZIF). All a user can act on is
        // what could be lost and what to do about it.
        warn: (<>
            If the DME loses power during the reset, the <span className="text-slate-100 font-bold">vehicle information (VIN and programming history)</span> is lost.
        </>),
        warnPower: 'Keep the battery stable, do not unplug the cable, and do not close or reload this browser tab. Takes about 1.5–2 minutes.',
        warnInterrupted: (<>
            If it is interrupted, <span className="text-slate-100 font-bold">do not run the reset again.</span> Doing so makes it unrecoverable.
        </>),
        // You cannot look this up once it has happened, so it goes on screen before it can.
        warnRecovery: (<>
            If it does get interrupted:
            <br />(1) do not switch the ignition off　(2) do not unplug the cable　(3) do not close this browser
            <br />Then <span className="text-slate-100 font-bold">click FLASH in the header again</span>. The interruption is
            detected and a <span className="text-slate-100 font-bold">Recover</span> action appears (the pre-erase data is saved in the browser).
        </>),
        warnKeyCycle: 'The connection is dropped afterwards. Key OFF → wait 10 s → key ON → reconnect with CONNECTION.',
        boost: 'BOOST — write at 125000 baud',
        boostHint: 'About four times faster over the 16 KB write; the reads stay at 9600. The DME accepts the rate switch only inside the programming session the erase opens. A refused switch just writes at 9600, and one that is accepted and then goes silent drops back to 9600 before a single write telegram is sent.',
        boostUnavailable: 'Not available on this connection. The rate has to change on the open port, and only the Android USB link can do that. This will run at 9600.',
        resetting: 'Resetting… this cannot be interrupted.',
        phase: {
            reading: 'Reading the current data',
            erasing: 'Erasing',
            writing: 'Writing',
            verifying: 'Checking what was written',
        } as Record<TransferPhase, string>,
        done: '✅ Reset complete. What was written has been read back and checked.',
        doneKeyCycle: 'Key OFF → wait 10 s → key ON, then reconnect with CONNECTION.',
        failLead: 'Failed to read / reset the flash counter.',
        failHint: 'Check the connection and retry.',
        failHintElectrical: (<>
            The K-line was <span className="text-slate-100 font-bold">electrically disturbed during transmission</span>. Retrying will not fix this.
            <br />1. Compare failure rates engine-off (ignition on) vs engine-running — running only means ignition EMI
            <br />2. Reseat the OBD plug; wiggle-test it while connected
            <br />3. Try a different USB port, with no hub
            <br />4. Check the OBD port&apos;s ground and KL15 supply
        </>),
        failRecovery: '⚠ If it had already started, do not run the reset again — that makes it unrecoverable. Do not switch the ignition off, do not unplug the cable, and do not close this browser: the pre-erase data saved there is the only thing to recover from.',
        retry: 'Retry',
        recoverTitle: 'A previous reset was interrupted',
        recoverLead: 'The DME\'s vehicle information is still erased and was never written back. The reset cannot run (doing so would make this unrecoverable).',
        recoverAction: 'Write the backup below back to the DME to recover. Takes about 1–1.5 minutes. Leave power and the cable alone until it finishes.',
        recoverNone: 'No usable backup was found in this browser. Do not switch the ignition off or unplug the cable, and leave this screen open while you decide what to do.',
        recoverPick: 'Backup to write back:',
        restore: 'Recover',
        restoring: 'Writing back… this cannot be interrupted.',
        restored: '✅ Recovered. The vehicle information was written back and read back to confirm.',
        restoredNext: 'You can retry the flash counter reset after this.',
        inspect: 'Read service info',
        inspectHint: 'Read-only. Nothing is erased or written (~25 s).',
        inspecting: 'Reading the service blocks…',
        inspectTitle: 'Service block contents',
        inspectPointers: 'Addresses the DME reports',
        inspectAifIn: { master: 'in the master block', slave: 'in the slave block', outside: 'outside both blocks that were read', unavailable: 'unavailable' } as Record<string, string>,
        inspectAllErased: 'all 0xFF (erased)',
        inspectHasData: 'has data',
        inspectAifSlots: (n: number, total: number) => `AIF slots: ${n} of ${total} populated`,
        inspectAifUnparsed: 'AIF could not be parsed — it lies outside the range that was read.',
        inspectSave: 'Save 16 KB',
        inspectCopy: 'Copy as text',
        copied: 'Copied',
    },
};

function regionRows(info: FlashCounterInfo): FlashCounterRegion[] {
    return [info.master, info.slave];
}

function markerHex(marker: number): string {
    return `0x${marker.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * The two processors as ONE counter, which is all this screen has ever been able to act on.
 *
 * They are erased and rewritten together — there is no operation here that can move one and not the
 * other — so a reader comparing the two rows was comparing two numbers that no decision distinguishes
 * (operator, 2026-08-31). INSPECT still reports each block separately, which is where a question
 * about one of them belongs.
 *
 * Reduced CONSERVATIVELY rather than by taking master: `used` is the higher and `remaining` the
 * lower, so a pair that has somehow drifted reports the half with less headroom — the half that runs
 * out first is the one that decides when a reset is due. `state` reports any processor that is not
 * available, because either one being mid-programming is what blocks the reset. Both processors stay
 * on the title attribute, so the desk can still read them without opening anything.
 */
function mergedCounter(info: FlashCounterInfo) {
    const rows = regionRows(info);
    return {
        used: Math.max(...rows.map(r => r.used)),
        remaining: Math.min(...rows.map(r => r.remaining)),
        state: rows.find(r => r.state !== 'available')?.state ?? 'available',
        detail: rows
            .map(r => `${r.name}  ${r.used}/${ServiceBlockLayout.limitPerProcessor}  ·  0x${r.address.toString(16).padStart(6, '0')}  ·  marker ${markerHex(r.firstOpenMarker)}`)
            .join('\n'),
    };
}

/** Label left, value right, one line. The house readout, and the whole of this screen's data. */
const Line: React.FC<{ label: string; value: React.ReactNode; title?: string }> = ({ label, value, title }) => (
    <div className="flex items-baseline justify-between gap-4" title={title}>
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">{label}</span>
        <span className="text-[12px] font-mono tabular-nums">{value}</span>
    </div>
);

export const FlashCounterResetDialog: React.FC<Props> = ({
    onRead, onReadRpm, onReset, onBackup, onInspect, onSaveInspection, onListBackups, onRestore,
    onClose, onResetComplete, transferProgress, transferPhase, error, errorKind, boostAvailable,
}) => {
    const [phase, setPhase] = useState<Phase>('reading');
    /** Per reset, and it starts off. The speed is worth having and the switch is still an experiment
     *  on a path that erases before it writes, so it is chosen each time rather than remembered. */
    const [boost, setBoost] = useState(false);
    const [before, setBefore] = useState<FlashCounterInfo | null>(null);
    const [after, setAfter] = useState<FlashCounterInfo | null>(null);
    const [blockedReason, setBlockedReason] = useState<React.ReactNode>(null);
    const [checkingRpm, setCheckingRpm] = useState(false);
    const [backups, setBackups] = useState<ServiceBackupSummary[]>([]);
    const [report, setReport] = useState<ServiceBlockReport | null>(null);
    const [copied, setCopied] = useState(false);
    /** Where to return when the inspection is closed, so it can be opened from any resting phase. */
    const [returnPhase, setReturnPhase] = useState<Phase>('viewing');
    const lang = useDialogLang();
    const t = TEXT[lang];

    /**
     * Read the counter, then decide whether this may run at all.
     *
     * Both gates are evaluated here rather than at the button, so the reason is on screen next to
     * the numbers it refers to. The RPM probe runs second because it is the more expensive question
     * and pointless to ask if the boot fields already rule the operation out.
     */
    const load = useCallback(async () => {
        const info = await onRead();
        if (!info) { setPhase('failed'); return; }
        setBefore(info);

        const busyRegion = regionRows(info).find(r => r.state !== 'available');
        if (busyRegion) {
            setBlockedReason(t.blockedNotAvailable(busyRegion.name, markerHex(busyRegion.firstOpenMarker)));
            setPhase('blocked');
            return;
        }

        // Checked before the RPM probe, and before the reset button is ever offered: while the reset
        // is disabled there is nothing to make ready for.
        if (!FLASH_COUNTER_RESET_ENABLED) {
            setBlockedReason(t.blockedDisabled);
            setPhase('blocked');
            return;
        }

        setCheckingRpm(true);
        const rpm = await onReadRpm();
        setCheckingRpm(false);
        // null is "could not ask", and the safe reading of that is not zero. The DME would refuse
        // the erase with 0xA2 anyway, but by then the recycle-only and prepare commands have been
        // sent — better to stop while nothing has been touched.
        if (rpm === null) { setBlockedReason(t.blockedRpmUnknown); setPhase('blocked'); return; }
        if (rpm > 0) { setBlockedReason(t.blockedEngineRunning(rpm)); setPhase('blocked'); return; }

        setPhase('viewing');
        // t is derived from the shared dialog language, which does not change while mounted; listing
        // it would re-run the whole probe on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onRead, onReadRpm]);

    useEffect(() => { void load(); }, [load]);

    /** Retry always re-reads and re-checks, never re-resets. */
    const retry = () => {
        setBefore(null);
        setAfter(null);
        setBlockedReason(null);
        setPhase('reading');
        void load();
    };

    const handleReset = async () => {
        if (!before) return;
        setPhase('resetting');
        const outcome = await onReset(onBackup, boost && boostAvailable);
        if (!outcome.ok) {
            // Read from the outcome, never from the errorKind prop: this line runs before React has
            // re-rendered with that prop's new value. The block being already erased means an
            // earlier attempt was interrupted — nothing was touched this time, and the remedy is the
            // restore, not the Retry that 'failed' would put on screen.
            if (outcome.needsRecovery) { void enterRecovery(); return; }
            setPhase('failed');
            return;
        }
        setAfter(outcome.info);
        setPhase('result');
        onResetComplete(before, outcome.info);
    };

    const enterRecovery = useCallback(async () => {
        setPhase('recover');
        try {
            setBackups(await onListBackups());
        } catch {
            setBackups([]); // "none found" is the honest fallback; the phase says what to do either way
        }
    }, [onListBackups]);

    const handleRestore = async () => {
        const target = backups[0];
        if (!target) return;
        setPhase('restoring');
        const info = await onRestore(target.at);
        if (!info) { setPhase('failed'); return; }
        setAfter(info);
        setBefore(info); // the restore replaced the reference point; a stale "before" would misreport
        setPhase('restored');
    };

    const runInspect = async () => {
        setReturnPhase(phase);
        setPhase('inspecting');
        const r = await onInspect();
        if (!r) { setPhase('failed'); return; }
        setReport(r);
        setPhase('inspected');
    };

    const busy = phase === 'reading' || phase === 'resetting' || phase === 'restoring' || phase === 'inspecting';
    /** Offered from every resting phase — it is read-only, and it is what answers "what is in there?" */
    const canInspect = phase === 'viewing' || phase === 'blocked' || phase === 'failed' || phase === 'recover';
    const dismissable = !busy;
    const shown = after ?? before;

    return (
        <DialogFrame
            icon={<Gauge className="w-3 h-3" />}
            title={t.title}
            closeLabel={t.close}
            onClose={dismissable ? onClose : undefined}
        >
            <>
                {phase === 'inspecting' ? (
                    <div className="flex-1 flex flex-col justify-center space-y-2">
                        <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
                            <span className="flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" />{t.inspecting}</span>
                            {transferProgress !== null && <span className="tabular-nums font-bold">{transferProgress}%</span>}
                        </div>
                        <div className="h-0.5 bg-slate-800 rounded overflow-hidden">
                            <div className="h-full bg-blue-400 transition-[width] duration-200" style={{ width: `${transferProgress ?? 0}%` }} />
                        </div>
                    </div>
                ) : phase === 'inspected' && report ? (
                    <>
                        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-3 text-[11px] font-mono">
                            <div className="text-[10px] uppercase tracking-widest text-slate-600">{t.inspectPointers}</div>
                            <div className="space-y-0.5">
                                {([['AIF', report.pointers.aif], ['ZIF', report.pointers.zif], ['BRIF', report.pointers.brif], ['DIF', report.pointers.dif]] as const).map(([label, addr]) => (
                                    <div key={label} className="flex justify-between">
                                        <span className="text-slate-500">{label}</span>
                                        <span className="text-slate-300">{addr === null ? '—' : `0x${addr.toString(16).toUpperCase().padStart(6, '0')}`}</span>
                                    </div>
                                ))}
                                {/* The line that decides everything: if the AIF is on the master, a blank
                                    slave block says nothing about the identity records. */}
                                <div className="flex justify-between pt-1 border-t border-slate-800/60">
                                    <span className="text-slate-500">AIF の所在</span>
                                    <span className={report.aifLocation === 'unavailable' || report.aifLocation === 'outside' ? 'text-amber-400' : 'text-emerald-400'}>
                                        {t.inspectAifIn[report.aifLocation]}
                                    </span>
                                </div>
                            </div>

                            {[report.master, report.slave].map(region => (
                                <div key={region.name} className="pt-2 border-t border-slate-800/60 space-y-0.5">
                                    <div className="flex justify-between">
                                        <span className="text-slate-300 font-bold">{region.name}</span>
                                        <span className={region.allErased ? 'text-amber-400' : 'text-emerald-400'}>
                                            {region.allErased ? t.inspectAllErased : t.inspectHasData}
                                        </span>
                                    </div>
                                    <div className="flex justify-between text-slate-500">
                                        <span>0x{region.address.toString(16).toUpperCase().padStart(6, '0')} · {region.length} B</span>
                                        <span>0xFF {region.erasedPercent.toFixed(1)}% · 値の種類 {region.distinctBytes}</span>
                                    </div>
                                    <div className="flex justify-between text-slate-500">
                                        <span>counter</span>
                                        <span>{region.counter.used}/{ServiceBlockLayout.limitPerProcessor} · marker {markerHex(region.counter.firstOpenMarker)}</span>
                                    </div>
                                    <div className="text-slate-600 break-all">{region.counterHead}</div>
                                </div>
                            ))}

                            <div className="pt-2 border-t border-slate-800/60">
                                {report.aifSlots ? (
                                    <>
                                        <div className="text-slate-300 mb-1">{t.inspectAifSlots(report.aifPopulatedCount ?? 0, report.aifSlots.length)}</div>
                                        {report.aifSlots.map(s => (
                                            <div key={s.index} className="flex justify-between">
                                                <span className="text-slate-600">{String(s.index).padStart(2, '0')}</span>
                                                <span className={s.blank ? 'text-slate-700' : 'text-slate-300'}>
                                                    {s.blank ? '—' : `${s.vin}  ${s.softwareNumber}`}
                                                </span>
                                            </div>
                                        ))}
                                    </>
                                ) : (
                                    <div className="text-amber-400">{t.inspectAifUnparsed}</div>
                                )}
                            </div>
                        </div>

                        <div className="shrink-0 pt-3 mt-3 border-t border-slate-800 flex justify-between items-center">
                            <div className="flex gap-4">
                                <button onClick={onSaveInspection} className="text-[11px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 transition-colors">
                                    {t.inspectSave}
                                </button>
                                <button
                                    onClick={() => { void navigator.clipboard?.writeText(formatServiceBlockReport(report)).then(() => setCopied(true)); }}
                                    className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors"
                                >
                                    {copied ? t.copied : t.inspectCopy}
                                </button>
                            </div>
                            <button onClick={() => { setCopied(false); setPhase(returnPhase); }} className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                {t.close}
                            </button>
                        </div>
                    </>
                ) : phase === 'recover' || phase === 'restoring' || phase === 'restored' ? (
                    /* Takes over the whole dialog rather than appearing under the counter table:
                       with the block erased, that table is reporting a healthy 0/30 on data that
                       is not there, and showing it next to a recovery prompt would be actively
                       misleading about what state the ECU is in. */
                    <div className="flex-1 flex flex-col space-y-4">
                        <p className="flex items-start gap-2 text-[12px] font-mono text-amber-400 leading-relaxed">
                            <LifeBuoy className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            <span className="font-bold">{t.recoverTitle}</span>
                        </p>
                        <p className="text-[11px] font-mono text-slate-400 leading-relaxed">{t.recoverLead}</p>

                        {backups.length === 0 ? (
                            <p className="text-[11px] font-mono text-red-400 leading-relaxed">{t.recoverNone}</p>
                        ) : (
                            <>
                                <p className="text-[11px] font-mono text-slate-400 leading-relaxed">{t.recoverAction}</p>
                                <div className="text-[10px] font-mono text-slate-500 border-t border-slate-800 pt-2">
                                    <div className="text-slate-600 mb-1">{t.recoverPick}</div>
                                    <div className="flex items-center justify-between text-slate-300">
                                        <span>{new Date(backups[0].at).toLocaleString()}</span>
                                        <span className="text-slate-600">
                                            {backups[0].vin && backups[0].vin !== 'UNKNOWN' ? backups[0].vin : '—'} · {backups[0].size.toLocaleString()} B
                                        </span>
                                    </div>
                                </div>
                            </>
                        )}

                        {/* mt-auto, like every other view's action band: this branch replaces the whole
                            dialog, and its content is short, so without it the recovery buttons would
                            sit 200-odd px above where the buttons in every other phase are. */}
                        <PhaseStack className="mt-auto shrink-0 pt-3 border-t border-slate-800">
                            <PhaseLayer show={phase === 'recover'}>
                                <DialogActions>
                                    <button onClick={onClose} className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                        {t.close}
                                    </button>
                                    {/* No Retry anywhere in this phase — see the Phase comment. */}
                                    {backups.length > 0 && (
                                        <button onClick={() => void handleRestore()} className="text-[11px] font-bold uppercase tracking-widest text-amber-400 hover:text-amber-300 transition-colors">
                                            {t.restore}
                                        </button>
                                    )}
                                </DialogActions>
                            </PhaseLayer>

                            <PhaseLayer show={phase === 'restoring'}>
                                <div className="mt-auto pt-2 space-y-1.5">
                                    <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-amber-400">
                                        <span className="flex items-center gap-2">
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            {transferPhase ? t.phase[transferPhase] : t.restoring}
                                        </span>
                                        {transferProgress !== null && <span className="tabular-nums font-bold">{transferProgress}%</span>}
                                    </div>
                                    <div className="h-0.5 bg-slate-800 rounded overflow-hidden">
                                        <div className="h-full bg-amber-400 transition-[width] duration-200" style={{ width: `${transferProgress ?? 0}%` }} />
                                    </div>
                                    <p className="text-[10px] font-mono text-slate-600">{t.restoring}</p>
                                </div>
                            </PhaseLayer>

                            <PhaseLayer show={phase === 'restored'}>
                                <p className="text-[11px] font-mono text-emerald-400">{t.restored}</p>
                                <DialogActions lead={<span className="text-[10px] font-mono text-slate-500">{t.restoredNext}</span>}>
                                    <button onClick={onClose} className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                        {t.close}
                                    </button>
                                </DialogActions>
                            </PhaseLayer>
                        </PhaseStack>
                    </div>
                ) : phase === 'failed' ? (
                    /* Also a column, so Close/Retry land in the same band as every other phase's
                       buttons instead of directly under however long the error text ran. */
                    <div className="flex-1 flex flex-col space-y-4">
                        <p className="text-[11px] font-mono text-red-400 leading-relaxed">{error ?? t.failLead}</p>
                        <p className="text-[10px] font-mono text-slate-500 leading-relaxed">
                            {errorKind === 'electrical' ? t.failHintElectrical : t.failHint}
                        </p>
                        <p className="text-[10px] font-mono text-amber-400/90 leading-relaxed">{t.failRecovery}</p>
                        <DialogActions>
                            <button onClick={onClose} className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                {t.close}
                            </button>
                            <button onClick={retry} className={`text-[11px] font-bold uppercase tracking-widest transition-colors ${errorKind === 'electrical' ? 'text-slate-500 hover:text-slate-300' : 'text-blue-400 hover:text-blue-300'}`}>
                                {t.retry}
                            </button>
                        </DialogActions>
                    </div>
                ) : !shown ? (
                    <div className="flex-1 flex items-center gap-2 justify-center text-[11px] font-mono text-slate-500">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {t.loading}
                    </div>
                ) : (
                    <>
                        {/* `min-h-0`, or this does not shrink and the panel overflows its own bottom edge: a flex
                            item defaults to `min-height:auto`, which floors it at its content. With the
                            action region below it capped rather than free, that floor is what pushed the
                            question and its buttons 64px past the rounded border. */}
                        <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
                            {/* Three lines, one counter. This was a five-column table over two
                                processor rows; the columns carried a BEFORE and an AFTER that only
                                existed after a reset, so the header changed shape underneath the
                                numbers, and the two rows said the same thing twice. */}
                            {(() => {
                                const now = mergedCounter(shown);
                                const was = before ? mergedCounter(before) : now;
                                const limit = ServiceBlockLayout.limitPerProcessor;
                                return (
                                    <div className="space-y-2.5">
                                        <Line label={t.colUsed} title={now.detail} value={after
                                            ? (<>
                                                <span className="text-slate-600">{t.used(was.used, limit)}</span>
                                                <span className="text-slate-600 px-1.5">→</span>
                                                <span className="text-emerald-400">{t.used(now.used, limit)}</span>
                                            </>)
                                            : <span className="text-slate-300">{t.used(now.used, limit)}</span>} />
                                        <Line label={t.colRemaining} value={
                                            <span className={now.remaining < LOW_SLOT_WARNING_THRESHOLD ? 'text-amber-400' : 'text-slate-300'}>
                                                {now.remaining}
                                            </span>} />
                                        <Line label={t.colState} value={
                                            <span className={now.state === 'available' ? 'text-slate-300' : 'text-red-400'}>
                                                {t.stateLabel[now.state]}
                                            </span>} />
                                    </div>
                                );
                            })()}

                            {/* Separated by space, not by a rule. The panel already has one divider,
                                above the actions, and it is the only one that separates two KINDS of
                                thing rather than two paragraphs of the same one. */}
                            <p className="mt-5 text-[10px] font-mono text-slate-600 leading-relaxed">
                                {t.note}
                            </p>

                            {/* THE CONFIRMATION'S PROSE LIVES HERE, in the body, not in the action
                                band below. It is four paragraphs and a list; at 375px that wraps far
                                enough to have reserved almost the whole panel, which left the counter
                                71px of a 127px content and the note under the numbers reading as
                                missing.

                                The band exists so the divider cannot move between phases, and that
                                still holds — better, in fact: with only a checkbox and two buttons
                                left in it the tallest layer is about a hundred pixels rather than
                                three hundred, so the divider sits in one place and the reading matter
                                goes in the region that was already built to scroll. Body is what to
                                read, band is what to do.

                                ONE caution, then procedure. There used to be two amber blocks and two
                                rules in here, which spends the colour that means "stop and read" on
                                something the reader is meant to work through — so neither block was
                                the one that stood out. The consequence is amber and alone; everything
                                under it is what to do about it, in the grey the rest of the app states
                                procedure in, separated by space rather than by rules. */}
                            {phase === 'confirming' && (
                                <div className="mt-5 space-y-3">
                                    <p className="flex items-start gap-2 text-[11px] font-mono text-amber-400/90 leading-relaxed">
                                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                        <span>{t.warn}</span>
                                    </p>
                                    <ul className="text-[10px] font-mono text-slate-500 leading-relaxed space-y-1 pl-5">
                                        <li>{t.warnPower}</li>
                                        <li>{t.warnInterrupted}</li>
                                        <li>{t.warnKeyCycle}</li>
                                    </ul>
                                    {/* Set apart from the list above rather than a fourth bullet: the
                                        others are things to do now, this is the one to remember for a
                                        moment when the screen may be all you have left. */}
                                    <p className="text-[10px] font-mono text-slate-500 leading-relaxed">
                                        {t.warnRecovery}
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Stacked, not switched. This action area swings from a single-line question
                            to the confirmation's warning block — measured, 178 px of difference —
                            and switching between them dragged the counter table up and down with it
                            at exactly the moment the user is deciding whether to erase. */}
                        <PhaseStack className="shrink-0 pt-3 mt-3 border-t border-slate-800">
                            <PhaseLayer show={phase === 'viewing'}>
                                <DialogActions lead={
                                    <span className="text-[11px] font-mono text-slate-500">
                                        {checkingRpm ? t.checkingRpm : t.confirmQuestion}
                                    </span>
                                }>
                                    <button onClick={() => void runInspect()} title={t.inspectHint} className="text-[11px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 transition-colors">
                                        {t.inspect}
                                    </button>
                                    <button onClick={onClose} className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                        {t.close}
                                    </button>
                                    <button onClick={() => setPhase('confirming')} className="text-[11px] font-bold uppercase tracking-widest text-red-400 hover:text-red-300 transition-colors">
                                        {t.reset}
                                    </button>
                                </DialogActions>
                            </PhaseLayer>

                            <PhaseLayer show={phase === 'blocked'}>
                                <p className="flex items-start gap-2 text-[11px] font-mono text-amber-400/90 leading-relaxed">
                                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                    <span>{blockedReason}</span>
                                </p>
                                <DialogActions>
                                    {canInspect && (
                                        <button onClick={() => void runInspect()} title={t.inspectHint} className="text-[11px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 transition-colors">
                                            {t.inspect}
                                        </button>
                                    )}
                                    <button onClick={onClose} className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                        {t.close}
                                    </button>
                                    <button onClick={retry} className="text-[11px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 transition-colors">
                                        {t.retry}
                                    </button>
                                </DialogActions>
                            </PhaseLayer>

                            <PhaseLayer show={phase === 'confirming'}>
                                <div>
                                    {/* SPEED, under the warnings and above the buttons, because it is
                                        the last thing decided and the only thing on this screen that
                                        is a choice. It was a selector in the DME strip that reset to
                                        OFF on every connect, which is defensible for the data write
                                        and unfindable for this: the reset is reached from a dialog,
                                        and nobody opening it is looking at the strip behind it
                                        (operator, 2026-08-31).

                                        Its own flag, not the strip's. If this switch fails the block
                                        that is erased is the SERVICE block and its 16 KB are already
                                        saved — the recovery above is exactly that restore. The data
                                        write has no such copy, so a tick made here must not still be
                                        armed at the next flash. See DmeLink.resetFlashCounter. */}
                                    <label className={`flex items-start gap-2
                                        ${boostAvailable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                                        <input
                                            type="checkbox"
                                            checked={boost && boostAvailable}
                                            disabled={!boostAvailable}
                                            onChange={(e) => setBoost(e.target.checked)}
                                            className="mt-0.5 accent-blue-500 disabled:cursor-not-allowed"
                                        />
                                        <span className="min-w-0">
                                            <span className={`block text-[11px] font-mono font-bold ${boostAvailable && boost ? 'text-blue-400' : 'text-slate-400'}`}>
                                                {t.boost}
                                            </span>
                                            <span className="block text-[10px] font-mono text-slate-500 leading-relaxed">
                                                {boostAvailable ? t.boostHint : t.boostUnavailable}
                                            </span>
                                        </span>
                                    </label>
                                </div>
                                <DialogActions>
                                    <button onClick={() => setPhase('viewing')} className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                        {t.cancel}
                                    </button>
                                    <button onClick={() => void handleReset()} className="text-[11px] font-bold uppercase tracking-widest text-red-400 hover:text-red-300 transition-colors">
                                        {t.runReset}
                                    </button>
                                </DialogActions>
                            </PhaseLayer>

                            <PhaseLayer show={phase === 'resetting'}>
                                <div className="mt-auto pt-2 space-y-1.5">
                                    <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-amber-400">
                                        <span className="flex items-center gap-2">
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            {transferPhase ? t.phase[transferPhase] : t.resetting}
                                        </span>
                                        {transferProgress !== null && (
                                            <span className="tabular-nums font-bold">{transferProgress}%</span>
                                        )}
                                    </div>
                                    <div className="h-0.5 bg-slate-800 rounded overflow-hidden">
                                        <div className="h-full bg-amber-400 transition-[width] duration-200" style={{ width: `${transferProgress ?? 0}%` }} />
                                    </div>
                                    <p className="text-[10px] font-mono text-slate-600">{t.resetting}</p>
                                </div>
                            </PhaseLayer>

                            <PhaseLayer show={phase === 'result'}>
                                <p className="text-[11px] font-mono text-emerald-400">{t.done}</p>
                                <DialogActions lead={<span className="text-[10px] font-mono text-amber-400/90">{t.doneKeyCycle}</span>}>
                                    <button onClick={onClose} className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors">
                                        {t.close}
                                    </button>
                                </DialogActions>
                            </PhaseLayer>
                        </PhaseStack>
                    </>
                )}
            </>
        </DialogFrame>
    );
};
