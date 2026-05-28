# iPhone Mac Left Controller

iPhoneをMacの左手デバイスとして使うPWAアプリ。  
GCP Cloud Runをリレーブローカーとして複数のMac・複数ユーザーに対応。

## アーキテクチャ

```
iPhone (PWA)
  ↕ WebSocket
GCP Cloud Run — relay/broker.js
  ↕ WebSocket (/ws/agent)
Mac local agent — relay/mac-agent.js  (launchd 常駐)
  └─ Swift helper: ~/.left-controller/leftctl-minimize  (AX API でウィンドウ最小化)
```

## 主な機能

- **アプリ起動**: アイコンをタップで Mac の対応アプリをフォアグラウンドへ
- **ウィンドウ最小化**: アイコンをダブルタップでそのアプリのウィンドウを Dock へ最小化（フルスクリーン時はアプリを Hide）
- **他アプリ最小化**: アプリ起動時、他のアクティブウィンドウを自動的に最小化
- **PIN回復**: 管理画面のログインモーダルから「PINを忘れた場合」でエージェント経由で再表示
- **エージェント version 通知**: 管理画面で古いエージェントを検知し更新を促す
- **ヘルプ**: `/help.html` に使い方・FAQ（LP からも導線あり）

## 画面遷移

**モバイル（iPhone）**
```
/ → lp-onboarding.html → auth.html → controller.html
             ↑ 2回目以降はスキップ
```

**デスクトップ（Mac）**
```
/ → lp-onboarding.html → mac-setup.html → admin.html
             ↑ 2回目以降はスキップ（セットアップ済みなら admin へ）
```

## デプロイ済み環境

| 項目 | 値 |
|------|-----|
| Cloud Run URL | `https://left-controller-relay-321557669205.asia-northeast1.run.app` |
| リージョン | `asia-northeast1` |
| プロジェクト | `loudmaster-auth` |

## Cloud Run 再デプロイ

```bash
CLOUDSDK_PYTHON=~/.local/python311/bin/python3.11 \
  gcloud run deploy left-controller-relay \
  --source . \
  --region asia-northeast1 \
  --project loudmaster-auth
```

> **注意**: macOS 同梱の Python 3.9 では gcloud が動かないため `~/.local/python311/bin/python3.11` を指定する

詳細: [`deploy/GCP_RELAY_DEPLOY.md`](deploy/GCP_RELAY_DEPLOY.md)

## 新しいMacユーザーの追加手順

1. ブラウザで `https://<run-app-url>/mac-setup` を開く（MacのSafari推奨）
2. `AGENT_TOKEN` と任意のMac名を入力
3. セットアップスクリプトをダウンロードしてターミナルで実行
4. 接続確認後、管理画面でアプリを登録

AGENT_TOKENはチームで共有する値。Cloud Run の環境変数 `AGENT_TOKEN` を参照。

## 環境変数一覧

| 変数 | 必須 | 説明 |
|------|------|------|
| `AGENT_TOKEN` | ✓ | Mac エージェント認証トークン（全Mac共有） |
| `APP_PIN` | ✓ | デフォルトMacのPIN（Cloud Run再起動後も維持） |
| `DEFAULT_MAC_ID` | | APP_PINを適用するMacのDEVICE_ID |
| `MAC_PINS` | | 複数Mac用: `"macId1:pin1,macId2:pin2"` |
| `REQUIRE_PIN` | | `false`でPIN認証無効（デフォルト: `true`） |
| `DEBUG_UI` | | `true`でデバッグUI表示（デフォルト: `false`） |
| `SESSION_TOKEN_TTL_MS` | | iPhoneセッション有効期限（デフォルト: 12時間） |
| `ADMIN_SESSION_TTL_MS` | | 管理画面セッション有効期限（デフォルト: 8時間） |
| `PIN_MAX_ATTEMPTS` | | PIN試行回数上限（デフォルト: 5） |
| `PIN_LOCK_MS` | | PINロック時間（デフォルト: 10分） |
| `K_REVISION` | | Cloud Run が自動設定。`sw.js` のキャッシュバージョンに使用（手動 bump 不要） |
| `CACHE_BUILD_ID` | | `K_REVISION` 未設定環境でのキャッシュ ID 上書き用（任意） |

### Service Worker キャッシュの自動無効化

`sw.js` の `CACHE_VERSION` はリクエスト時に broker.js が `K_REVISION`（Cloud Run のリビジョン ID）で書き換えるため、**デプロイのたびに自動でキャッシュが切り替わる**。手動でのバージョン bump は不要。`sw.js` 自体は `Cache-Control: no-store` で常に再検証される。

## API エンドポイント

| Method | パス | 用途 |
|--------|------|------|
| GET | `/api/runtime` | ランタイム情報 |
| GET | `/api/health` | エージェント生存確認＋PIN取得（PIN回復に使用） |
| GET | `/api/pairing` | ペアリング情報（PIN桁数等） |
| GET | `/api/commands` | コマンド一覧 |
| POST | `/api/admin/login` | 管理者PINログイン |
| GET | `/api/admin/state` | 管理画面状態取得（要admin token） |
| POST | `/api/admin/commands` | 登録アプリ保存（要admin token） |
| POST | `/api/admin/pin/rotate` | PIN再発行（要admin token） |
| GET | `/api/admin/icon` | アプリアイコン取得（要admin token） |
| GET | `/ws/agent` | Macエージェント用WebSocket |
| GET | `/` (WS upgrade) | iPhoneクライアント用WebSocket |

## ローカル開発

```bash
npm ci
AGENT_TOKEN=dev-token APP_PIN=123456 node relay/broker.js
```

別ターミナルでMacエージェント:
```bash
BROKER_WS_URL=ws://localhost:8080/ws/agent \
AGENT_TOKEN=dev-token \
DEVICE_ID=my-mac \
DEVICE_NAME="My MacBook" \
node relay/mac-agent.js
```

ブラウザ: `http://localhost:8080`

## テスト・Lint

```bash
npm test       # broker.js の API スモークテスト（Node 標準 node:test、11ケース）
npm run lint   # ESLint（public/ relay/）
npm run lint:fix
```

CI（`.github/workflows/ci.yml`）が push / PR 時に `npm ci → lint → node --check → test` を自動実行する。

## フロントエンド構成メモ

- `public/lp-shared.css` — LP 配色トークン（`--lp-*`）と再利用コンポーネント（`.lp-cta`, `.lp-modal-*`, `.lp-input` 等）。admin / help などで共有
- `public/common.js` — `resolveWsUrl` / `getOrCreateDeviceId` / `buildDeviceName` / `LIMITS` を集約（auth・controller・admin が読み込む）
- `public/sw.js` — Service Worker。`APP_SHELL` に静的アセットを列挙（新規ページ追加時は要更新）
