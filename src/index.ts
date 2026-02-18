import { Command } from "commander";
import { runWorkflow } from "./orchestrator.js";
import { startRepl } from "./repl.js";
import { configureLogger } from "./logger.js";
import { SigintError } from "./errors.js";
import {
  DEFAULT_MAX_PLAN_ITERATIONS,
  DEFAULT_MAX_CODE_ITERATIONS,
} from "./constants.js";
import type { ReplOptions } from "./types.js";

const VERSION = "0.1.0";

function buildWorkflowOptions(opts: Record<string, unknown>): ReplOptions {
  return {
    maxPlanIterations: parseInt(String(opts.maxPlanIterations), 10),
    maxCodeIterations: parseInt(String(opts.maxCodeIterations), 10),
    claudeModel: opts.claudeModel as string | undefined,
    codexModel: opts.codexModel as string | undefined,
    dangerous: Boolean(opts.dangerous),
    verbose: Boolean(opts.verbose),
    debug: Boolean(opts.debug),
    cwd: String(opts.cwd),
  };
}

function setupLogger(opts: Record<string, unknown>): void {
  configureLogger({
    verbose: Boolean(opts.verbose) || Boolean(opts.debug),
    debug: Boolean(opts.debug),
  });
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("ai")
    .description(
      "Claude Code と Codex を連携し、高品質なコード生成を実現する CLI ツール",
    )
    .version(VERSION);

  // plan コマンド（isDefault: true で ai / ai --verbose 等もここにルーティング）
  program
    .command("plan", { isDefault: true })
    .description("プロンプトに基づいてプラン生成・レビュー・コード生成を実行する")
    .argument(
      "[prompt]",
      "実装内容を記述したプロンプト（省略時はインタラクティブモード）",
    )
    .option(
      "--max-plan-iterations <n>",
      "プランレビュー最大回数",
      String(DEFAULT_MAX_PLAN_ITERATIONS),
    )
    .option(
      "--max-code-iterations <n>",
      "コードレビュー最大回数",
      String(DEFAULT_MAX_CODE_ITERATIONS),
    )
    .option("--claude-model <model>", "Claude Code のモデル指定")
    .option("--codex-model <model>", "Codex のモデル指定")
    .option(
      "--dangerous",
      "コード生成時に --dangerously-skip-permissions を使用",
    )
    .option("--verbose", "詳細ログ出力（内容は切り詰め）")
    .option("--debug", "全文ログ出力（開発用）")
    .option("--cwd <dir>", "作業ディレクトリ指定", process.cwd())
    .action(async (prompt: string | undefined, opts) => {
      setupLogger(opts);

      if (prompt) {
        // シングルショット
        try {
          await runWorkflow({ prompt, ...buildWorkflowOptions(opts) });
        } catch (err) {
          if (err instanceof SigintError) {
            process.exit(130);
          }
          process.stderr.write(
            `\n❌ エラーが発生しました: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
      } else {
        // REPL
        await startRepl(buildWorkflowOptions(opts), VERSION);
      }
    });

  return program;
}
