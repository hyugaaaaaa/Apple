# Tech Stack

## 言語・ランタイム

| 言語 | 用途 | 主なファイル |
|------|------|------------|
| JavaScript (Node.js) | ブローカーサーバー、Macエージェント | `relay/broker.js`, `relay/mac-agent.js` |
| JavaScript (ブラウザ) | 各画面のUI・WebSocket通信 | `public/*.js` |
| HTML | 各画面の構造 | `public/*.html` |
| CSS | UIスタイル | `public/style.css`, `public/controller-layout.css`, `public/controller-orientation.css` |
| Swift | macOS ウィンドウ最小化ヘルパー（AX API） | `relay/leftctl_minimize.swift` |
| AppleScript | アプリ起動などのフォールバック | `relay/mac-agent.js` 内 |
| XML (plist) | launchd 常駐設定 | `launchd/*.plist.example`, mac-setup で自動生成 |
| Shell Script (bash) | Macエージェント自動セットアップ | mac-setup.html で動的生成 |

## 画面ファイル

| ファイル | デバイス | 説明 |
|----------|----------|------|
| `public/lp-onboarding.html` | 共通 | LP・初回オンボーディング（5ステップ） |
| `public/mac-setup.html` | Mac | Macエージェントセットアップガイド |
| `public/admin.html` + `admin.js` | Mac | 管理画面（アプリ登録・PIN確認・PIN回復） |
| `public/auth.html` + `auth.js` | iPhone | PIN認証画面 |
| `public/controller.html` + `controller.js` | iPhone | コントローラー画面（タップで起動・ダブルタップで最小化） |
| `public/common.js` | 共通 | 共有ユーティリティ（WS URL、デバイスID、フロント定数） |
| `public/sw.js` | 共通 | Service Worker（オフライン対応・キャッシュ管理） |

## サーバーコンポーネント

| ファイル | 説明 |
|----------|------|
| `relay/broker.js` | Cloud Run 上のWebSocketブローカー。HTTP APIも兼ねる |
| `relay/mac-agent.js` | Mac上に常駐するエージェント。launchd で自動起動 |
| `relay/leftctl_minimize.swift` | NSWorkspace + AX API でウィンドウ最小化を実行する Swift CLI（セットアップ時に `swiftc` でコンパイルされ `~/.left-controller/leftctl-minimize` に配置） |

## 主要な npm パッケージ

| パッケージ | 用途 |
|-----------|------|
| `ws` | WebSocketサーバー（broker.js, mac-agent.js） |

## デプロイ構成

| 環境 | 説明 |
|------|------|
| GCP Cloud Run | `relay/broker.js` を `Dockerfile` でコンテナ化してデプロイ |
| Mac（launchd） | `relay/mac-agent.js` を `~/Library/LaunchAgents/` の plist で常駐 |

## 通信

```
iPhone ←→ (WebSocket / wss) ←→ Cloud Run broker.js ←→ (WebSocket /ws/agent) ←→ mac-agent.js
iPhone ←→ (HTTPS)           ←→ Cloud Run broker.js  （静的ファイル・API）
```

- iPhone ↔ ブローカー間: PIN認証 → セッショントークン（sessionStorage、有効期限12時間）
- Mac ↔ ブローカー間: AGENT_TOKEN で認証（チーム共有）
- 管理画面（Mac Safari） ↔ ブローカー間: PIN認証 → 管理セッショントークン（sessionStorage、有効期限8時間）

## セキュリティ

| 機能 | 実装 |
|------|------|
| Macエージェント認証 | `AGENT_TOKEN`（環境変数）でWS接続を認証 |
| iPhoneペアリング | 6桁PINで認証 → JWTライクなセッショントークン発行 |
| PINロック | 5回失敗で10分ロック |
| 管理画面認証 | PINで管理セッショントークンを発行（Bearerトークン） |
| パスバリデーション | `get_icon` RPCでパストラバーサル防御済み |
| Swift helper の権限 | コンパイル済みバイナリが GUI セッションで実行されるため、TCC（Accessibility）の明示的許可なしで AX API を利用可能 |

## RPC コマンド（broker → mac-agent）

| type | 説明 |
|------|------|
| `list_apps` | `/Applications` 以下のアプリ一覧 |
| `get_icon` | アプリの `.icns` を PNG 化してbase64で返却 |
| `execute_command` | コマンド実行（`open_app` / `minimize_app` のいずれか） |

`execute_command` の `action.type`:
- `open_app`: `open -a` でアプリ起動、加えて他アプリのウィンドウを `leftctl-minimize --others` で最小化
- `minimize_app`: `leftctl-minimize <path>` でそのアプリのウィンドウを最小化（osascript フォールバックあり）
