# KAIZEN-kun

Slack ⇄ Notion の橋渡しをする Vercel プロジェクト（`kaizen-kun`）。
KAIZEN君の思考ロジックは Notion の[運用仕様書](https://app.notion.com/p/3b8d761688188102b068d4c1fea58e62)側にあり、
このリポジトリは **イベントの受け口だけ** を持つ。

## 構成

```
Slack Events API (message.channels)
        ↓
/api/slack-events  (Vercel Edge Function)
        ├─ 署名検証 → チャンネル判定 (#0-神喝 C04AATNK55G)
        ├─ [relay]  スレッド返信 / @メンション → KAIZEN君ルーチンの API トリガーを fire
        └─ [image]  画像添付 → Slackからダウンロード → Notion File Upload
                    → 日次KAIZEN DB の当日ページに画像ブロックを追加 → ✅ リアクション
```

### 画像埋め込みの流れ

1. `message` イベントに `files[]`（`mimetype` が `image/*`）が含まれるものだけ処理する
2. `url_private_download` を `Authorization: Bearer $SLACK_BOT_TOKEN` 付きでダウンロード
3. 投稿時刻 `ts` を **JST** の暦日に変換し、日次KAIZEN DB（data source `bb7d697a-…`）を `日付` で検索
   - 該当ページが無ければ **何もせずログだけ残す**（ページ作成は毎時ルーチンの責務）
4. Notion File Upload API（`/v1/file_uploads` → `upload_url` へ multipart POST）でアップロード
5. `写真` / `画像` を含む見出し（例：`### 今日の写真`）を探し、そのセクション末尾に画像ブロックを挿入。
   見つからなければページ末尾に追加
6. 成功したら元の投稿に ✅（`white_check_mark`）を付けるだけ。
   **返信は送らない** — KAIZEN君Webhookとの二重投稿になるため
7. 失敗は Vercel のランタイムログに理由を出す。Slackへの通知はしない

Slack の 3 秒 ACK に収まらないので、画像処理は `waitUntil` でレスポンス後に走らせる。
Slack のリトライ（`x-slack-retry-num`）は二重アップロード防止のため無視する。

## 環境変数（Vercel プロジェクト `kaizen-kun`）

| 変数 | 用途 | 状態 |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | Slack リクエストの署名検証 | 既存 |
| `ROUTINE_FIRE_URL` | `https://api.anthropic.com/v1/claude_code/routines/<trig_id>/fire` | 既存 |
| `ROUTINE_TOKEN` | 上記 API トリガーの Bearer トークン | 既存 |
| `SLACK_CHANNEL_ID` | 処理対象チャンネル（未設定なら `C04AATNK55G`） | 既存・任意 |
| `SLACK_BOT_TOKEN` | `xoxb-…`。スコープ **`files:read`** と **`reactions:write`** が必要 | **画像機能に必要** |
| `NOTION_API_KEY` | Notion インテグレーショントークン。日次KAIZEN DB に接続共有しておくこと | **画像機能に必要** |
| `KAIZEN_DAILY_DATA_SOURCE_ID` | 日次KAIZEN data source の上書き（未設定なら `bb7d697a-…`） | 任意 |
| `SLACK_BOT_USER_ID` | メンション判定用。未設定なら `U0BNWNXV5R9`（@KAIZEN-Kun）を使う | 任意 |

`SLACK_BOT_TOKEN` / `NOTION_API_KEY` が未設定の場合、画像処理はログを残してスキップし、
既存のリレー動作はそのまま継続する。

設定状況の確認（値は返さず、設定済みかどうかの真偽値だけ）:

```bash
curl -s https://kaizen-kun.vercel.app/api/slack-events?diag=1
```

## Slack App 側の設定

- Event Subscriptions Request URL: `https://kaizen-kun.vercel.app/api/slack-events`
- Subscribe to bot events: `message.channels`
- Bot Token Scopes: `channels:history` / `files:read` / `reactions:write`
- スコープを追加したら **Reinstall** すること（トークンが変わる）
