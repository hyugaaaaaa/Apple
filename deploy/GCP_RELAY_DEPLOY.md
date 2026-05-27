# GCP Cloud Run デプロイ手順

## 前提

- `gcloud` CLI インストール済み
- macOS 同梱 Python 3.9 では gcloud が動かないため、Python 3.11 を使用する

```bash
# Python 3.11 の場所を確認
ls ~/.local/python311/bin/python3.11

# gcloud コマンドのプレフィックス（以下すべてのコマンドで使用）
export GCLOUD="CLOUDSDK_PYTHON=~/.local/python311/bin/python3.11 /Users/hyuga/google-cloud-sdk/bin/gcloud"
```

## 初回デプロイ

```bash
CLOUDSDK_PYTHON=~/.local/python311/bin/python3.11 \
  /Users/hyuga/google-cloud-sdk/bin/gcloud run deploy left-controller-relay \
  --source . \
  --region asia-northeast1 \
  --project loudmaster-auth \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --set-env-vars "AGENT_TOKEN=<トークン>,APP_PIN=<PIN>,DEFAULT_MAC_ID=<macId>,REQUIRE_PIN=true,DEBUG_UI=false,NODE_ENV=production"
```

> `--min-instances 1 --max-instances 1`: 複数インスタンス起動時のセッション分断を防ぐため固定

## 再デプロイ（コード更新時）

```bash
CLOUDSDK_PYTHON=~/.local/python311/bin/python3.11 \
  /Users/hyuga/google-cloud-sdk/bin/gcloud run deploy left-controller-relay \
  --source . \
  --region asia-northeast1 \
  --project loudmaster-auth
```

環境変数は前回の設定が引き継がれる。

## 環境変数の更新

```bash
CLOUDSDK_PYTHON=~/.local/python311/bin/python3.11 \
  /Users/hyuga/google-cloud-sdk/bin/gcloud run services update left-controller-relay \
  --region asia-northeast1 \
  --project loudmaster-auth \
  --update-env-vars "KEY=VALUE"
```

### AGENT_TOKEN を変更する場合

```bash
# 1. Cloud Run の環境変数を更新
gcloud run services update left-controller-relay \
  --update-env-vars "AGENT_TOKEN=新しいトークン"

# 2. 各Macユーザーに mac-setup ページで再セットアップを依頼
#    https://<run-app-url>/mac-setup
```

### 複数Macを追加する場合（MAC_PINS）

```bash
gcloud run services update left-controller-relay \
  --update-env-vars "MAC_PINS=macA:111111,macB:222222,macC:333333"
```

## 現在の設定確認

```bash
CLOUDSDK_PYTHON=~/.local/python311/bin/python3.11 \
  /Users/hyuga/google-cloud-sdk/bin/gcloud run services describe left-controller-relay \
  --region asia-northeast1 \
  --project loudmaster-auth \
  --format="value(spec.template.spec.containers[0].env)"
```

## デプロイ済み環境

| 項目 | 値 |
|------|-----|
| Service URL | `https://left-controller-relay-321557669205.asia-northeast1.run.app` |
| リージョン | `asia-northeast1` |
| プロジェクト | `loudmaster-auth` |
| プロジェクト番号 | `321557669205` |

## 動作確認

```bash
# ヘルスチェック
curl https://left-controller-relay-321557669205.asia-northeast1.run.app/api/health

# 接続済みMac一覧
curl https://left-controller-relay-321557669205.asia-northeast1.run.app/api/health | jq .agentsOnline
```

## 注意事項

- **セッション**: `adminSessions` / `sessions` はインメモリのため、Cloud Run 再起動で消える。ユーザーは再ログインが必要
- **PIN永続化**: `APP_PIN` / `MAC_PINS` 環境変数でシードされるため、再起動後もPINは維持される
- **relay-state.json**: Cloud Run のファイルシステムは揮発するため、再起動でアプリ設定（selectedSlots）がリセットされる。本番運用ではFirestore等に移行推奨
