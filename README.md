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
```

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
