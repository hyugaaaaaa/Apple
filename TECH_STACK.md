# Tech Stack / 使用言語まとめ

このプロジェクト（iPhone Left Controller）で現在使っている言語・フォーマットは以下です。

## 1. JavaScript (Node.js / ブラウザ)
- 用途:
  - サーバー実装（WebSocket, HTTP配信, コマンド実行, 認証, 監査ログ）
  - クライアント実装（PWA UI, WebSocketクライアント, 再接続, PIN認証UI）
  - Service Worker（オフライン対応 / Network First）
- 主なファイル:
  - `server.js`
  - `public/app.js`
  - `public/sw.js`

## 2. HTML
- 用途:
  - iPhone向けPWA画面構造（ボタン、デバッグ表示、PIN入力）
- 主なファイル:
  - `public/index.html`

## 3. CSS
- 用途:
  - iPhone向けUIスタイル（グリッド、状態表示、長押し視覚フィードバック）
- 主なファイル:
  - `public/style.css`

## 4. JSON
- 用途:
  - コマンド定義（ボタン内容、危険フラグ、実行アクション）
  - PWAマニフェスト
  - npmメタデータ
- 主なファイル:
  - `commands.json`
  - `public/manifest.json`
  - `package.json`
  - `package-lock.json`

## 5. AppleScript（埋め込み文字列として使用）
- 用途:
  - macOSアプリ制御（前面化、他アプリ非表示、Mission Control、ウィンドウ操作）
- 実装場所:
  - `server.js` 内の `runAppleScript(...)` 呼び出し文字列

## 6. Shell Script (bash)
- 用途:
  - 証明書生成
  - launchd サービスのインストール / 停止 / 状態確認
- 主なファイル:
  - `scripts/gen-cert.sh`
  - `scripts/service-install.sh`
  - `scripts/service-stop.sh`
  - `scripts/service-status.sh`

## 7. XML (plist)
- 用途:
  - launchd 常駐設定（自動起動・環境変数・ログ出力先）
- 主なファイル:
  - `launchd/com.hyuga.leftcontroller.plist`

## 8. ログフォーマット
- 監査ログは JSON Lines 形式（1行1JSON）
- 主なファイル:
  - `logs/audit.log`
  - `logs/server.log`

## 補足
- 現在のランタイム基盤は Node.js。
- 通信は WebSocket (`ws` パッケージ) を使用。
- PWAとして iPhone Safari から操作する構成。
