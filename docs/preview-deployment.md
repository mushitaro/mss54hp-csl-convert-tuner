# プレビュー環境と実機テスト

このブランチ（`feat/egt-correction-rf-korr`）を **本番に触れずに** 動かし、Android 実機で
テストし、車で取ったログを回収するための手順。

**本番は変更していません。** `mss54hp-csl-convert-tuner.tsunagi.app` は今までどおり
`main` から `.github/workflows/deploy.yml` でデプロイされます。

---

## 1. なぜ GitHub Pages ではなく Cloudflare Pages なのか

理由が 2 つあり、どちらも回避できません。

| | |
|---|---|
| **Pages は 1 リポジトリに 1 サイト** | その 1 枠は本番が使っています。同じリポジトリからブランチを出すと本番を上書きします |
| **Service Worker が `/` スコープで全資産をプリキャッシュ** | 同一オリジンに 2 つのビルドを置くと、並んで存在するのではなく**1 つのキャッシュを奪い合います** |

加えて、**ログのアップロード先が要る**という要求がありました。本アプリは静的エクスポートなので
GitHub Pages には POST の着地点がありません。Cloudflare Pages Functions ＋ D1 なら
**アプリと同一オリジン**に置けます — 電波の弱いガレージで CORS プリフライトを 1 往復増やさずに済みます。

---

## 2. ローカル

```bash
npm run dev
```

`http://localhost:5054`。**`/api` は存在しません**（Next の dev サーバに Functions は無い）。
UI の確認はこれで十分です。

アップロード経路まで動かすなら Pages エミュレータを使います:

```bash
npm run build && npx wrangler pages dev --port 8788
```

`http://localhost:8788`。`out/` を配信し、`functions/` を動かし、ローカル D1 に書きます。
**Cloudflare アカウントは不要です。** 初回だけテーブルを作ります:

```bash
npm run db:migrate:local
```

トークンはリポジトリに置きません。`.dev.vars`（gitignore 済み）に:

```
UPLOAD_TOKEN=devtoken123
```

### main と並べて動かす

`main` の worktree を `../E46M3CSL_TuningTool-main` に作ってあります（依存関係もインストール済み）。
ポートを分ければ同時に上がります:

```bash
cd ../E46M3CSL_TuningTool-main && npx next dev -p 5055
```

`package.json` の `dev` は両方 5054 固定なので、`-p` を直接渡します。

---

## 3. 実機（Android）に出す

### 3.1 いますぐ試すだけなら — トンネル

アカウント不要。ローカルの dev サーバに HTTPS の URL が付きます。
**HTTPS は必須です**（WebUSB はセキュアコンテキストでしか動きません。LAN の `http://192.168.x.x` では動きません）。

```bash
npx cloudflared tunnel --url http://localhost:5054
```

出てくる `https://….trycloudflare.com` をスマホで開きます。PC を走らせている間だけ有効で、
コードを直せば即反映されるので、UX の詰めにはこれが一番速いです。

### 3.2 常設のプレビュー URL — Cloudflare Pages

**1 回だけ、あなたの操作が要る手順**（私は代行できません）:

```bash
npx wrangler login
```

その後:

```bash
npx wrangler d1 create mss54hp-tuner-runs
```

表示された `database_id` を `wrangler.jsonc` の該当欄に貼り、続けて:

```bash
npm run db:migrate:remote
npx wrangler pages project create mss54hp-tuner-preview --production-branch main
npx wrangler pages secret put UPLOAD_TOKEN --project-name mss54hp-tuner-preview
```

最後にデプロイ:

```bash
npm run deploy:preview
```

URL は `https://mss54hp-tuner-preview.pages.dev`。以降は `npm run deploy:preview` だけです。

> `database_id` を貼り忘れると、リモートデプロイは「database not found」で落ちます。
> これは意図した挙動です — 設定し忘れが**別の DB に静かに書く**より、落ちるほうが安全です。

---

## 4. 車でログを取り、回収する

1. スマホの Chrome でプレビュー URL を開く（初回は「ホーム画面に追加」推奨）
2. K+DCAN ケーブルを **USB OTG** でスマホに挿す
   — Android は WebUSB 経路に自動で切り替わります（`byteTransport.ts` の `detectTransportKind`）
3. **RUN STORE** パネル（フッターの雲アイコン）にトークンを入れて保存
   — ベース URL は空のままで構いません（同一オリジン）
4. 通常どおり BASE を読み、PATCH を当て、走ってログを取る
5. セッション行のダウンロードの隣に出る**アップロードボタン**を押す

PC 側から中身を見るには:

```bash
npm run db:runs
```

### 大きさの上限

1 ランあたり **gzip 後 879 KB**（D1 の 1 値 = 1,000,000 バイト制限の内側）。
10 Hz で 20 分のドライブが CSV 約 700 KB → gzip 約 100 KB なので、通常は遠く届きません。
超えた場合は 413 と「どれだけ超えたか」が返ります — **黙って切り詰めることはしません**。

---

## 5. 実機で最初に確かめること

`docs/ecu-logic/60-tuning-logic.md` §9 が「実車未確認」と挙げている項目は、
**1 本のログで同時に片付きます**。

1. ログ列 `RF` が `Raw RO %` と単調に相関しているか（DS2 offset 8）
2. ログ列 `EGT` がアイドルで 300–500 °C、高負荷で 700–900 °C か（DS2 offset 14）
3. **`RF KORR (EGT)` 列が `RF KORR` 列と一致するか**
   — 一致すれば offset 8 / 14・カタログのアドレス・`kf_rf_tabg_modell` の解釈が**同時に**裏付けられます
   （どちらも既定では非表示。`Log Fields` パネルで出してください）

3 が合うまで `TUNED` モードには進まないでください。合わなければ、以降はすべて砂上の楼閣です。

---

## 6. 触っていないもの

- `.github/workflows/deploy.yml` — 本番のデプロイ経路。無変更
- `public/CNAME`、`public/.well-known/assetlinks.json` — GitHub Pages とホーム画面ランチャー用。
  Cloudflare 側でも配信されますが、参照しているオリジンが違うので**何もしません**
  （TWA ランチャーは本番オリジンでのみ成立します）
