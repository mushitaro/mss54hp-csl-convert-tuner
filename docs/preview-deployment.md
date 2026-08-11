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

### 3.2 常設のプレビュー URL — Cloudflare Pages（**構築済み**）

## 🔗 https://rf-korr.mss54hp-tuner-preview.pages.dev

| | |
|---|---|
| Pages プロジェクト | `mss54hp-tuner-preview`（production branch は `main`。実配信はブランチ `rf-korr` のプレビュー） |
| D1 | `mss54hp-tuner-runs`（`af71b38c-8582-4432-be2f-054c568fa1dc`、APAC） |
| `UPLOAD_TOKEN` | production / preview 両環境に設定済み |
| **トークンの実物** | リポジトリ直下の **`.upload-token.local`**（gitignore 済み。会話にもコミットにも出していません） |

以降の更新は 1 コマンドです:

```bash
npm run deploy:preview
```

プロジェクト名と `--branch rf-korr` はスクリプトに入れてあるので、上の固定 URL が保たれます。

### アプリ名は本番と分けてあります

| | 本番 | プレビュー |
|---|---|---|
| ホーム画面のラベル | `CSL TUNER` | **`CSL PREVIEW`** |
| インストール名／タスクスイッチャ | `MSS54HP CSL CONVERT /// TUNER` | **`MSS54HP CSL PREVIEW /// TUNER`** |
| ヘッダー | — | **`PREVIEW`** バッジ（琥珀色） |

オリジンが違うので**インストールは元々別物**でしたが、ラベルが同じだと
ホーム画面にアイコンが 2 つ並んで、どちらが車と話す方か分かりません。

改名は `scripts/brand-preview.mjs` が `out/` に対して行います。`public/manifest.webmanifest` や
`layout.tsx` を直接書き換えると**本番まで改名されてしまう**ため、ビルド後パッチにしてあります。
`npm run build`（本番）は 1 バイトも変わりません。

> `build:preview` の並び順は見た目の問題ではありません。`gen-sw.mjs` は `out/` の内容の
> ハッシュから Service Worker のキャッシュ名を作るので、**改名は必ずその前**に走らせます。
> 後ろにすると、ブランディングだけが違う 2 つのデプロイが同じキャッシュ名を共有します。

#### トークンはビルドに埋め込まれます（入力不要）

`scripts/embed-sync-token.mjs` が `.upload-token.local`（または環境変数 `UPLOAD_TOKEN`）を読んで、
書き出した HTML に `<meta name="sync-token">` として入れます。**端末で入力するものは何もありません。**

> 最初の実装はトークンを手入力させていました。値は生成したきり誰にも見せていなかったので、
> **見たことのない 32 文字を入力しろ、という機能**になっていました。設計ミスです。

**この方式が引き換えに差し出すもの（はっきり書きます）**:
公開バンドルの中のトークンは、**ページを開ける人に対しては秘密ではありません**。
これが止められるのは HTML を取らずに `/api` を叩くスキャナだけで、それ以外は止められません。
このデプロイに限れば妥当な取引です — 置いてあるのは 1 台分の走行ログと、
すでに公開されている Community Patch の BIN で、URL はどこからもリンクされていません。
それでも残る効き目は、**POST と DELETE が通りすがりに開いていない**ことです。壊せる方の半分。

**本番には影響しません。** `npm run build` はこのスクリプトを呼びません
（本番は静的配信で `/api` 自体が存在しない）。プレビュー以外では同期 UI そのものが出ません。

**トークンを変えたいとき**（推奨。私が生成した値をそのまま使い続ける理由はありません）:

```bash
npx wrangler pages secret put UPLOAD_TOKEN --project-name mss54hp-tuner-preview
npx wrangler pages secret put UPLOAD_TOKEN --project-name mss54hp-tuner-preview --env preview
```

そのあと `.upload-token.local` を同じ値に書き換えて `npm run deploy:preview`。
**再デプロイまでが 1 セットです** — 古いバンドルはその時点で通らなくなります（それがローテーション）。
埋め込む値が変わると Service Worker のキャッシュ名も変わるので、端末は次回起動で新しい方を取ります。

端末側に保存されるのは「ビルドの値と違うときだけ」です（`saveSyncSettings`）。
そうしないと、ローテーションしても端末が古い値を送り続け、
**サーバーが壊れたように見える**という一番たちの悪い失敗になります。

**スキーマを更新したら**（`migrations/` に追加があったとき）:

```bash
npm run db:migrate:remote
```

---

### 3.3 デプロイ後に確認済みのこと

| 確認 | 結果 |
|---|---|
| アプリが配信されている | ✅ `RF KORR (TUNED)` タブを含めて描画 |
| Function が動いている | ✅ `/api/sessions` が JSON を返す（404 ではない） |
| `UPLOAD_TOKEN` が bind されている | ✅ **401** が返る。未設定なら 503 を返す実装なので、401 であること自体が証拠 |
| CORS プリフライト | ✅ 204 |
| リモート D1 のスキーマ | ✅ `sessions` テーブル（`0002_sessions.sql` を適用済みなら） |
| **Worker → D1 の bind** | ⏳ 認証付きリクエストが要るため未確認。**最初のアップロードが証拠**になります |

最後の 1 行だけ残しているのは、トークンをこの会話に出さないためです。
もし bind が誤っていれば、最初のアップロードが 500 と `D1_ERROR` を返します（黙って失敗はしません）。

---

## 4. 車でログを取り、回収する

