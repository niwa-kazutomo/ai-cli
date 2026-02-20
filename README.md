# AI CLI

Claude Code と Codex CLI を連携して、プラン生成→レビュー→コード生成→コードレビューを実行する CLI ツールです。

## コマンド

本ツールの実行コマンドは `plan` のみです。

```bash
ai plan [prompt] [options]
```

- `prompt` を指定した場合: 1 回実行（シングルショット）
- `prompt` を省略した場合: REPL モード起動
- `ai` / `ai --verbose` のように `plan` を省略した場合も `plan` コマンドとして扱われます

## コマンドラインオプション

`ai plan` で使用できるオプション一覧:

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
| `--verbose` | flag | `false` | 詳細ログ出力（要約ベース） |
| `--debug` | flag | `false` | 全文ログ出力（開発用） |
| `--cwd <dir>` | string | カレントディレクトリ | 作業ディレクトリ指定 |

`--codex-sandbox` の許可値:

- `read-only`
- `workspace-write`
- `danger-full-access`

補足:

- `--debug` を指定するとログレベルは debug になります（verbose も有効化）
- `--codex-sandbox` に不正値を指定するとエラー終了します

## 実行例

シングルショット:

```bash
ai plan "ユーザーストーリーやタスクの説明"
```

REPL モード:

```bash
ai plan
```

オプション指定例:

```bash
ai plan "認証機能を追加" \
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
ai plan --generator-cli codex "テスト"

# Reviewer を Claude に変更（Claude でレビュー）
ai plan --reviewer-cli claude "テスト"

# 全ロールを Codex に
ai plan --generator-cli codex --reviewer-cli codex --judge-cli codex "テスト"
```

## ワークフロー概要

1. Generator（デフォルト: Claude Code）が実装プランを生成
2. Reviewer（デフォルト: Codex）がプランをレビュー
3. 必要に応じてプラン修正と再レビューを反復
4. ユーザー承認後に Generator がコード生成
5. Git 差分を Reviewer がレビュー
6. 必要に応じてコード修正と再レビューを反復

各ロールの CLI は `--generator-cli`, `--reviewer-cli`, `--judge-cli` で変更できます。
モデルは CLI に応じて `--claude-model` / `--codex-model` の値が使用されます。
