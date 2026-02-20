# AI CLI

Claude Code と Codex CLI を連携して、プラン生成→レビュー→コード生成→コードレビューを自動的に反復実行する CLI ツールです。Generator・Reviewer・Judge の 3 つのロールを独立して Claude / Codex に割り当てることで、高品質なコード生成を実現します。

## 必要な環境

- [Bun](https://bun.sh/) — ランタイム・ビルドツール
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) — Generator / Reviewer / Judge で使用
- [Codex CLI](https://github.com/openai/codex) (`codex`) — Generator / Reviewer / Judge で使用
- [Git](https://git-scm.com/) — コードレビューフェーズで差分取得に必要

## インストール

```bash
# 依存パッケージのインストール
bun install

# バイナリのビルド（dist/ai に出力）
bun run build
```

ビルド後、`dist/ai` を PATH の通ったディレクトリに配置してください。

## コマンド

```bash
ai [prompt] [options]
```

- `prompt` を指定した場合: 1 回実行（シングルショット）
- `prompt` を省略した場合: REPL モード起動

## コマンドラインオプション

`ai` で使用できるオプション一覧:

| オプション | 型 | デフォルト | 説明 |
|---|---|---|---|
| `--max-plan-iterations <n>` | number | `10` | プランレビュー最大回数 |
| `--max-code-iterations <n>` | number | `10` | コードレビュー最大回数 |
| `--claude-model <model>` | string | なし | Claude Code のモデル指定 |
| `--codex-model <model>` | string | なし | Codex のモデル指定 |
| `--codex-sandbox <mode>` | string | `workspace-write` | Codex コードレビュー時の sandbox モード |
| `--generator-cli <cli>` | string | `claude` | Generator の CLI 選択 (`claude` \| `codex`) |
| `--reviewer-cli <cli>` | string | `codex` | Reviewer の CLI 選択 (`claude` \| `codex`) |
| `--judge-cli <cli>` | string | `claude` | Judge の CLI 選択 (`claude` \| `codex`) |
| `--dangerous` | flag | `false` | Claude Code 実行時に `--dangerously-skip-permissions` を使用 |
| `--verbose` | flag | `false` | 詳細ログ出力（要約ベース）・ストリーミング有効化 |
| `--debug` | flag | `false` | 全文ログ出力（開発用、verbose も有効化） |
| `--cwd <dir>` | string | カレントディレクトリ | 作業ディレクトリ指定 |

`--codex-sandbox` の許可値:

- `read-only`
- `workspace-write`
- `danger-full-access`

## 実行例

シングルショット:

```bash
ai "ユーザーストーリーやタスクの説明"
```

REPL モード:

```bash
ai
```

オプション指定例:

```bash
ai "認証機能を追加" \
  --claude-model sonnet \
  --codex-model gpt-5-codex \
  --codex-sandbox read-only \
  --max-plan-iterations 7 \
  --max-code-iterations 6 \
  --verbose
```

CLI 選択例:

```bash
# Generator を Codex に変更（Codex でプラン生成・コード生成）
ai --generator-cli codex "テスト"

# Reviewer を Claude に変更（Claude でレビュー）
ai --reviewer-cli claude "テスト"

# 全ロールを Codex に
ai --generator-cli codex --reviewer-cli codex --judge-cli codex "テスト"
```

## ワークフロー概要

```
 ┌──────────────────────────────────────────────────────────┐
 │ 1. プラン生成   Generator がユーザーの要件から実装計画を作成   │
 │ 2. プランレビュー Reviewer が計画をレビュー                   │
 │ 3. 判定         Judge がレビュー結果の重大度を分類           │
 │    ↻ P0〜P3 の懸念 → Generator が計画を修正して 2. へ戻る   │
 │    ↓ 懸念なし or 上限到達                                  │
 │ 4. ユーザー承認  承認 / 修正指示 / 中止 を選択               │
 │    ↓ 承認                                                │
 │ 5. コード生成   Generator がコードを実装                    │
 │ 6. コードレビュー Reviewer が git diff をレビュー            │
 │ 7. 判定         Judge がレビュー結果の重大度を分類           │
 │    ↻ P0〜P3 の懸念 → Generator がコードを修正して 6. へ戻る │
 │    ↓ 懸念なし or 上限到達                                  │
 │ 8. 完了                                                   │
 └──────────────────────────────────────────────────────────┘
```

各ロールの CLI は `--generator-cli`, `--reviewer-cli`, `--judge-cli` で変更できます。
モデルは CLI に応じて `--claude-model` / `--codex-model` の値が使用されます。

### 重大度レベル

Judge はレビュー結果を以下の重大度で分類します。P0〜P3 がブロッカーとなり、修正ループが継続します。

| レベル | 分類 | 説明 |
|---|---|---|
| P0 | 致命的 | 実装不能、セキュリティ脆弱性、データ損失リスク |
| P1 | 重大 | 主要機能の不具合、重大なパフォーマンス問題 |
| P2 | 中程度 | 設計上の問題、エッジケースの未処理 |
| P3 | 軽度 | コード品質の問題、改善推奨事項 |
| P4 | 軽微 | スタイル、命名、ドキュメントの改善（ブロックしない） |

### セッション管理

Claude・Codex 両方のプロバイダはセッション ID を追跡し、プラン生成→コード生成の一連の流れでコンテキストを維持します。セッション ID の抽出に失敗した場合は、前回の出力サマリをプロンプトに含めるフォールバックが動作します。

### Diff 検出と全文リトライ

Generator がプラン修正時に差分のみを返した場合、自動検出してリトライプロンプトで全文出力を要求します。リトライでも全文が得られない場合は、最後に取得した全文プランにフォールバックします。

## REPL モード

REPL モードではインタラクティブにプロンプトを入力できます。

### キーバインド

| キー | 動作 |
|---|---|
| `Enter` | 入力を送信 |
| `Ctrl+J` / `Alt+Enter` | 改行を挿入（複数行入力） |
| `↑` / `↓` | 履歴のナビゲーション |
| `←` / `→` | カーソル移動 |
| `Ctrl+A` / `Home` | 行頭へ移動 |
| `Ctrl+E` / `End` | 行末へ移動 |
| `Ctrl+U` | カーソル位置から行頭まで削除 |
| `Ctrl+K` | カーソル位置から行末まで削除 |
| `Ctrl+C` | 入力をキャンセル |
| `Ctrl+D` | REPL を終了 |

### 履歴

- `~/.ai_cli_history` に最大 500 件の入力履歴を保存
- CJK 全角文字やブラケットペーストモードに対応

## 開発

```bash
# ソースから直接実行
bun run dev

# 型チェック
bun run build:check

# テスト実行
bun run test

# テスト（ウォッチモード）
bun run test:watch

# ビルド（dist/ai に自己完結バイナリを出力）
bun run build
```

## ライセンス

MIT