1. スマホの Chrome でプレビュー URL を開き、**M メニュー → INSTALL TO DEVICE** で端末に入れる
   — インストールするとブラウザの枠が消えて画面が広がり、`useScreenWakeLock` が効き、
   Service Worker が全ビルドを持っているので**電波の無いガレージでも起動します**。
   タブのままだとそこは「ただの真っ白な画面」になります。
   ボタンが `Install — not offered by this browser` のときは、ブラウザがまだ条件を満たしていません
   （Chrome は初回訪問直後だと出さないことがあります。数十秒使ってから再度メニューを開いてください）
2. K+DCAN ケーブルを **USB OTG** でスマホに挿す
   — Android は WebUSB 経路に自動で切り替わります（`byteTransport.ts` の `detectTransportKind`）
3. 通常どおり BASE を読み、PATCH を当て、走ってログを取る
4. **M メニュー → SYNC**（RELOAD / INSTALL と同じ、スクロールしない帯にあります）

   ボタンの表示がそのまま状態です:

   | 表示 | 意味 |
   |---|---|
   | `SYNC n SESSIONS` | n 件が未アップロード。押せます |
   | `OFFLINE — n WAITING` | 電波なし。押せません。**ローカルには全部残っています** |
   | `SYNCING…` | 送信中。1 件ずつ、失敗しても次に進みます |
   | `SYNC FAILED — RETRY` | 押すと再送。同じ ID で置き換わるので二重になりません |
   | `ALL SESSIONS SYNCED` | 送るものがありません |

   セットアップは要りません（トークンはビルドが持っています）。
   1 件だけ送りたいときは、従来どおりセッション行の同期アイコンからどうぞ。

保存されるのは**ローカル DB が持っているそのまま**です — セッション記録・ログ・BASE/TUNED の BIN。
CSV に詰め替えたりしません。だから **PC 側で「取り込む」を押せば丸ごと戻ります**：スマホで取って
PC で仕上げる、が成立します。CSV だけを送っていた頃は、戻ってくるのがログだけで、
それを取った BASE もチューンもフィルタ設定も失われていました。

取り込みは **SESSIONS タブ → STORE**（`NEW SESSION` の隣）から。
以前はフッターのグラフ操作の列に無地の雲アイコンとして置いていました
— チャートの操作が並ぶ行に、サーバーの設定を開く名無しのアイコン。
何のボタンか分からないと言われて当然の置き方でした。今はセッション一覧の見出しにいて、名前があります。

**未アップロードの判定は、送った時刻ではなく「何を送ったか」で持っています**（`syncedFingerprint`）。
時刻だけだと、一度送ったあとに走ったログが「もう送ってある」と見なされます。

PC 側から中身を見るには:

```bash
npm run db:sessions
```

### 大きさの上限

**パートごとに** gzip 後 879 KB（D1 の 1 値 = 1,000,000 バイト制限の内側）。
セッション記録・ログ・BIN が別カラムなので、長いドライブが BIN と枠を取り合いません。
実測：4000 点のログ＋64 KB の BIN 2 本＝生 890 KB が **gzip 後 27 KB**。通常は遠く届きません。
超えた場合は 413 と「**どのパートが**どれだけ超えたか」が返ります — 黙って切り詰めることはしません。

### なぜ API が要るのか

ブラウザは HTTP リクエスト以外の方法でサーバーに書けないので、エンドポイントは必ず要ります。
ただしそれが API の仕事の全部で、それ以上のことはさせていません — 独自のデータモデルを作らず、
IndexedDB の 3 ストアをそのまま置くだけです。

---

## 4.5 車を出す前に — PRACTICE で RF KORR を確認する

ケーブルも車も要りません。`PRACTICE` を入れて `CONNECTION → READ → START TUNE`。

シミュレータは **CSL 0401 Community Patch v1 のパーシャル**（`public/mock/` に同梱）を配信し、
**その BIN のテーブルから**テレメトリを作ります:

```
rf_soll = kf_rf_soll(rpm, aq_rel_rf)          ← 読み込んだバイトから
rf_korr = KF_RF_KORR_DRREL(rpm, tabg_delta)   ← 読み込んだバイトから
RF      = rf_soll × rf_korr                    ← DME が出す値
```

走行は「オーバーランで排気を冷やす → 負荷をかけて保持」の繰り返し。負荷をかけた瞬間はモデル温度が
飛び上がり実測 TABG が追いつかないので `tabg_delta` が大きく、保持するうちに 0 へ落ちていきます
— **これは仕込んだスイープではなく、この補正が存在する理由そのもの**です。1 回の引きで Δ の全域と、
その終わりに逆算が要求する「排気が温まったアンカー」の両方が取れます。

**答えは分かっています**（意図的に仕込んであります）:

| 仕込み | 値 | 正しく動けば |
|---|---|---|
| Alpha-N テーブルの誤差 | 1.5〜8 % 低い | VE 補正がその範囲に収束 |
| 真の密度効果 | 表の主張の **75 %** | `RF KORR (TUNED)` が表を 75 % 側へ下げる（1 回の上限 −0.05 なので数周かかります） |

| 経過 | 目安 |
|---|---|
| 約 75 秒 | 3 セル更新（`PROVISIONAL` は外れる） |
| 1 周 223 秒 | 22 セル更新、実測 `rf_korr` は 1.000〜1.258 |

`Log Fields` で `EGT (RF KORR)` と `RF KORR (EGT)` を出せば、交差検証列もここで見られます。

> PRACTICE が出すのは **PATCH ON の負荷経路**（`RF = rf_soll × rf_korr`）です。
> MAP 補正分（`rf_p_saug_i`、±2.5 %RF）はモデル化していません。

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
