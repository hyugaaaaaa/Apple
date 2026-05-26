# relay/ — ブローカー & Macエージェント

## ファイル構成

| ファイル | 実行場所 | 説明 |
|----------|----------|------|
| `broker.js` | GCP Cloud Run | WebSocketブローカー + HTTP API + 静的ファイル配信 |
| `mac-agent.js` | Mac（常駐） | ブローカーへWS接続し、Macアプリ操作コマンドを実行 |

## ローカル開発

### ブローカー起動

```bash
cd /Users/hyuga/iphone-mac-left-controller
AGENT_TOKEN=dev-token APP_PIN=123456 DEFAULT_MAC_ID=my-mac node relay/broker.js
```

### Macエージェント起動（別ターミナル）

```bash
BROKER_WS_URL=ws://localhost:8080/ws/agent \
AGENT_TOKEN=dev-token \
DEVICE_ID=my-mac \
DEVICE_NAME="My MacBook" \
node relay/mac-agent.js
```

### ブラウザアクセス

| URL | 説明 |
|-----|------|
| `http://localhost:8080` | LP（オンボーディング） |
| `http://localhost:8080/mac-setup` | Macセットアップ |
| `http://localhost:8080/admin` | 管理画面（Mac用） |
| `http://localhost:8080/auth.html` | PIN認証（iPhone用） |
| `http://localhost:8080/controller.html` | コントローラー（iPhone用） |
| `http://localhost:8080/api/health` | 接続状況確認 |

## 環境変数

### broker.js

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PORT` | `8080` | リッスンポート |
| `AGENT_TOKEN` | `` | Macエージェント認証トークン（必須） |
| `APP_PIN` | `` | デフォルトMacのPIN（Cloud Run再起動後も維持） |
| `DEFAULT_MAC_ID` | `default-mac` | APP_PINを適用するMacのID |
| `MAC_PINS` | `` | 複数Mac用: `"macA:111111,macB:222222"` |
| `REQUIRE_PIN` | `true` | PINなしで認証を許可するか |
| `DEBUG_UI` | `false` | デバッグUI表示 |
| `SESSION_TOKEN_TTL_MS` | 12時間 | iPhoneセッション有効期限 |
| `ADMIN_SESSION_TTL_MS` | 8時間 | 管理画面セッション有効期限 |

### mac-agent.js

| 変数 | 説明 |
|------|------|
| `BROKER_WS_URL` | ブローカーのWebSocket URL（例: `wss://xxx.run.app/ws/agent`） |
| `AGENT_TOKEN` | broker.js と同じトークン（チームで共有） |
| `DEVICE_ID` | このMacの識別ID（英数字・ハイフン）。他Macと重複不可 |
| `DEVICE_NAME` | 表示名（管理画面・コントローラーに表示） |

## マルチMac構成

```
# 単一Mac（APP_PIN で固定）
APP_PIN=667938
DEFAULT_MAC_ID=hyuga-mac
AGENT_TOKEN=xxx

# 複数Mac（MAC_PINS でそれぞれPIN固定）
MAC_PINS=hyuga-mac:667938,tanaka-mac:123456,suzuki-mac:789012
AGENT_TOKEN=xxx
```

- PINはMacごとに個別（コントローラーとMacのペアリング）
- AGENT_TOKENは全Macで同じ値を共有

## Macエージェントのセットアップ（新規ユーザー向け）

リポジトリのクローン不要。ブラウザで `/mac-setup` を開き、AGENT_TOKENとMac名を入力してセットアップスクリプトをダウンロード → ターミナルで実行するだけ。

スクリプトは以下を自動実行:
1. `~/.left-controller/` ディレクトリ作成
2. `mac-agent.js` をサーバーからダウンロード
3. launchd plist を `~/Library/LaunchAgents/` に作成
4. `launchctl load` でエージェント起動（Mac起動時に自動起動）

## launchd plist（手動管理の場合）

参考: [`launchd/com.hyuga.leftcontroller.mac-agent.plist.example`](../launchd/com.hyuga.leftcontroller.mac-agent.plist.example)

```bash
# 起動
launchctl load ~/Library/LaunchAgents/com.leftcontroller.mac-agent.plist

# 停止
launchctl unload ~/Library/LaunchAgents/com.leftcontroller.mac-agent.plist

# ログ確認
tail -f ~/.left-controller/logs/mac-agent.log
```
