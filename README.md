# KouSen式 配信サーバー（Cloudflare Workers）

`kousen_site` を **アプリからだけ・購読者だけ** が開けるように配信するサーバーです。
GitHub に push すると自動で反映されるので、「Web を直すだけでアプリの中身が変わる」運用はそのまま続けられます。

```
アプリ ──① App User ID──▶ サーバー ──②購読中？──▶ RevenueCat
アプリ ◀─③入場券（24時間）─ サーバー
WebView ─④入場券つきで開く─▶ サーバー ─ Cookie を発行 ─▶ 以降のページ・画像・動画はすべて Cookie を確認して配信
ブラウザで直接開く ─────────▶ サーバー ─▶ 403「アプリ専用ページです」
```

- 入場券は改ざんできない署名付き（HMAC-SHA256）。期限は最長24時間で、購読の期限を超えません
- Cookie は HttpOnly（ページの JS からも読めない）
- 検索エンジンにも載らないよう `noindex` を付けています
- オフライン時は、端末内のキャッシュ（Web 側の Service Worker）で遊べます

---

## 1. ファイルを Web のリポジトリに置く

`education_game_kousen` リポジトリの一番上（`kousen_site` と同じ階層）に、次をコピーします。

```
education_game_kousen/
├─ kousen_site/            ← いまの Web アプリ（そのまま）
│   └─ .assetsignore        ← kousen_site.assetsignore をこの名前でコピー
├─ worker/
│   ├─ index.js             ← サーバー本体
│   └─ index.test.js        ← テスト（node --test worker/index.test.js）
├─ wrangler.jsonc           ← サーバー設定
└─ package.json
```

コミットして push してください。

## 2. GitHub の公開をやめる

**ここを閉じないと、GitHub 上でファイルが誰でも見られます。**

1. GitHub のリポジトリ → **Settings → Pages** → 公開を止める（Unpublish / Source を None）
2. **Settings → General → Danger Zone → Change visibility → Make private**

> Cloudflare は非公開リポジトリからも自動デプロイできます。
> すでにブラウザで遊んでいた端末には、古いキャッシュが残る場合があります（新しい内容は届きません）。

## 3. Cloudflare にデプロイ

1. https://dash.cloudflare.com でアカウント作成（無料）
2. **Workers & Pages → 作成 → Import a repository（リポジトリをインポート）** → GitHub と連携し `education_game_kousen` を選択
3. 設定はそのまま（デプロイコマンド `npx wrangler deploy`）でデプロイ
4. 表示された URL（例: `https://kousen.xxxx.workers.dev`）を控える
   → アプリの `src/config.ts` の `webUrl` に設定（末尾に `/`）

以後、`main` ブランチに push するたびに自動で反映されます。

## 4. シークレットを登録

Cloudflare の Worker 画面 → **Settings → Variables and Secrets → Add** で、種類を **Secret** にして2つ登録します。

| 名前 | 値 |
| --- | --- |
| `SESSION_SECRET` | ランダムな文字列（48文字程度）。下のコマンドで作れます |
| `RC_SECRET_KEY` | RevenueCat の **Secret API key**（下記） |

PowerShell でランダム文字列を作る:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | % {[char]$_})
```

RevenueCat の Secret API key の作り方:
RevenueCat → **API keys → New secret API key** → 名前「kousen-server」、API version は **V1** → 作成して表示されたキー（`sk_` で始まる）を貼り付け。
**このキーはアプリや GitHub には絶対に入れないでください。**

## 5. 動作確認

- ブラウザで Worker の URL を開く → 「KouSen式アプリ専用ページです」と出れば OK
- アプリ（開発ビルド）でトライアル開始 → ゲームが表示されれば OK

## 6. テスト購入（Sandbox）の扱い

`wrangler.jsonc` の `ALLOW_SANDBOX` は **`"true"` のままがおすすめ**です。

- Apple の審査・TestFlight・開発ビルドはサンドボックス（テスト購入）を使うため、`"false"` だと審査員がゲームを開けずリジェクトされます
- サンドボックス購入は一般の App Store / Google Play 版からはできないので、一般ユーザーの抜け道にはなりません
- さらに絞りたい場合は、RevenueCat の **Sandbox access（許可リスト）** で、テスト購入できる人を限定してください

## 料金の目安

- 無料プラン: 1日 10万リクエストまで
- アプリは初回起動時に、オフライン用に約800ファイルをまとめて読み込みます（Web 側 `sw.js` の VERSION を上げたときも同じ）。
  **1日に新しい端末が100台を超えそうになったら、Workers Paid（月 $5・1,000万リクエスト）に切り替えてください。**

## 設定一覧（wrangler.jsonc / Secrets）

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `SESSION_SECRET` | Secret | 入場券の署名用（32文字以上） |
| `RC_SECRET_KEY` | Secret | RevenueCat Secret API key（V1） |
| `RC_ENTITLEMENT_ID` | var | `acepocket_pro` |
| `ALLOW_SANDBOX` | var | テスト購入（Test Store / Sandbox）での購読を許可するか。通常 `"true"` |
| `APP_CLIENT_KEY` | var | アプリからのリクエストに必須のヘッダー値 |
| `SESSION_TTL_SECONDS` | var | 入場券の最長有効期間（既定 86400 = 24時間） |

## セキュリティの範囲

- ✅ ブラウザで URL を直接開いても見られない
- ✅ 購読していない／期限切れの人は見られない（サーバーが毎回 RevenueCat に確認）
- ✅ 入場券の偽造・改ざん・期限切れは拒否
- ⚠ 購読中の人が、自分の端末から Cookie を抜き出して他の端末で使うことは、最長24時間までは防げません。
  さらに厳しくするには、端末が正規アプリか証明する仕組み（App Attest / Play Integrity）を追加します。
