# 移行検討の記録（2026-08-10）

Cowork版 KAIZEN君の移行先を検討・実装した際の経緯と判断の記録。

## 検討した3案

| | Cowork（旧） | Vercel + Anthropic API | **Claude Code Routine（採用）** |
|---|---|---|---|
| ボット名義通知（Webhook） | ❌ ネットワーク制限で不可 | ✅ | ✅（環境のネットワーク許可が必要） |
| 費用 | プラン内 | API従量課金 + Vercel Pro | **プラン内（追加費用なし）** |
| 実装コスト | — | 大（TypeScript実装一式） | 小（プロンプト+Routine設定のみ） |
| 仕様書駆動の維持 | ✅ | ✅（実装次第） | ✅（Notion MCPで毎回読む） |
| MCP利用 | ✅ | ❌（素のAPIを自前実装） | ✅ |

## 経緯

1. **Vercel案で詳細設計まで完了**: `@anthropic-ai/sdk` の Tool Runner でエージェントループ、`run_subagent` カスタムツールでサブエージェント（Sonnet 5 / Haiku 4.5）、Notion/Slack素API実装、Vercel Cron（Proプラン）、という構成。Claude Agent SDKはCLIサブプロセス型でサーバーレス不向きと判断。
2. **API従量課金を避けたいという要望で方針転換** → Claude CodeのRoutine（スケジュール実行）へ。
3. **Routine実装時に判明した制約**:
   - セッション/API経由で作成したRoutineには**MCPコネクタを付与できない**（組織制限）→ 起動されたセッションがNotion/Slackを使えず機能しない
   - モデル指定もAPI経由では変更不可（`model_update_disabled`）
   - 対処: **Routines UIからユーザー自身が作成**（コネクタ・モデルを付与できる）
4. **環境のegressポリシーで `hooks.slack.com` がブロック**されていることを確認（CONNECT 403）→ ユーザーが環境設定で許可する必要あり。Notion/Slack MCPはクラウド側で動くため影響なし。

## 採用構成のポイント

- 起動プロンプトは `kaizen_prompt.md`（本リポジトリ）がマスター。Routines UIに貼り付けて使う
- Webhook URLは秘密情報のためリポジトリにはプレースホルダのみ（実URLは引き継ぎ書）
- オーダーメイド返信の担保: 投稿前に日次/週次ページ・Slack直近会話・言葉DB・目標OS/行動原則OSを必ず読む旨をプロンプトに明記
- サブエージェント: 読み取り系の収集をTask/Exploreエージェントに委譲（書き込み・投稿はメインのみ）
- モデル: Claude Sonnet 5（Routines UIで指定）

## 切り戻し / 代替案

- ネットワーク許可が下りない場合: 通知問題が未解決に戻るため、Vercel + API案（本記録の設計参照）を再検討
- Vercel案の詳細設計はこのリポジトリのgit履歴とセッション記録に残っている（必要なら再着手可能）

## 移行完了チェックリスト

- [ ] 環境ネットワークで `hooks.slack.com` 許可
- [ ] Routines UIでRoutine作成（毎時・新規セッション・Sonnet 5・Notion/Slack/Googleカレンダー）
- [ ] 初回実行でWebhook通知が鳴ることを確認
- [ ] 実施ログDBへの記録を確認
- [ ] **Cowork版スケジュールタスクを無効化**
