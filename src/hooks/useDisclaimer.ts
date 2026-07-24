import { useCallback, useEffect, useState } from 'react';

// 免責同意の記録先。localStorage はこのアプリで唯一の同期・軽量な永続化で、セッション用の
// IndexedDB(useSessionDb)より免責フラグ 1 個の保存に適する。キーは他アプリと衝突しない接頭辞つき。
const STORAGE_KEY = 'e46m3csl:disclaimer-ack';
// 保存値はこのバージョン文字列。文面を実質的に更新したら上げると、既に同意済みの全員へ
// 自動的に再提示できる(保存値 !== 現行版 なら未同意として扱うため)。
const DISCLAIMER_VERSION = '1';

/**
 * アクセス時の免責ダイアログの表示可否と、その「今後表示しない」永続化を司るフック。
 *
 * 静的エクスポート(output: 'export')でサーバープリレンダーされるため、localStorage は
 * レンダー中ではなくマウント後の useEffect でのみ読む。初期値を false にしておくことで、
 * 同意済みユーザーにダイアログが一瞬ちらつくのを防ぐ(ハイドレーション不一致も回避)。
 */
export function useDisclaimer() {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        try {
            if (localStorage.getItem(STORAGE_KEY) !== DISCLAIMER_VERSION) setOpen(true);
        } catch {
            // プライベートモード等でストレージが使えなくても、免責は必ず提示する。
            setOpen(true);
        }
    }, []);

    // ダイアログを閉じる唯一の経路。dontShowAgain が真のときだけ現行版を保存し、以後は非表示に
    // なる。チェックせず同意した場合は保存しないため、次回アクセスで再び表示される。
    const accept = useCallback((dontShowAgain: boolean) => {
        if (dontShowAgain) {
            try {
                localStorage.setItem(STORAGE_KEY, DISCLAIMER_VERSION);
            } catch {
                // 保存に失敗しても同意操作自体は成立させる(次回また出るだけ)。
            }
        }
        setOpen(false);
    }, []);

    return { open, accept };
}
