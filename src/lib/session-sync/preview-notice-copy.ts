import type { DialogLang } from '@/lib/dialog-text';

/**
 * What this preview sends, and why — the words the first-run dialog shows before the first send.
 *
 * Moved here, verbatim, from tsunagi-m3's `/preview-notice` page (its `lib/preview-notice-copy.ts`:
 * the shared `NOTICE_COPY` and this app's `NOTICE_APPS['tuner-preview']`). Until 2026-09-24 every
 * owner-gated preview sent a first visit through that page on m3; the operator decided the
 * confirmation belongs in the app's own first-run dialog instead, and m3 dropped the page. This file
 * is now the only copy of this app's notice.
 *
 * One line is not m3's: `alsoSent`. The shared line said both also carry the browser type, and this
 * app sends none — neither table has a user-agent column, no handler reads the request's headers,
 * and nothing the client packs reads `navigator.userAgent` (it is read only to pick the transport,
 * which is sent as the connection type the records line already names). So it says the app version
 * alone (operator, 2026-09-24).
 *
 * And `lead` names the build by the name its users know it by: 「このワークス版は」 / "this WORKS
 * build", where m3's said プレビュー版 / preview. The operator renamed the owner builds for their
 * users on 2026-09-25 — display only: the variant is still `preview`, and so is everything the code
 * compares.
 *
 * It is a claim about what `client.ts` and `diagnostics.ts` send. Change what those send and this
 * changes with them, together with the per-app list in the privacy policy's preview section
 * (m3.tsunagi.app/privacy-policy#preview, both languages) — the policy is the other copy. And if
 * what it says changes in substance, bump the version in `PREVIEW_NOTICE_KEY` (preview-notice.ts),
 * so that every owner who confirmed the old words is shown the new ones. A new name for the build
 * is not a change of substance, which is why the rename above left it at v1.
 *
 * Plain strings rather than JSX, so the dialog and `verify:preview-notice` read the same record.
 */
export interface PreviewNoticeCopy {
    lead: string;
    sessionsTitle: string;
    /** What one saved session holds, for this app. */
    sessions: string;
    sessionsWhen: string;
    recordsTitle: string;
    /** What one error record holds, for this app. */
    records: string;
    recordsWhen: string;
    alsoSent: string;
    purposeTitle: string;
    purpose: string;
    whereTitle: string;
    where: string;
    deleteTitle: string;
    deleteBody: string;
    /** The text of the link to the policy's preview section. */
    policy: string;
}

export const PREVIEW_NOTICE: Record<DialogLang, PreviewNoticeCopy> = {
    ja: {
        lead: 'このワークス版は、保存した記録を別の端末でも開けるよう、また不具合を調べられるよう、次のものを運営者のサーバーへ送ります。',
        sessionsTitle: '保存したセッション',
        sessions: '走行とアイドルの記録、読み出した BASE と書き込んだ TUNED の BIN（64 KB）、VIN、ソフトウェア番号',
        sessionsWhen: 'SYNC を押して保存したときに送ります。',
        recordsTitle: 'エラーの記録',
        records: 'DME の読み出し・書き込み・ログ取得ごとの結果とエラーの文面、VIN、ソフトウェア番号、接続方式、通信の記録（所要時間・再試行・DME の応答）',
        recordsWhen: '操作のたびに自動で送ります。通信できないときは端末に残し、次に送ります。',
        alsoSent: 'どちらにも、アプリの版が付きます。',
        purposeTitle: '使いみち',
        purpose: 'ご本人が別の端末で記録を開くため、そして不具合を調べてツールを直すためだけに使います。',
        whereTitle: '保存先と、見られる人',
        where: 'Cloudflare のデータベース（アジア太平洋地域）に、アカウントごとに分けて保存します。見られるのは、ご本人と運営者だけです。',
        deleteTitle: '削除',
        deleteBody: '保存したセッションとエラーの記録は、アプリの中でいつでも削除できます。まとめて削除したいときは、Discord からご連絡ください。',
        policy: '詳しくはプライバシーポリシー',
    },
    en: {
        lead: 'So that what you save opens on your other devices, and so that faults can be investigated, this WORKS build sends the following to our server.',
        sessionsTitle: 'Sessions you save',
        sessions: 'drive and idle logs, the BASE and TUNED BINs (64 KB), the VIN and the software number',
        sessionsWhen: 'Sent when you press SYNC to save one.',
        recordsTitle: 'Error records',
        records: 'the outcome and any error text of each DME read, write and log, the VIN, the software number, the cable type, and the communication log (timings, retries and the DME\'s replies)',
        recordsWhen: 'Sent automatically after each operation. Without a connection they wait on the device and go next time.',
        alsoSent: 'Both carry the app version.',
        purposeTitle: 'What it is for',
        purpose: 'Only for opening your records on your other devices, and for finding and fixing faults in the tool.',
        whereTitle: 'Where it is kept, and who can see it',
        where: 'In a Cloudflare database (Asia-Pacific), kept separately per account. Only you and the operator can see it.',
        deleteTitle: 'Deleting it',
        deleteBody: 'You can delete saved sessions and error records in the app at any time. To have everything deleted at once, contact us on Discord.',
        policy: 'Privacy policy, in full',
    },
};
